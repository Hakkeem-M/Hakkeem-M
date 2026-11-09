// International air courier & air cargo operations:
// customs (export docs / clearance), air manifests (consolidation under a MAWB), flights,
// overseas delivery agents and partner status updates, pre-alert export.
import { Router } from 'express';
import { z } from 'zod';
import { audit, nextSeq } from '../db.js';
import { requireRole, STAFF } from '../lib/auth.js';
import { addEvent, setStatus, customsDocsOk, STATUS_LABEL, shipmentDetail, repriceShipment } from '../lib/shipments.js';
import { itemInput } from '../lib/schemas.js';
import { round2 } from '../lib/pricing.js';
import { validate, idParam, notFound, conflict, badRequest, normalizeAwb, zText } from '../lib/util.js';
import { inEntity, entityForWrite, entityRow } from '../lib/entity.js';

const r = Router();
const READ = requireRole(...STAFF);
const OPS = requireRole('ADMIN', 'OPS');
const OPS_WH = requireRole('ADMIN', 'OPS', 'WAREHOUSE');

// ---------- reference data ----------
r.get('/meta', READ, (req, res) => {
  res.json({
    countries: req.db.all('SELECT * FROM countries WHERE active = 1 ORDER BY zone, name'),
    airports: req.db.all('SELECT * FROM airports ORDER BY code'),
    agents: req.db.all('SELECT * FROM agents WHERE active = 1 ORDER BY country, name'),
  });
});

r.put('/countries/:code', requireRole('ADMIN', 'FINANCE'), validate(z.object({
  zone: z.enum(['Z1', 'Z2', 'Z3', 'Z4', 'Z5', 'Z6']),
  duty_pct: z.coerce.number().min(0).max(300), import_vat_pct: z.coerce.number().min(0).max(100),
  de_minimis: z.coerce.number().min(0).max(1_000_000), airport: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional(),
  active: z.boolean().default(true),
})), (req, res) => {
  const code = String(req.params.code).toUpperCase();
  const c = req.db.get('SELECT * FROM countries WHERE code = ?', code);
  if (!c) throw notFound('Country');
  const b = req.body;
  req.db.run('UPDATE countries SET zone=?, duty_pct=?, import_vat_pct=?, de_minimis=?, airport=COALESCE(?, airport), active=? WHERE code = ?',
    b.zone, b.duty_pct, b.import_vat_pct, b.de_minimis, b.airport ?? null, b.active ? 1 : 0, code);
  audit(req.db, req, 'country.update', 'country', code, b);
  res.json(req.db.get('SELECT * FROM countries WHERE code = ?', code));
});

r.post('/agents', OPS, validate(z.object({
  name: zText(120), country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/),
  contact: z.string().max(120).optional(), email: z.string().email().max(160).optional(), phone: z.string().max(30).optional(),
  tracking_url: z.string().url().max(300).optional(),
})), (req, res) => {
  const b = req.body;
  const ins = req.db.run('INSERT INTO agents (name, country, contact, email, phone, tracking_url) VALUES (?,?,?,?,?,?)',
    b.name, b.country, b.contact ?? null, b.email ?? null, b.phone ?? null, b.tracking_url ?? null);
  audit(req.db, req, 'agent.create', 'agent', ins.lastInsertRowid, { name: b.name });
  res.status(201).json(req.db.get('SELECT * FROM agents WHERE id = ?', Number(ins.lastInsertRowid)));
});

