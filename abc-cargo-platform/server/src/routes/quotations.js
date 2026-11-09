// Quotations: price a full booking (boxes, sea/air, charges) for a lead or customer, send, accept, convert to a shipment.
// Also: saved receivers (address book) and KYC documents for staff.
import { Router } from 'express';
import { z } from 'zod';
import { audit, nextSeq } from '../db.js';
import { requireRole, STAFF } from '../lib/auth.js';
import { computeCharges, createShipment, shipmentDetail } from '../lib/shipments.js';
import { shipmentInput } from '../lib/schemas.js';
import { validate, idParam, notFound, conflict, badRequest, zText, zPhone, zDataImage, today, addDays, paginate } from '../lib/util.js';
import { inEntity, entityForWrite } from '../lib/entity.js';

const r = Router();
const READ = requireRole(...STAFF);
const WRITE = requireRole('ADMIN', 'OPS', 'SALES');

const quoteBody = shipmentInput.extend({
  customer_id: z.coerce.number().int().positive().optional(),
  lead_id: z.coerce.number().int().positive().optional(),
  enquiry_id: z.coerce.number().int().positive().optional(),
  contact_name: zText(120).optional(),
  contact_phone: zPhone.optional(),
  contact_email: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().email().max(160).optional()),
  valid_days: z.coerce.number().int().min(1).max(90).default(14),
  notes: z.string().trim().max(1000).optional(),
  entity_code: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/).optional(),
});

function quoteRow(db, id) {
  const q = db.get(
    `SELECT q.*, c.name AS customer_name, c.code AS customer_code, u.name AS created_by_name, s.awb
       FROM quotations q LEFT JOIN customers c ON c.id = q.customer_id LEFT JOIN users u ON u.id = q.created_by
       LEFT JOIN shipments s ON s.id = q.shipment_id WHERE q.id = ?`, id);
  if (!q) return null;
  q.payload = JSON.parse(q.payload);
  q.pricing = JSON.parse(q.pricing);
  q.expired = q.status !== 'CONVERTED' && q.valid_until < today();
  return q;
}

