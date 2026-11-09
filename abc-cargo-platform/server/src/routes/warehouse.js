// Warehouse IN / OUT scanning with idempotent, offline-friendly batch sync.
import { Router } from 'express';
import { z } from 'zod';
import { audit } from '../db.js';
import { requireRole } from '../lib/auth.js';
import { setStatus, addEvent, STATUS_LABEL } from '../lib/shipments.js';
import { validate, badRequest, normalizeAwb } from '../lib/util.js';
import { addToManifest } from './international.js';

const r = Router();
r.use(requireRole('ADMIN', 'OPS', 'WAREHOUSE'));

const scanInput = z.object({
  awb: z.string().trim().min(5).max(40),
  direction: z.enum(['IN', 'OUT']),
  branch_id: z.coerce.number().int().positive().optional(),
  bin: z.string().trim().max(20).optional().nullable(),
  purpose: z.enum(['MANIFEST', 'DELIVERY', 'TRANSFER', 'RETURN']).optional(),
  manifest_id: z.coerce.number().int().positive().optional().nullable(),
  driver_id: z.coerce.number().int().positive().optional().nullable(),
  to_branch_id: z.coerce.number().int().positive().optional().nullable(),
  client_ref: z.string().trim().max(64).optional(),
  scanned_at: z.string().datetime().optional(),
});

function summary(s) {
  return s && {
    id: s.id, awb: s.awb, status: s.status, status_label: STATUS_LABEL[s.status], shipment_type: s.shipment_type,
    dest_country: s.dest_country, customs_status: s.customs_status, manifest_id: s.manifest_id,
    consignee_name: s.consignee_name, dest_city: s.dest_city, pieces: s.pieces, bin: s.bin,
    cod_amount: s.cod_amount, driver_id: s.driver_id,
  };
}