// ---------- export queue & customs ----------
r.get('/exports', READ, (req, res) => {
  const where = ["s.shipment_type = 'INTERNATIONAL'"];
  const args = [];
  if (req.entity) { where.push('s.entity_code = ?'); args.push(req.entity); }
  if (req.query.mode && ['AIR', 'SEA'].includes(req.query.mode)) { where.push('s.mode = ?'); args.push(req.query.mode); }
  if (req.query.customs_status) { where.push('s.customs_status = ?'); args.push(String(req.query.customs_status)); }
  if (req.query.dest_country) { where.push('s.dest_country = ?'); args.push(String(req.query.dest_country).toUpperCase()); }
  if (req.query.stage === 'ready') where.push("s.status = 'IN_WAREHOUSE' AND s.manifest_id IS NULL");
  else if (req.query.stage === 'pre_hub') where.push("s.status IN ('BOOKED','PICKUP_ASSIGNED','PICKED_UP')");
  else if (req.query.stage === 'in_flight') where.push("s.status IN ('MANIFESTED','DEPARTED')");
  else if (req.query.stage === 'destination') where.push("s.status IN ('ARRIVED','CUSTOMS_HOLD','CUSTOMS_CLEARED','WITH_AGENT','OUT_FOR_DELIVERY','DELIVERY_FAILED')");
  else if (req.query.stage !== 'all') where.push("s.status NOT IN ('DELIVERED','CANCELLED','RETURNED')");
  res.json(req.db.all(
    `SELECT s.id, s.awb, s.status, s.service, s.product, s.incoterm, s.dest_country, s.dest_city, s.dest_airport, s.consignee_name,
            s.pieces, s.weight, s.chargeable_weight, s.customs_value, s.currency, s.customs_status, s.customs_ref, s.dangerous_goods,
            s.manifest_id, m.number AS manifest_number, s.created_at, c.name AS customer_name, co.name AS country_name,
            s.mode, s.entity_code, s.box_count, s.cbm, s.total_charge,
            (SELECT COUNT(*) FROM shipment_items i WHERE i.shipment_id = s.id) AS item_count
       FROM shipments s JOIN customers c ON c.id = s.customer_id LEFT JOIN countries co ON co.code = s.dest_country
       LEFT JOIN manifests m ON m.id = s.manifest_id
      WHERE ${where.join(' AND ')} ORDER BY s.dest_country, s.id DESC LIMIT 500`, ...args));
});

r.get('/summary', READ, (req, res) => {
  const ef = req.entity ? ` AND entity_code = '${req.entity.replace(/[^A-Z]/g, '')}'` : '';
  const one = (sql) => req.db.get(sql.replace(/\{E\}/g, ef));
  res.json({
    ready_to_manifest: one("SELECT COUNT(*) AS n FROM shipments WHERE shipment_type='INTERNATIONAL' AND status='IN_WAREHOUSE' AND manifest_id IS NULL{E}").n,
    docs_pending: one("SELECT COUNT(*) AS n FROM shipments WHERE shipment_type='INTERNATIONAL' AND customs_status='PENDING' AND status NOT IN ('CANCELLED','DELIVERED','RETURNED'){E}").n,
    customs_hold: one("SELECT COUNT(*) AS n FROM shipments WHERE (status='CUSTOMS_HOLD' OR customs_status='HOLD'){E}").n,
    in_flight: one("SELECT COUNT(*) AS n FROM shipments WHERE status IN ('MANIFESTED','DEPARTED'){E}").n,
    at_destination: one("SELECT COUNT(*) AS n FROM shipments WHERE status IN ('ARRIVED','CUSTOMS_CLEARED','WITH_AGENT','OUT_FOR_DELIVERY'){E}").n,
    open_manifests: one("SELECT COUNT(*) AS n FROM manifests WHERE status IN ('OPEN','CLOSED'){E}").n,
    by_country: req.db.all(
      `SELECT s.dest_country AS code, co.name, co.zone, COUNT(*) AS shipments, ROUND(SUM(s.chargeable_weight),1) AS kg, ROUND(SUM(s.total_charge),2) AS revenue
         FROM shipments s LEFT JOIN countries co ON co.code = s.dest_country
        WHERE s.shipment_type='INTERNATIONAL' AND s.status != 'CANCELLED' AND date(s.created_at) >= date('now','-30 day')
          ${req.entity ? 'AND s.entity_code = ?' : ''}
        GROUP BY s.dest_country ORDER BY revenue DESC LIMIT 12`, ...(req.entity ? [req.entity] : [])),
  });
});