r.get('/', READ, (req, res) => {
  const where = [];
  const args = [];
  if (req.entity) { where.push('q.entity_code = ?'); args.push(req.entity); }
  if (req.query.status) { where.push('q.status = ?'); args.push(String(req.query.status)); }
  if (req.query.q) { where.push('(q.number LIKE ? OR q.contact_name LIKE ? OR q.contact_phone LIKE ?)'); args.push(...Array(3).fill(`%${req.query.q}%`)); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { limit, offset } = paginate(req.query);
  res.json(req.db.all(
    `SELECT q.id, q.number, q.entity_code, q.currency, q.contact_name, q.contact_phone, q.service, q.origin_city, q.dest_country, q.dest_city,
            q.total, q.valid_until, q.status, q.created_at, q.shipment_id, c.name AS customer_name,
            CASE WHEN q.status NOT IN ('CONVERTED','REJECTED') AND q.valid_until < date('now') THEN 1 ELSE 0 END AS expired
       FROM quotations q LEFT JOIN customers c ON c.id = q.customer_id ${w} ORDER BY q.id DESC LIMIT ? OFFSET ?`, ...args, limit, offset));
});

r.post('/', WRITE, validate(quoteBody), (req, res) => {
  const b = req.body;
  let customer = null;
  if (b.customer_id) customer = inEntity(req, req.db.get('SELECT * FROM customers WHERE id = ?', b.customer_id), 'Customer');
  let lead = null;
  if (b.lead_id) lead = inEntity(req, req.db.get('SELECT * FROM leads WHERE id = ?', b.lead_id), 'Lead');
  let enquiry = null;
  if (b.enquiry_id) enquiry = inEntity(req, req.db.get('SELECT * FROM enquiries WHERE id = ?', b.enquiry_id), 'Enquiry');
  const entity = customer?.entity_code || lead?.entity_code || enquiry?.entity_code || entityForWrite(req, b.entity_code);
  const contactName = b.contact_name || customer?.name || lead?.contact_name || b.shipper_name;
  const items = b.items || [];
  const customsValue = items.reduce((a, i) => a + i.qty * i.unit_value, 0);
  const priced = computeCharges(req.db, { ...b, entity_code: entity, customs_value: customsValue, incoterm: b.incoterm || 'DAP' });
  const { settings, country, ...pricing } = priced;
  const number = `QT-${entity}-${String(nextSeq(req.db, 'quotation')).padStart(6, '0')}`;
  const payload = { ...b };
  delete payload.valid_days; delete payload.notes; delete payload.enquiry_id;
  const ins = req.db.run(
    `INSERT INTO quotations (number, entity_code, currency, customer_id, lead_id, contact_name, contact_phone, contact_email, service,
       origin_city, dest_country, dest_city, payload, pricing, total, valid_until, notes, created_by, enquiry_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    number, entity, pricing.currency, customer?.id ?? null, lead?.id ?? null, contactName, b.contact_phone || customer?.phone || lead?.phone || b.shipper_phone,
    b.contact_email || customer?.email || lead?.email || null, b.service, b.origin_city, (b.dest_country || entity).toUpperCase(), b.dest_city,
    JSON.stringify(payload), JSON.stringify({ ...pricing, country: country?.name ?? null }), pricing.total_charge, addDays(today(), b.valid_days),
    b.notes ?? null, req.user.id, enquiry?.id ?? null);
  const qid = Number(ins.lastInsertRowid);
  if (enquiry) {
    req.db.run("UPDATE enquiries SET status = CASE WHEN status = 'NEW' THEN 'QUOTED' ELSE status END, quotation_id = ?, updated_at = datetime('now') WHERE id = ?", qid, enquiry.id);
    req.db.run("INSERT INTO enquiry_messages (enquiry_id, direction, body, user_id) VALUES (?, 'SYSTEM', ?, ?)", enquiry.id, `Quotation ${number} created — ${pricing.currency} ${pricing.total_charge.toFixed(2)}`, req.user.id);
  }
  audit(req.db, req, 'quotation.create', 'quotation', number, { total: pricing.total_charge, currency: pricing.currency });
  if (lead && ['NEW', 'CONTACTED', 'QUALIFIED'].includes(lead.stage)) {
    req.db.run("UPDATE leads SET stage = 'PROPOSAL', probability = 60, updated_at = datetime('now') WHERE id = ?", lead.id);
  }
  res.status(201).json(quoteRow(req.db, qid));
});

r.get('/:id', READ, (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) return next(); // let /documents and /customers routes match
  res.json(inEntity(req, quoteRow(req.db, idParam(req)), 'Quotation'));
});

r.post('/:id/status', WRITE, validate(z.object({ status: z.enum(['SENT', 'ACCEPTED', 'REJECTED']) })), (req, res) => {
  const id = idParam(req);
  const q = inEntity(req, quoteRow(req.db, id), 'Quotation');
  if (q.status === 'CONVERTED') throw conflict('Quotation already converted to a booking');
  req.db.run("UPDATE quotations SET status = ?, updated_at = datetime('now') WHERE id = ?", req.body.status, id);
  audit(req.db, req, 'quotation.status', 'quotation', q.number, req.body);
  res.json(quoteRow(req.db, id));
});

// Convert an accepted / sent quotation into a booking at the quoted service; re-prices at today's tariff.
r.post('/:id/convert', WRITE, validate(z.object({
  customer_id: z.coerce.number().int().positive().optional(),
  payment_mode: z.enum(['ACCOUNT', 'CASH', 'PREPAID']).optional(),
})), (req, res) => {
  const id = idParam(req);
  const out = req.db.tx(() => {
    const q = inEntity(req, quoteRow(req.db, id), 'Quotation');
    if (q.status === 'CONVERTED') throw conflict('Already converted');
    if (q.status === 'REJECTED') throw conflict('Quotation was rejected');
    if (q.expired) throw conflict('Quotation has expired — create a new quote');
    let customerId = req.body.customer_id || q.customer_id;
    if (!customerId) {
      // New cash customer from the quotation contact (UK ERP behaviour: account created on first booking).
      const code = `C${String(nextSeq(req.db, 'customer')).padStart(5, '0')}`;
      customerId = Number(req.db.run(
        `INSERT INTO customers (code, entity_code, country, name, type, phone, email, address, city) VALUES (?,?,?,?, 'CASH', ?, ?, ?, ?)`,
        code, q.entity_code, q.entity_code, q.contact_name, q.contact_phone, q.contact_email, q.payload.shipper_address, q.origin_city).lastInsertRowid);
      if (q.lead_id) req.db.run("UPDATE leads SET customer_id = ?, stage = 'WON', probability = 100 WHERE id = ?", customerId, q.lead_id);
    }
    const cust = req.db.get('SELECT * FROM customers WHERE id = ?', customerId);
    if (!cust || cust.entity_code !== q.entity_code) throw badRequest('Customer must belong to the quotation region');
    const s = createShipment(req.db, req, { ...q.payload, customer_id: customerId, quotation_id: q.id, save_receiver: true },
      { paymentMode: req.body.payment_mode });
    req.db.run("UPDATE quotations SET status = 'CONVERTED', shipment_id = ?, customer_id = ?, updated_at = datetime('now') WHERE id = ?", s.id, customerId, id);
    if (q.enquiry_id) {
      req.db.run("UPDATE shipments SET enquiry_id = ?, pickup_date = date('now') WHERE id = ?", q.enquiry_id, s.id);
      req.db.run("UPDATE enquiries SET status = 'BOOKED', shipment_id = ?, customer_id = ?, updated_at = datetime('now') WHERE id = ?", s.id, customerId, q.enquiry_id);
      req.db.run("INSERT INTO enquiry_messages (enquiry_id, direction, body, user_id) VALUES (?, 'SYSTEM', ?, ?)", q.enquiry_id, `Quotation accepted — booked as ${s.awb}`, req.user.id);
    }
    audit(req.db, req, 'quotation.convert', 'quotation', q.number, { awb: s.awb });
    return { quotation: quoteRow(req.db, id), shipment: shipmentDetail(req.db, s.id) };
  });
  res.status(201).json(out);
});

// ---------------- Saved receivers (staff) ----------------
const receiverInput = z.object({
  name: zText(120), company: z.string().trim().max(120).optional(),
  phone: zPhone, whatsapp: z.string().trim().max(30).optional(), email: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().email().optional()),
  country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/), state: z.string().trim().max(60).optional(), district: z.string().trim().max(60).optional(),
  city: zText(80), postcode: z.string().trim().max(20).optional(), address: zText(300),
  tax_id: z.string().trim().max(40).optional(), national_id: z.string().trim().max(40).optional(), relation: z.string().trim().max(40).optional(),
});

export function receiverRoutes(router, { resolveCustomer }) {
  router.get('/receivers', (req, res) => {
    const cid = resolveCustomer(req);
    const q = `%${String(req.query.q || '').slice(0, 40)}%`;
    res.json(req.db.all(
      `SELECT * FROM receivers WHERE customer_id = ? AND (name LIKE ? OR phone LIKE ? OR city LIKE ?) ORDER BY last_used_at DESC, name LIMIT 100`,
      cid, q, q, q));
  });
  router.post('/receivers', validate(receiverInput), (req, res) => {
    const cid = resolveCustomer(req);
    const b = req.body;
    const ins = req.db.run(
      `INSERT INTO receivers (customer_id, name, company, phone, whatsapp, email, country, state, district, city, postcode, address, tax_id, national_id, relation)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, cid, b.name, b.company ?? null, b.phone, b.whatsapp ?? null, b.email ?? null, b.country,
      b.state ?? null, b.district ?? null, b.city, b.postcode ?? null, b.address, b.tax_id ?? null, b.national_id ?? null, b.relation ?? null);
    res.status(201).json(req.db.get('SELECT * FROM receivers WHERE id = ?', Number(ins.lastInsertRowid)));
  });
  router.delete('/receivers/:rid', (req, res) => {
    const cid = resolveCustomer(req);
    const rid = Number(req.params.rid);
    const row = req.db.get('SELECT id FROM receivers WHERE id = ? AND customer_id = ?', rid, cid);
    if (!row) throw notFound('Receiver');
    req.db.run('DELETE FROM receivers WHERE id = ?', rid);
    res.json({ ok: true });
  });
}

