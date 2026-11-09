// ERP shipment operations: booking, search, dispatch/assignment, manual status control.
import { Router } from 'express';
import { z } from 'zod';
import { audit } from '../db.js';
import { requireRole, STAFF } from '../lib/auth.js';
import {
  createShipment, shipmentDetail, setStatus, addEvent, STATUSES, FINAL,
} from '../lib/shipments.js';
import { shipmentInput } from '../lib/schemas.js';
import { validate, idParam, notFound, badRequest, conflict, paginate, normalizeAwb } from '../lib/util.js';

const r = Router();
r.use(requireRole(...STAFF));

r.get('/', (req, res) => {
  const q = req.query;
  const where = [];
  const args = [];
  if (q.status) {
    const list = String(q.status).split(',').filter((s) => STATUSES.includes(s));
    if (list.length) { where.push(`s.status IN (${list.map(() => '?').join(',')})`); args.push(...list); }
  }
  if (q.customer_id) { where.push('s.customer_id = ?'); args.push(Number(q.customer_id)); }
  if (q.driver_id) { where.push('s.driver_id = ?'); args.push(Number(q.driver_id)); }
  if (q.branch_id) { where.push('s.branch_id = ?'); args.push(Number(q.branch_id)); }
  if (q.unassigned === '1') where.push('s.driver_id IS NULL');
  if (q.type === 'INTERNATIONAL' || q.type === 'DOMESTIC') { where.push('s.shipment_type = ?'); args.push(q.type); }
  if (q.from) { where.push('date(s.created_at) >= date(?)'); args.push(String(q.from)); }
  if (q.to) { where.push('date(s.created_at) <= date(?)'); args.push(String(q.to)); }
  if (q.q) {
    const like = `%${String(q.q).trim().slice(0, 60)}%`;
    where.push('(s.awb LIKE ? OR s.consignee_name LIKE ? OR s.consignee_phone LIKE ? OR s.shipper_name LIKE ? OR s.reference LIKE ?)');
    args.push(like, like, like, like, like);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { limit, offset, page } = paginate(q);
  const total = req.db.get(`SELECT COUNT(*) AS n FROM shipments s ${w}`, ...args).n;
  const rows = req.db.all(
    `SELECT s.id, s.awb, s.status, s.service, s.zone, s.payment_mode, s.origin_city, s.dest_city, s.dest_country,
            s.shipper_name, s.consignee_name, s.consignee_phone, s.pieces, s.chargeable_weight, s.cod_amount,
            s.total_charge, s.invoice_id, s.driver_id, s.branch_id, s.bin, s.attempts, s.created_at, s.updated_at,
            s.shipment_type, s.customs_status, s.dest_airport,
            c.name AS customer_name, u.name AS driver_name, b.code AS branch_code
       FROM shipments s JOIN customers c ON c.id = s.customer_id
       LEFT JOIN users u ON u.id = s.driver_id LEFT JOIN branches b ON b.id = s.branch_id
       ${w} ORDER BY s.id DESC LIMIT ? OFFSET ?`, ...args, limit, offset,
  );
  res.json({ rows, total, page, limit });
});

r.post('/', requireRole('ADMIN', 'OPS'), validate(shipmentInput.extend({
  customer_id: z.coerce.number().int().positive(),
  payment_mode: z.enum(['ACCOUNT', 'CASH', 'PREPAID']).optional(),
})), (req, res) => {
  const s = createShipment(req.db, req, req.body, { paymentMode: req.body.payment_mode });
  res.status(201).json(shipmentDetail(req.db, s.id));
});

r.get('/awb/:awb', (req, res) => {
  const row = req.db.get('SELECT id FROM shipments WHERE awb = ?', normalizeAwb(req.params.awb));
  if (!row) throw notFound('Shipment');
  res.json(shipmentDetail(req.db, row.id));
});

r.get('/:id', (req, res) => {
  const s = shipmentDetail(req.db, idParam(req));
  if (!s) throw notFound('Shipment');
  res.json(s);
});

// Assign a driver: BOOKED -> PICKUP_ASSIGNED, or set the delivery driver for a parcel waiting in the warehouse.
r.post('/assign', requireRole('ADMIN', 'OPS'), validate(z.object({
  shipment_ids: z.array(z.coerce.number().int().positive()).min(1).max(200),
  driver_id: z.coerce.number().int().positive(),
})), (req, res) => {
  const { shipment_ids: ids, driver_id: driverId } = req.body;
  const driver = req.db.get("SELECT id, name FROM users WHERE id = ? AND role = 'DRIVER' AND active = 1", driverId);
  if (!driver) throw badRequest('Driver not found or inactive');
  const results = req.db.tx(() => ids.map((id) => {
    const s = req.db.get('SELECT * FROM shipments WHERE id = ?', id);
    if (!s) return { id, ok: false, error: 'Not found' };
    if (['BOOKED', 'PICKUP_ASSIGNED'].includes(s.status)) {
      setStatus(req.db, id, 'PICKUP_ASSIGNED', { driver_id: driverId });
      addEvent(req.db, id, 'PICKUP_ASSIGNED', { note: 'Courier assigned for pickup', userId: req.user.id, location: s.origin_city });
    } else if (['IN_WAREHOUSE', 'DELIVERY_FAILED'].includes(s.status)) {
      req.db.run("UPDATE shipments SET driver_id = ?, updated_at = datetime('now') WHERE id = ?", driverId, id);
      addEvent(req.db, id, s.status, { note: `Delivery assigned to ${driver.name}`, userId: req.user.id, isPublic: false });
    } else {
      return { id, awb: s.awb, ok: false, error: `Cannot assign while ${s.status}` };
    }
    audit(req.db, req, 'shipment.assign', 'shipment', s.awb, { driver_id: driverId });
    return { id, awb: s.awb, ok: true };
  }));
  res.json({ results });
});

const MANUAL = {
  BOOKED: ['CANCELLED'],
  PICKUP_ASSIGNED: ['BOOKED', 'CANCELLED'],
  IN_TRANSIT: ['IN_WAREHOUSE'],
  DELIVERY_FAILED: ['RETURNED'],
  OUT_FOR_DELIVERY: ['DELIVERY_FAILED'],
};

r.post('/:id/status', requireRole('ADMIN', 'OPS'), validate(z.object({
  status: z.enum(STATUSES),
  note: z.string().trim().max(300).optional(),
})), (req, res) => {
  const id = idParam(req);
  const s = req.db.get('SELECT * FROM shipments WHERE id = ?', id);
  if (!s) throw notFound('Shipment');
  const allowed = req.user.role === 'ADMIN' && !FINAL.has(s.status) ? STATUSES : (MANUAL[s.status] || []);
  if (!allowed.includes(req.body.status)) throw conflict(`Cannot change ${s.status} to ${req.body.status}`);
  if (req.body.status === 'CANCELLED' && s.invoice_id) throw conflict('Void the invoice before cancelling');
  req.db.tx(() => {
    const extra = req.body.status === 'BOOKED' ? { driver_id: null } : {};
    setStatus(req.db, id, req.body.status, extra);
    addEvent(req.db, id, req.body.status, { note: req.body.note || 'Status updated by operations', userId: req.user.id });
    audit(req.db, req, 'shipment.status', 'shipment', s.awb, { from: s.status, to: req.body.status });
  });
  res.json(shipmentDetail(req.db, id));
});

export default r;