// Replace commercial-invoice lines (fixes customs docs). Re-prices DDP duties if not yet invoiced.
r.put('/shipments/:id/items', requireRole('ADMIN', 'OPS', 'SALES'), validate(z.object({
  items: z.array(itemInput).min(1).max(100),
  export_reason: z.enum(['SALE', 'GIFT', 'SAMPLE', 'RETURN', 'PERSONAL', 'REPAIR']).optional(),
})), (req, res) => {
  const id = idParam(req);
  const out = req.db.tx(() => {
    const s = inEntity(req, req.db.get('SELECT * FROM shipments WHERE id = ?', id), 'Shipment');
    if (s.shipment_type !== 'INTERNATIONAL') throw notFound('International shipment');
    if (['DEPARTED', 'ARRIVED', 'CUSTOMS_CLEARED', 'WITH_AGENT', 'DELIVERED'].includes(s.status)) throw conflict('Shipment has left origin — amend via destination agent');
    req.db.run('DELETE FROM shipment_items WHERE shipment_id = ?', id);
    for (const it of req.body.items) {
      req.db.run('INSERT INTO shipment_items (shipment_id, description, hs_code, qty, unit_value, weight, origin_country) VALUES (?,?,?,?,?,?,?)',
        id, it.description, it.hs_code ?? null, it.qty, it.unit_value, it.weight ?? null, it.origin_country);
    }
    const value = round2(req.body.items.reduce((a, i) => a + i.qty * i.unit_value, 0));
    const ok = customsDocsOk(s.product, req.body.items);
    req.db.run(`UPDATE shipments SET customs_value = ?, export_reason = COALESCE(?, export_reason),
                customs_status = CASE WHEN customs_status IN ('PENDING','DOCS_OK') THEN ? ELSE customs_status END WHERE id = ?`,
    value, req.body.export_reason ?? null, ok ? 'DOCS_OK' : 'PENDING', id);
    if (!s.invoice_id && s.incoterm === 'DDP') repriceShipment(req.db, { ...s, customs_value: value }, {});
    audit(req.db, req, 'customs.items', 'shipment', s.awb, { value, lines: req.body.items.length });
    return shipmentDetail(req.db, id);
  });
  res.json(out);
});

r.post('/shipments/:id/customs', OPS, validate(z.object({
  customs_status: z.enum(['PENDING', 'DOCS_OK', 'SUBMITTED', 'HOLD', 'CLEARED']),
  customs_ref: z.string().trim().max(60).optional(),
  note: z.string().trim().max(300).optional(),
})), (req, res) => {
  const id = idParam(req);
  req.db.tx(() => {
    const s = inEntity(req, req.db.get('SELECT * FROM shipments WHERE id = ?', id), 'Shipment');
    if (s.shipment_type !== 'INTERNATIONAL') throw notFound('International shipment');
    const b = req.body;
    if (b.customs_status === 'DOCS_OK') {
      const items = req.db.all('SELECT * FROM shipment_items WHERE shipment_id = ?', id);
      if (!customsDocsOk(s.product, items)) throw conflict('Commercial invoice incomplete — every line needs description, 6–10 digit HS code, qty and value');
    }
    req.db.run('UPDATE shipments SET customs_status = ?, customs_ref = COALESCE(?, customs_ref) WHERE id = ?', b.customs_status, b.customs_ref ?? null, id);
    const atDest = ['ARRIVED', 'CUSTOMS_HOLD', 'CUSTOMS_CLEARED'].includes(s.status);
    if (atDest && b.customs_status === 'HOLD') { setStatus(req.db, id, 'CUSTOMS_HOLD'); addEvent(req.db, id, 'CUSTOMS_HOLD', { location: s.dest_country, note: b.note || 'Held by destination customs', userId: req.user.id }); }
    if (atDest && b.customs_status === 'CLEARED') { setStatus(req.db, id, 'CUSTOMS_CLEARED'); addEvent(req.db, id, 'CUSTOMS_CLEARED', { location: s.dest_country, note: b.note || 'Import customs cleared', userId: req.user.id }); }
    if (!atDest && b.customs_status === 'HOLD') addEvent(req.db, id, s.status, { note: `Export customs query: ${b.note || 'documents required'}`, userId: req.user.id });
    audit(req.db, req, 'customs.status', 'shipment', s.awb, b);
  });
  res.json(shipmentDetail(req.db, id));
});