const staffCustomer = (req) => {
  const cid = Number(req.params.cid);
  inEntity(req, req.db.get('SELECT id, entity_code FROM customers WHERE id = ?', cid), 'Customer');
  return cid;
};
const cr = Router({ mergeParams: true });
cr.use(READ);
receiverRoutes(cr, { resolveCustomer: staffCustomer });
r.use('/customers/:cid', cr);

// ---------------- KYC documents (staff only) ----------------
const docInput = z.object({
  owner_type: z.enum(['CUSTOMER', 'RECEIVER', 'SHIPMENT']),
  owner_id: z.coerce.number().int().positive(),
  doc_type: z.enum(['PASSPORT', 'EMIRATES_ID', 'CITIZEN_CARD', 'NATIONAL_ID', 'DRIVING_LICENCE', 'RESIDENCE_PERMIT', 'TRADE_LICENCE', 'OTHER']),
  doc_no: z.string().trim().max(40).optional(),
  expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  front_image: zDataImage(1_500_000).optional(),
  back_image: zDataImage(1_500_000).optional(),
});

function ownerEntity(db, type, id) {
  if (type === 'CUSTOMER') return db.get('SELECT entity_code FROM customers WHERE id = ?', id);
  if (type === 'SHIPMENT') return db.get('SELECT entity_code FROM shipments WHERE id = ?', id);
  return db.get('SELECT c.entity_code FROM receivers r JOIN customers c ON c.id = r.customer_id WHERE r.id = ?', id);
}