/** Executes one scan. Never throws for business-rule failures: returns {result:'EXCEPTION', message}. */
export function processScan(db, req, input) {
  return db.tx(() => {
    if (input.client_ref) {
      const prior = db.get('SELECT * FROM warehouse_scans WHERE client_ref = ?', input.client_ref);
      if (prior) {
        const s = prior.shipment_id ? db.get('SELECT * FROM shipments WHERE id = ?', prior.shipment_id) : null;
        return { result: prior.result, message: prior.message, duplicate: true, shipment: summary(s) };
      }
    }
    const branchId = input.branch_id || req.user.branch_id;
    const branch = branchId && db.get('SELECT * FROM branches WHERE id = ? AND active = 1', branchId);
    if (!branch) throw badRequest('Select a valid warehouse/branch');
    if (req.entity && branch.entity_code !== req.entity) throw badRequest('Branch is in another region');
    const awb = normalizeAwb(input.awb);
    const s = db.get('SELECT * FROM shipments WHERE awb = ?', awb);
    const scannedAt = input.scanned_at || new Date().toISOString();

    let result = 'OK';
    let message;
    let purpose = input.direction === 'OUT' ? (input.purpose || 'DELIVERY') : null;

    if (!s) {
      result = 'EXCEPTION'; message = 'Unknown AWB — not in system';
    } else if (s.entity_code !== branch.entity_code) {
      result = 'EXCEPTION'; message = `Shipment belongs to region ${s.entity_code}`;
    } else if (['DELIVERED', 'CANCELLED', 'RETURNED'].includes(s.status)) {
      result = 'EXCEPTION'; message = `Shipment is ${STATUS_LABEL[s.status]}`;
    } else if (input.direction === 'IN') {
      if (s.status === 'IN_WAREHOUSE' && s.branch_id === branch.id) {
        result = 'WARNING'; message = 'Already in this warehouse';
        if (input.bin && input.bin !== s.bin) {
          db.run("UPDATE shipments SET bin = ?, updated_at = datetime('now') WHERE id = ?", input.bin, s.id);
          message += ` — moved to bin ${input.bin}`;
        }
      } else {
        const wasFailed = s.status === 'DELIVERY_FAILED';
        setStatus(db, s.id, 'IN_WAREHOUSE', { branch_id: branch.id, bin: input.bin || null, driver_id: null });
        addEvent(db, s.id, 'IN_WAREHOUSE', {
          location: `${branch.name}, ${branch.city}`,
          note: wasFailed ? 'Returned to warehouse after delivery attempt' : 'Received at warehouse',
          userId: req.user.id,
        });
        message = `Received${input.bin ? ` · bin ${input.bin}` : ''}`;
      }
    } else { // OUT
      if (s.status !== 'IN_WAREHOUSE' || s.branch_id !== branch.id) {
        result = 'EXCEPTION'; message = `Not in stock at ${branch.code} (status: ${STATUS_LABEL[s.status]})`;
      } else if (purpose === 'MANIFEST') {
        // International export: consolidate into an air manifest (MAWB).
        try {
          if (!input.manifest_id) throw new Error('Select an open air manifest');
          const r2 = addToManifest(db, req, input.manifest_id, awb);
          message = r2.already ? 'Already on this manifest' : `Manifested → ${s.dest_country}`;
          if (r2.already) result = 'WARNING';
        } catch (e) { result = 'EXCEPTION'; message = e.message; }
      } else if (s.shipment_type === 'INTERNATIONAL' && purpose === 'DELIVERY') {
        result = 'EXCEPTION'; message = `International (${s.dest_country}) — scan into an air manifest, not local delivery`;
      } else if (purpose === 'DELIVERY') {
        const driverId = input.driver_id || s.driver_id;
        const driver = driverId && db.get("SELECT id, name FROM users WHERE id = ? AND role = 'DRIVER' AND active = 1", driverId);
        if (!driver) {
          result = 'EXCEPTION'; message = 'No delivery driver assigned — select a driver';
        } else {
          setStatus(db, s.id, 'OUT_FOR_DELIVERY', { driver_id: driver.id, bin: null });
          addEvent(db, s.id, 'OUT_FOR_DELIVERY', { location: s.dest_city, note: 'Out for delivery with courier', userId: req.user.id });
          message = `Dispatched with ${driver.name}`;
        }
      } else if (purpose === 'TRANSFER') {
        const to = input.to_branch_id && db.get('SELECT * FROM branches WHERE id = ? AND active = 1', input.to_branch_id);
        if (!to || to.id === branch.id) {
          result = 'EXCEPTION'; message = 'Select a different destination branch';
        } else {
          setStatus(db, s.id, 'IN_TRANSIT', { branch_id: to.id, bin: null, driver_id: null });
          addEvent(db, s.id, 'IN_TRANSIT', { location: branch.city, note: `Departed ${branch.city} hub to ${to.city}`, userId: req.user.id });
          message = `Transfer to ${to.code}`;
        }
      } else { // RETURN
        setStatus(db, s.id, 'RETURNED', { bin: null, driver_id: null });
        addEvent(db, s.id, 'RETURNED', { location: branch.city, note: 'Returned to shipper', userId: req.user.id });
        message = 'Returned to shipper';
      }
    }

    db.run(
      `INSERT INTO warehouse_scans (client_ref, shipment_id, awb, branch_id, direction, purpose, bin, result, message, user_id, scanned_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.client_ref ?? null, s?.id ?? null, awb, branch.id, input.direction, purpose, input.bin ?? null,
      result, message, req.user.id, scannedAt,
    );
    if (result !== 'OK') audit(db, req, 'scan.exception', 'shipment', awb, { direction: input.direction, message });
    const fresh = s ? db.get('SELECT * FROM shipments WHERE id = ?', s.id) : null;
    return { result, message, shipment: summary(fresh) };
  });
}

r.post('/scan', validate(scanInput), (req, res) => {
  res.json(processScan(req.db, req, req.body));
});

// Offline queue flush: process scans in order, report each result.
r.post('/scan/batch', validate(z.object({ scans: z.array(scanInput).min(1).max(500) })), (req, res) => {
  const results = req.body.scans.map((sc) => {
    try {
      return { client_ref: sc.client_ref, awb: sc.awb, ...processScan(req.db, req, sc) };
    } catch (e) {
      return { client_ref: sc.client_ref, awb: sc.awb, result: 'EXCEPTION', message: e.message };
    }
  });
  res.json({ results });
});

r.get('/inventory', (req, res) => {
  const branchId = Number(req.query.branch_id) || req.user.branch_id;
  const args = [];
  let w = "s.status = 'IN_WAREHOUSE'";
  if (req.entity) { w += ' AND s.entity_code = ?'; args.push(req.entity); }
  if (branchId) { w += ' AND s.branch_id = ?'; args.push(branchId); }
  const rows = req.db.all(
    `SELECT s.id, s.awb, s.bin, s.service, s.dest_city, s.dest_country, s.shipment_type, s.customs_status, s.consignee_name, s.pieces, s.chargeable_weight, s.cod_amount,
            s.driver_id, u.name AS driver_name, b.code AS branch_code, s.updated_at,
            CAST((julianday('now') - julianday(s.updated_at)) * 24 AS INTEGER) AS hours_in_stock
       FROM shipments s JOIN branches b ON b.id = s.branch_id LEFT JOIN users u ON u.id = s.driver_id
      WHERE ${w} ORDER BY s.bin, s.awb`, ...args,
  );
  const byBin = {};
  for (const x of rows) byBin[x.bin || 'UNBINNED'] = (byBin[x.bin || 'UNBINNED'] || 0) + 1;
  const incoming = req.db.get(
    `SELECT COUNT(*) AS n FROM shipments WHERE status = 'IN_TRANSIT' ${branchId ? 'AND branch_id = ?' : ''}`,
    ...(branchId ? [branchId] : []),
  ).n;
  res.json({ rows, total: rows.length, by_bin: byBin, incoming_transfers: incoming });
});

r.get('/scans', (req, res) => {
  const branchId = Number(req.query.branch_id) || null;
  const limit = Math.min(500, Number(req.query.limit) || 100);
  res.json(req.db.all(
    `SELECT w.*, b.code AS branch_code, u.name AS user_name FROM warehouse_scans w
       JOIN branches b ON b.id = w.branch_id LEFT JOIN users u ON u.id = w.user_id
      ${branchId ? 'WHERE w.branch_id = ?' : ''} ORDER BY w.id DESC LIMIT ?`,
    ...(branchId ? [branchId, limit] : [limit]),
  ));
});

r.get('/manifests', (req, res) => {
  res.json(req.db.all(
    `SELECT m.id, m.number, m.mode, m.dest_airport, m.dest_country, m.flight_no, m.flight_date, COUNT(s.id) AS shipments
       FROM manifests m LEFT JOIN shipments s ON s.manifest_id = m.id WHERE m.status = 'OPEN' ${req.entity ? 'AND m.entity_code = ?' : ''}
      GROUP BY m.id ORDER BY m.id DESC`, ...(req.entity ? [req.entity] : [])));
});

r.get('/drivers', (req, res) => {
  res.json(req.db.all(`SELECT id, name, vehicle_no, phone FROM users WHERE role = 'DRIVER' AND active = 1
    ${req.entity ? 'AND entity_code = ?' : ''} ORDER BY name`, ...(req.entity ? [req.entity] : [])));
});

export default r;