// ---------- air manifests ----------
const manifestRow = (db, id) => {
  const m = db.get(
    `SELECT m.*, a.name AS agent_name, a.email AS agent_email, ap.name AS dest_airport_name, ap.city AS dest_city, u.name AS created_by_name
       FROM manifests m LEFT JOIN agents a ON a.id = m.agent_id LEFT JOIN airports ap ON ap.code = m.dest_airport
       LEFT JOIN users u ON u.id = m.created_by WHERE m.id = ?`, id);
  if (!m) return null;
  m.shipments = db.all(
    `SELECT id, awb, status, product, consignee_name, dest_city, pieces, weight, chargeable_weight, customs_value, currency,
            customs_status, incoterm, dangerous_goods, agent_tracking
       FROM shipments WHERE manifest_id = ? ORDER BY id`, id);
  m.totals = {
    shipments: m.shipments.length,
    pieces: m.shipments.reduce((a, s) => a + s.pieces, 0),
    weight: round2(m.shipments.reduce((a, s) => a + s.weight, 0)),
    chargeable: round2(m.shipments.reduce((a, s) => a + s.chargeable_weight, 0)),
    value: round2(m.shipments.reduce((a, s) => a + s.customs_value, 0)),
  };
  return m;
};

r.get('/manifests', READ, (req, res) => {
  const st = req.query.status ? String(req.query.status).split(',') : null;
  res.json(req.db.all(
    `SELECT m.*, a.name AS agent_name, COUNT(s.id) AS shipments, COALESCE(SUM(s.pieces),0) AS pieces, ROUND(COALESCE(SUM(s.chargeable_weight),0),1) AS chargeable
       FROM manifests m LEFT JOIN agents a ON a.id = m.agent_id LEFT JOIN shipments s ON s.manifest_id = m.id
      WHERE 1=1 ${st ? `AND m.status IN (${st.map(() => '?').join(',')})` : ''} ${req.entity ? 'AND m.entity_code = ?' : ''}
      GROUP BY m.id ORDER BY m.id DESC LIMIT 200`, ...(st || []), ...(req.entity ? [req.entity] : [])));
});