r.post('/documents', requireRole('ADMIN', 'OPS', 'SALES', 'FINANCE'), validate(docInput), (req, res) => {
  const b = req.body;
  inEntity(req, ownerEntity(req.db, b.owner_type, b.owner_id), b.owner_type.toLowerCase());
  if (b.expiry && b.expiry < today()) throw badRequest('Document has expired');
  const ins = req.db.run(
    'INSERT INTO documents (owner_type, owner_id, doc_type, doc_no, expiry, front_image, back_image, created_by) VALUES (?,?,?,?,?,?,?,?)',
    b.owner_type, b.owner_id, b.doc_type, b.doc_no ?? null, b.expiry ?? null, b.front_image ?? null, b.back_image ?? null, req.user.id);
  audit(req.db, req, 'kyc.upload', b.owner_type.toLowerCase(), b.owner_id, { doc_type: b.doc_type });
  res.status(201).json({ id: Number(ins.lastInsertRowid) });
});

r.get('/documents', READ, (req, res) => {
  const type = String(req.query.owner_type || '');
  const id = Number(req.query.owner_id);
  if (!['CUSTOMER', 'RECEIVER', 'SHIPMENT'].includes(type) || !id) throw badRequest('owner_type and owner_id required');
  inEntity(req, ownerEntity(req.db, type, id), type.toLowerCase());
  res.json(req.db.all(
    `SELECT d.id, d.doc_type, d.doc_no, d.expiry, (d.front_image IS NOT NULL) AS has_front, (d.back_image IS NOT NULL) AS has_back,
            d.created_at, u.name AS created_by_name, CASE WHEN d.expiry IS NOT NULL AND d.expiry < date('now') THEN 1 ELSE 0 END AS expired
       FROM documents d LEFT JOIN users u ON u.id = d.created_by WHERE d.owner_type = ? AND d.owner_id = ? ORDER BY d.id DESC`, type, id));
});

// Image view is audited (KYC data access).
r.get('/documents/:id/:side', requireRole('ADMIN', 'OPS', 'FINANCE'), (req, res) => {
  if (!['front', 'back'].includes(req.params.side)) throw notFound('Image');
  const d = req.db.get('SELECT * FROM documents WHERE id = ?', idParam(req));
  if (!d) throw notFound('Document');
  inEntity(req, ownerEntity(req.db, d.owner_type, d.owner_id), 'Document');
  const img = req.params.side === 'front' ? d.front_image : d.back_image;
  if (!img) throw notFound('Image');
  audit(req.db, req, 'kyc.view', 'document', d.id, { side: req.params.side });
  res.json({ image: img });
});

export default r;