r.post('/manifests', OPS, validate(z.object({
  mode: z.enum(['AIR_COURIER', 'AIR_CARGO', 'SEA_CONSOL']).default('AIR_COURIER'),
  origin_airport: z.string().trim().toUpperCase().regex(/^[A-Z]{3,5}$/).optional(),
  dest_airport: z.string().trim().toUpperCase().regex(/^[A-Z]{3,5}$/),
  container_no: z.string().trim().toUpperCase().max(15).optional(),
  vessel: z.string().trim().max(60).optional(),
  entity_code: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/).optional(),
  airline: z.string().trim().max(60).optional(),
  flight_no: z.string().trim().toUpperCase().max(10).optional(),
  flight_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  mawb_no: z.string().trim().toUpperCase().regex(/^(\d{3}-?\d{8}|[A-Z0-9-]{6,20})$/, 'MAWB 176-12345678 or bill of lading no.').optional(),
  agent_id: z.coerce.number().int().positive().optional(),
  notes: z.string().max(300).optional(),
})), (req, res) => {
  const b = req.body;
  const ent = entityForWrite(req, b.entity_code);
  const e = entityRow(req.db, ent);
  const sea = b.mode === 'SEA_CONSOL';
  const ap = req.db.get('SELECT * FROM airports WHERE code = ? AND kind = ?', b.dest_airport, sea ? 'SEA' : 'AIR');
  if (!ap) throw badRequest(sea ? 'Unknown destination sea port' : 'Unknown destination airport');
  const origin = b.origin_airport || (sea ? e.sea_gateway : e.gateway);
  if (sea && b.mawb_no && /^\d{3}-?\d{8}$/.test(b.mawb_no) === false && b.mawb_no.length < 6) throw badRequest('Invalid bill of lading');
  const number = `MAN-${origin}-${ap.code}-${String(nextSeq(req.db, 'manifest')).padStart(5, '0')}`;
  const ins = req.db.run(
    `INSERT INTO manifests (number, mode, origin_airport, dest_airport, dest_country, airline, flight_no, flight_date, mawb_no, agent_id, notes, created_by,
       entity_code, container_no, vessel)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    number, b.mode, origin, ap.code, ap.country, b.airline ?? null, b.flight_no ?? null, b.flight_date ?? null,
    b.mawb_no ?? null, b.agent_id ?? null, b.notes ?? null, req.user.id, ent, b.container_no ?? null, b.vessel ?? null);
  audit(req.db, req, 'manifest.create', 'manifest', number);
  res.status(201).json(manifestRow(req.db, Number(ins.lastInsertRowid)));
});

r.get('/manifests/:id', READ, (req, res) => {
  res.json(inEntity(req, manifestRow(req.db, idParam(req)), 'Manifest'));
});

r.patch('/manifests/:id', OPS, validate(z.object({
  airline: z.string().trim().max(60).optional(), flight_no: z.string().trim().toUpperCase().max(10).optional(),
  flight_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  mawb_no: z.string().trim().toUpperCase().regex(/^(\d{3}-?\d{8}|[A-Z0-9-]{6,20})$/, 'MAWB 176-12345678 or bill of lading no.').optional(),
  agent_id: z.coerce.number().int().positive().optional(), notes: z.string().max(300).optional(),
  container_no: z.string().trim().toUpperCase().max(15).optional(), vessel: z.string().trim().max(60).optional(),
})), (req, res) => {
  const id = idParam(req);
  const m = inEntity(req, req.db.get('SELECT * FROM manifests WHERE id = ?', id), 'Manifest');
  if (['ARRIVED', 'CLEARED', 'DELIVERED'].includes(m.status)) throw conflict('Manifest already arrived');
  const f = Object.fromEntries(Object.entries(req.body).filter(([, v]) => v !== undefined));
  const keys = Object.keys(f);
  if (keys.length) req.db.run(`UPDATE manifests SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => f[k]), id);
  if (f.agent_id) req.db.run('UPDATE shipments SET agent_id = ? WHERE manifest_id = ?', f.agent_id, id);
  audit(req.db, req, 'manifest.update', 'manifest', m.number, f);
  res.json(manifestRow(req.db, id));
});

/** Add a shipment (by AWB scan) to an open manifest. Enforces destination, hub stock and customs docs. */
export function addToManifest(db, req, manifestId, awbRaw) {
  return db.tx(() => {
    const m = inEntity(req, db.get('SELECT * FROM manifests WHERE id = ?', manifestId), 'Manifest');
    if (m.status !== 'OPEN') throw conflict(`Manifest is ${m.status}`);
    const s = db.get('SELECT * FROM shipments WHERE awb = ?', normalizeAwb(awbRaw));
    if (!s) throw notFound('Shipment');
    if (s.shipment_type !== 'INTERNATIONAL') throw conflict('Domestic shipment cannot be manifested');
    if (s.entity_code !== m.entity_code) throw conflict('Shipment belongs to another region');
    if ((m.mode === 'SEA_CONSOL') !== (s.mode === 'SEA')) throw conflict(m.mode === 'SEA_CONSOL' ? 'Air shipment cannot go on a sea consolidation' : 'Sea cargo needs a SEA_CONSOL manifest');
    if (s.manifest_id === m.id) return { already: true, shipment: s };
    if (s.manifest_id) throw conflict('Already on another manifest');
    if (s.status !== 'IN_WAREHOUSE') throw conflict(`Must be IN-scanned at hub first (now: ${STATUS_LABEL[s.status]})`);
    if (s.dest_country !== m.dest_country) throw conflict(`Destination ${s.dest_country} does not match manifest ${m.dest_country}`);
    if (!['DOCS_OK', 'SUBMITTED', 'CLEARED'].includes(s.customs_status)) throw conflict('Customs documents incomplete — fix commercial invoice first');
    if (s.dangerous_goods && m.mode === 'AIR_COURIER') throw conflict('Dangerous goods must travel on an AIR_CARGO manifest with DG declaration');
    setStatus(db, s.id, 'MANIFESTED', { manifest_id: m.id, agent_id: m.agent_id ?? s.agent_id, bin: null, customs_status: s.customs_status === 'DOCS_OK' ? 'SUBMITTED' : s.customs_status });
    addEvent(db, s.id, 'MANIFESTED', { location: `${m.origin_airport} export hub`, note: `Export processed — consolidated for ${m.dest_airport}`, userId: req.user.id });
    audit(db, req, 'manifest.add', 'manifest', m.number, { awb: s.awb });
    return { shipment: db.get('SELECT * FROM shipments WHERE id = ?', s.id) };
  });
}

r.post('/manifests/:id/add', OPS_WH, validate(z.object({ awb: z.string().trim().min(5).max(40) })), (req, res) => {
  const id = idParam(req);
  const out = addToManifest(req.db, req, id, req.body.awb);
  res.json({ ...out, manifest: manifestRow(req.db, id) });
});

r.post('/manifests/:id/remove', OPS, validate(z.object({ shipment_id: z.coerce.number().int().positive() })), (req, res) => {
  const id = idParam(req);
  req.db.tx(() => {
    const m = inEntity(req, req.db.get('SELECT * FROM manifests WHERE id = ?', id), 'Manifest');
    if (m.status !== 'OPEN') throw conflict('Only open manifests can be edited');
    const s = req.db.get('SELECT * FROM shipments WHERE id = ? AND manifest_id = ?', req.body.shipment_id, id);
    if (!s) throw notFound('Shipment on manifest');
    setStatus(req.db, s.id, 'IN_WAREHOUSE', { manifest_id: null });
    addEvent(req.db, s.id, 'IN_WAREHOUSE', { note: `Removed from manifest ${m.number}`, userId: req.user.id, isPublic: false });
  });
  res.json(manifestRow(req.db, id));
});

const nowTs = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

function cascade(req, m, status, note, location, extra = {}) {
  const ships = req.db.all("SELECT * FROM shipments WHERE manifest_id = ? AND status NOT IN ('DELIVERED','RETURNED','CANCELLED')", m.id);
  for (const s of ships) {
    setStatus(req.db, s.id, status, extra);
    addEvent(req.db, s.id, status, { location, note, userId: req.user.id });
  }
  return ships.length;
}

r.post('/manifests/:id/close', OPS, (req, res) => {
  const id = idParam(req);
  req.db.tx(() => {
    const m = inEntity(req, manifestRow(req.db, id), 'Manifest');
    if (m.status !== 'OPEN') throw conflict(`Manifest is ${m.status}`);
    if (!m.shipments.length) throw conflict('Manifest is empty');
    if (!m.mawb_no || !m.flight_no) throw conflict('Enter flight number and MAWB before closing');
    req.db.run("UPDATE manifests SET status = 'CLOSED' WHERE id = ?", id);
    audit(req.db, req, 'manifest.close', 'manifest', m.number, m.totals);
  });
  res.json(manifestRow(req.db, id));
});

r.post('/manifests/:id/depart', OPS, validate(z.object({ departed_at: z.string().max(25).optional() })), (req, res) => {
  const id = idParam(req);
  req.db.tx(() => {
    const m = inEntity(req, req.db.get('SELECT * FROM manifests WHERE id = ?', id), 'Manifest');
    if (m.status !== 'CLOSED') throw conflict('Close the manifest before departure');
    req.db.run("UPDATE manifests SET status = 'DEPARTED', departed_at = ? WHERE id = ?", req.body.departed_at || nowTs(), id);
    cascade(req, m, 'DEPARTED', (m.mode === 'SEA_CONSOL'
      ? `Sailed from ${m.origin_airport} on ${m.vessel || 'vessel'} ${m.flight_no || ''}${m.container_no ? ` · container ${m.container_no}` : ''} to ${m.dest_airport}`
      : `Departed ${m.origin_airport} on ${m.airline || ''} ${m.flight_no} to ${m.dest_airport}`).replace(/\s+/g, ' '), m.origin_airport);
    audit(req.db, req, 'manifest.depart', 'manifest', m.number);
  });
  res.json(manifestRow(req.db, id));
});

r.post('/manifests/:id/arrive', OPS, (req, res) => {
  const id = idParam(req);
  req.db.tx(() => {
    const m = inEntity(req, req.db.get('SELECT * FROM manifests WHERE id = ?', id), 'Manifest');
    if (m.status !== 'DEPARTED') throw conflict('Manifest has not departed');
    req.db.run("UPDATE manifests SET status = 'ARRIVED', arrived_at = ? WHERE id = ?", nowTs(), id);
    cascade(req, m, 'ARRIVED', `Arrived at ${m.dest_airport} — awaiting import customs`, m.dest_airport);
    audit(req.db, req, 'manifest.arrive', 'manifest', m.number);
  });
  res.json(manifestRow(req.db, id));
});

// Clear all (or all except held AWBs) and hand over to the destination delivery agent.
r.post('/manifests/:id/clear', OPS, validate(z.object({ hold_awbs: z.array(z.string()).default([]), handover: z.boolean().default(true) })), (req, res) => {
  const id = idParam(req);
  req.db.tx(() => {
    const m = inEntity(req, req.db.get('SELECT * FROM manifests WHERE id = ?', id), 'Manifest');
    if (m.status !== 'ARRIVED') throw conflict('Manifest must be ARRIVED');
    const hold = new Set(req.body.hold_awbs.map(normalizeAwb));
    const ships = req.db.all("SELECT * FROM shipments WHERE manifest_id = ? AND status IN ('ARRIVED','CUSTOMS_HOLD')", id);
    const agent = m.agent_id && req.db.get('SELECT * FROM agents WHERE id = ?', m.agent_id);
    for (const s of ships) {
      if (hold.has(s.awb)) {
        setStatus(req.db, s.id, 'CUSTOMS_HOLD', { customs_status: 'HOLD' });
        addEvent(req.db, s.id, 'CUSTOMS_HOLD', { location: m.dest_airport, note: 'Held by destination customs — documents requested', userId: req.user.id });
        continue;
      }
      setStatus(req.db, s.id, 'CUSTOMS_CLEARED', { customs_status: 'CLEARED' });
      addEvent(req.db, s.id, 'CUSTOMS_CLEARED', { location: m.dest_airport, note: 'Import customs cleared', userId: req.user.id });
      if (req.body.handover && agent) {
        setStatus(req.db, s.id, 'WITH_AGENT', { agent_id: agent.id });
        addEvent(req.db, s.id, 'WITH_AGENT', { location: m.dest_city || m.dest_airport, note: 'Handed to local delivery partner', userId: req.user.id });
      }
    }
    req.db.run("UPDATE manifests SET status = 'CLEARED' WHERE id = ?", id);
    audit(req.db, req, 'manifest.clear', 'manifest', m.number, { held: [...hold] });
  });
  res.json(manifestRow(req.db, id));
});

// Overseas partner status update (entered by ops, or posted by agent integration).
r.post('/shipments/:id/agent-event', OPS, validate(z.object({
  status: z.enum(['WITH_AGENT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'DELIVERY_FAILED', 'CUSTOMS_HOLD', 'CUSTOMS_CLEARED', 'RETURNED']),
  note: z.string().trim().max(300).optional(),
  location: z.string().trim().max(80).optional(),
  pod_name: z.string().trim().max(120).optional(),
  agent_tracking: z.string().trim().max(60).optional(),
})), (req, res) => {
  const id = idParam(req);
  req.db.tx(() => {
    const s = inEntity(req, req.db.get('SELECT * FROM shipments WHERE id = ?', id), 'Shipment');
    if (s.shipment_type !== 'INTERNATIONAL') throw notFound('International shipment');
    if (!['ARRIVED', 'CUSTOMS_HOLD', 'CUSTOMS_CLEARED', 'WITH_AGENT', 'OUT_FOR_DELIVERY', 'DELIVERY_FAILED'].includes(s.status)) {
      throw conflict(`Partner updates apply after arrival (now ${STATUS_LABEL[s.status]})`);
    }
    const b = req.body;
    if (b.status === 'DELIVERED' && !b.pod_name) throw badRequest('Receiver name (POD) is required');
    const extra = { agent_tracking: b.agent_tracking ?? s.agent_tracking };
    if (b.status === 'DELIVERED') Object.assign(extra, { pod_name: b.pod_name, delivered_at: nowTs() });
    if (b.status === 'DELIVERY_FAILED') extra.attempts = s.attempts + 1;
    if (b.status === 'CUSTOMS_HOLD') extra.customs_status = 'HOLD';
    if (b.status === 'CUSTOMS_CLEARED') extra.customs_status = 'CLEARED';
    setStatus(req.db, id, b.status, extra);
    addEvent(req.db, id, b.status, {
      location: b.location || s.dest_city,
      note: b.note || (b.status === 'DELIVERED' ? `Delivered — received by ${b.pod_name}` : STATUS_LABEL[b.status]), userId: req.user.id,
    });
    audit(req.db, req, 'agent.event', 'shipment', s.awb, b);
  });
  res.json(shipmentDetail(req.db, id));
});

// Pre-alert for the destination agent (CSV, opens in Excel).
r.get('/manifests/:id/prealert.csv', READ, (req, res) => {
  const m = inEntity(req, manifestRow(req.db, idParam(req)), 'Manifest');
  const esc = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // CSV formula-injection guard
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [['MAWB', 'Flight', 'AWB', 'Product', 'Consignee', 'Phone', 'Address', 'City', 'Postcode', 'Tax ID', 'Pieces', 'Weight kg', 'Value', 'Currency', 'Incoterm', 'Contents', 'HS codes']];
  for (const s of m.shipments) {
    const full = req.db.get('SELECT * FROM shipments WHERE id = ?', s.id);
    const items = req.db.all('SELECT description, hs_code, qty FROM shipment_items WHERE shipment_id = ?', s.id);
    rows.push([m.mawb_no, `${m.flight_no || ''} ${m.flight_date || ''}`.trim(), s.awb, s.product, full.consignee_name, full.consignee_phone,
      full.consignee_address, full.dest_city, full.consignee_postcode, full.consignee_tax_id, s.pieces, s.weight, s.customs_value, s.currency,
      s.incoterm, items.map((i) => `${i.qty}x ${i.description}`).join('; '), items.map((i) => i.hs_code).filter(Boolean).join(' ')]);
  }
  audit(req.db, req, 'manifest.prealert', 'manifest', m.number);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${m.number}-prealert.csv"`);
  res.send(`﻿${rows.map((r2) => r2.map(esc).join(',')).join('\r\n')}`);
});

export default r;
