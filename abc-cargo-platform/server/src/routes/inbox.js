// Agent inbox: omnichannel enquiries (PABX call, WhatsApp, email, social, website, walk-in, referral).
// Lead type decides the next step: COLLECTION is booked straight away and auto-assigned to the nearest free
// driver; QUOTE goes to a direct quotation; other types stay in the inbox until actioned or closed.
import { Router } from 'express';
import { z } from 'zod';
import { audit, nextSeq } from '../db.js';
import { requireRole } from '../lib/auth.js';
import { createShipment, shipmentDetail } from '../lib/shipments.js';
import { SERVICES } from '../lib/pricing.js';
import { autoAssign } from '../lib/pickups.js';
import { validate, idParam, conflict, badRequest, zText, zPhone, optNum, zLat, zLng, paginate } from '../lib/util.js';
import { inEntity, entityForWrite } from '../lib/entity.js';

const r = Router();
r.use(requireRole('ADMIN', 'OPS', 'SALES', 'FINANCE'));

export const CHANNELS = ['WEBSITE', 'WHATSAPP', 'FACEBOOK', 'INSTAGRAM', 'LINKEDIN', 'TIKTOK', 'EMAIL', 'PHONE', 'WALKIN', 'REFERRAL'];
export const LEAD_TYPES = { COLLECTION: 'Collection booking', QUOTE: 'Quote request', GENERAL: 'General enquiry', TRACKING: 'Tracking enquiry', COMPLAINT: 'Complaint' };
export const ID_TYPES = ['Passport', 'National ID', 'Driving licence', 'Residence permit', 'Emirates ID', 'Iqama', 'Aadhaar'];

const opt = (n) => z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().trim().max(n).optional());
const optEmail = z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().trim().email().max(160).optional());
const optPhone = z.preprocess((v) => (v === '' || v === null || v === '+44' || v === '+971' || v === '+966' || v === '+91' ? undefined : v), zPhone.optional());
const optDate = z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional());
const country = z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/).optional());

const enquiryFields = {
  channel: z.enum(CHANNELS),
  lead_type: z.enum(Object.keys(LEAD_TYPES)),
  customer_name: zText(120),
  mobile: zPhone,
  whatsapp: optPhone, landline: optPhone, alt_phone: optPhone,
  email: optEmail,
  id_type: opt(40), id_number: opt(40), id_expiry: optDate,
  agent_code: opt(30), country, postcode: opt(20),
  address1: opt(200), address2: opt(200), address3: opt(200), city: opt(80), district: opt(80), region: opt(80),
  lat: zLat, lng: zLng,
  service: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.enum(Object.keys(SERVICES)).optional()),
  dest_country: country, dest_city: opt(80),
  pieces: optNum(z.coerce.number().int().min(1).max(9999)),
  weight_kg: optNum(z.coerce.number().positive().max(50000)),
  contents: opt(500),
  receiver_name: opt(120), receiver_phone: optPhone, receiver_address: opt(300),
  pickup_date: optDate, pickup_window: opt(40),
  description: zText(2000),
  next_action_at: opt(25),
  owner_id: optNum(z.coerce.number().int().positive()),
  entity_code: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/).optional()),
};
const enquiryInput = z.object({ ...enquiryFields, auto_book: z.boolean().default(true) });
const FIELDS = Object.keys(enquiryFields).filter((k) => k !== 'entity_code');

const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
function msg(db, req, enquiryId, direction, body, channel = null) {
  db.run('INSERT INTO enquiry_messages (enquiry_id, direction, channel, body, user_id) VALUES (?,?,?,?,?)',
    enquiryId, direction, channel, body, req.user?.id ?? null);
  db.run("UPDATE enquiries SET updated_at = datetime('now') WHERE id = ?", enquiryId);
}

const LIST_COLS = `e.*, u.name AS owner_name,
  (SELECT body FROM enquiry_messages m WHERE m.enquiry_id = e.id ORDER BY m.id DESC LIMIT 1) AS last_message,
  (SELECT created_at FROM enquiry_messages m WHERE m.enquiry_id = e.id ORDER BY m.id DESC LIMIT 1) AS last_at,
  CASE WHEN e.status = 'NEW' AND (e.next_action_at IS NULL AND (julianday('now') - julianday(e.created_at)) * 24 > 1
       OR e.next_action_at < datetime('now')) THEN 1 ELSE 0 END AS overdue,
  s.awb, s.status AS shipment_status, q.number AS quotation_number, q.status AS quotation_status, q.total AS quotation_total`;
const LIST_FROM = `FROM enquiries e LEFT JOIN users u ON u.id = e.owner_id LEFT JOIN shipments s ON s.id = e.shipment_id
  LEFT JOIN quotations q ON q.id = e.quotation_id`;

function detail(db, id) {
  const e = db.get(`SELECT ${LIST_COLS}, c.code AS customer_code ${LIST_FROM} LEFT JOIN customers c ON c.id = e.customer_id WHERE e.id = ?`, id);
  if (!e) return null;
  e.messages = db.all(
    `SELECT m.*, u.name AS user_name FROM enquiry_messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.enquiry_id = ? ORDER BY m.id`, id);
  e.shipment = e.shipment_id ? shipmentDetail(db, e.shipment_id) : null;
  e.history = e.mobile ? db.all(
    `SELECT id, ref, lead_type, status, created_at FROM enquiries WHERE entity_code = ? AND mobile = ? AND id <> ? ORDER BY id DESC LIMIT 10`,
    e.entity_code, e.mobile, id) : [];
  return e;
}

r.get('/meta', (_req, res) => res.json({ channels: CHANNELS, lead_types: LEAD_TYPES, id_types: ID_TYPES }));

r.get('/', (req, res) => {
  const { limit, offset } = paginate(req.query);
  const where = ['1=1'];
  const args = [];
  if (req.entity) { where.push('e.entity_code = ?'); args.push(req.entity); }
  const view = req.query.view || 'open';
  if (view === 'open') where.push("e.status IN ('NEW','QUOTED')");
  if (view === 'mine') { where.push("e.owner_id = ? AND e.status IN ('NEW','QUOTED')"); args.push(req.user.id); }
  if (view === 'booked') where.push("e.status = 'BOOKED'");
  if (view === 'lost') where.push("e.status IN ('LOST','CLOSED')");
  if (req.query.channel && CHANNELS.includes(req.query.channel)) { where.push('e.channel = ?'); args.push(req.query.channel); }
  if (req.query.q) {
    const q = `%${String(req.query.q).trim()}%`;
    where.push('(e.customer_name LIKE ? OR e.mobile LIKE ? OR e.email LIKE ? OR e.ref LIKE ? OR s.awb LIKE ?)');
    args.push(q, q, q, q, q);
  }
  const sql = `${LIST_FROM} WHERE ${where.join(' AND ')}`;
  res.json({
    rows: req.db.all(`SELECT ${LIST_COLS} ${sql} ORDER BY COALESCE(last_at, e.created_at) DESC LIMIT ? OFFSET ?`, ...args, limit, offset),
    total: req.db.get(`SELECT COUNT(*) AS n ${sql}`, ...args).n,
  });
});

r.get('/stats', (req, res) => {
  const [w, a] = req.entity ? ['WHERE e.entity_code = ?', [req.entity]] : ['', []];
  const s = req.db.get(
    `SELECT SUM(e.status = 'NEW') AS new_count, SUM(e.status = 'QUOTED') AS quoted,
            SUM(e.status = 'BOOKED' AND date(s.created_at) = date('now')) AS booked_today,
            SUM(e.status = 'BOOKED') AS booked, SUM(e.status = 'LOST') AS lost,
            ROUND(SUM(CASE WHEN e.status = 'QUOTED' THEN q.total ELSE 0 END), 2) AS quotes_value,
            ROUND(SUM(CASE WHEN e.status = 'BOOKED' AND date(s.created_at) = date('now') THEN s.total_charge ELSE 0 END), 2) AS booked_value
       FROM enquiries e LEFT JOIN shipments s ON s.id = e.shipment_id LEFT JOIN quotations q ON q.id = e.quotation_id ${w}`, ...a);
  const decided = (s.booked || 0) + (s.lost || 0);
  const byChannel = req.db.all(`SELECT e.channel, COUNT(*) AS n FROM enquiries e ${w} GROUP BY e.channel`, ...a);
  res.json({ ...s, win_rate: decided ? Math.round(((s.booked || 0) / decided) * 100) : null, by_channel: byChannel });
});

r.get('/duplicates', (req, res) => {
  const ent = entityForWrite(req, req.query.entity);
  const mobile = String(req.query.mobile || '').trim();
  const email = String(req.query.email || '').trim().toLowerCase();
  if (mobile.length < 7 && !email) return res.json({ enquiries: [], customers: [] });
  res.json({
    enquiries: req.db.all(
      `SELECT id, ref, customer_name, mobile, email, status, lead_type, created_at FROM enquiries
        WHERE entity_code = ? AND ((? <> '' AND mobile = ?) OR (? <> '' AND lower(email) = ?)) ORDER BY id DESC LIMIT 10`,
      ent, mobile, mobile, email, email),
    customers: req.db.all(
      `SELECT id, code, name, phone, email, type FROM customers
        WHERE entity_code = ? AND active = 1 AND ((? <> '' AND (phone = ? OR whatsapp = ?)) OR (? <> '' AND lower(email) = ?)) LIMIT 10`,
      ent, mobile, mobile, mobile, email, email),
  });
});

function insertEnquiry(req, b, entity) {
  const ref = `ENQ-${entity}-${String(nextSeq(req.db, `enquiry_${entity}`)).padStart(6, '0')}`;
  const cols = FIELDS.filter((k) => b[k] !== undefined);
  const ins = req.db.run(
    `INSERT INTO enquiries (ref, entity_code, created_by, ${cols.join(', ')}) VALUES (?, ?, ?, ${cols.map(() => '?').join(', ')})`,
    ref, entity, req.user.id, ...cols.map((k) => b[k]));
  return { id: Number(ins.lastInsertRowid), ref };
}

/** Fields a collection booking needs before it can be created and dispatched. */
export function missingForBooking(e) {
  const need = { address1: 'collection address', city: 'collection city', service: 'service', dest_country: 'destination country',
    dest_city: 'destination city', weight_kg: 'approx. weight', receiver_name: 'receiver name', receiver_phone: 'receiver phone' };
  return Object.entries(need).filter(([k]) => !e[k]).map(([, label]) => label);
}

function bookCollection(req, e) {
  const missing = missingForBooking(e);
  if (missing.length) throw badRequest(`To book the collection, add: ${missing.join(', ')}`);
  if (e.shipment_id) throw conflict('Collection already booked');
  const ent = e.entity_code;
  let customerId = e.customer_id;
  if (!customerId) {
    const found = req.db.get(
      'SELECT id FROM customers WHERE entity_code = ? AND active = 1 AND (phone = ? OR whatsapp = ?) ORDER BY id LIMIT 1', ent, e.mobile, e.mobile);
    customerId = found?.id;
  }
  const address = [e.address1, e.address2, e.address3, e.district, e.postcode].filter(Boolean).join(', ');
  if (!customerId) {
    const code = `C${String(nextSeq(req.db, 'customer')).padStart(5, '0')}`;
    customerId = Number(req.db.run(
      `INSERT INTO customers (code, entity_code, country, name, type, phone, whatsapp, email, address, city, postcode, agent_code, lat, lng)
       VALUES (?,?,?,?, 'CASH', ?,?,?,?,?,?,?,?,?)`,
      code, ent, ent, e.customer_name, e.mobile, e.whatsapp ?? null, e.email ?? null, address, e.city, e.postcode ?? null,
      e.agent_code ?? null, e.lat ?? null, e.lng ?? null).lastInsertRowid);
  }
  const intl = (e.dest_country || ent) !== ent;
  const s = createShipment(req.db, req, {
    customer_id: customerId, service: e.service, origin_city: e.city, dest_city: e.dest_city, dest_country: e.dest_country,
    pieces: e.pieces || 1, weight: e.weight_kg, product: 'PARCEL',
    shipper_name: e.customer_name, shipper_phone: e.mobile, shipper_address: address,
    consignee_name: e.receiver_name, consignee_phone: e.receiver_phone, consignee_address: e.receiver_address || e.dest_city,
    description: e.contents || null, pickup_window: e.pickup_window || null, pickup_lat: e.lat ?? undefined, pickup_lng: e.lng ?? undefined,
    agent_code: e.agent_code || undefined, reference: e.ref,
    sender_id_type: e.id_type || undefined, sender_id_no: e.id_number || undefined, sender_id_expiry: e.id_expiry || undefined,
    // Boxes are weighed and contents itemised at collection; record a provisional line so customs can be completed then.
    items: intl ? [{ description: e.contents || 'Contents to be itemised at collection', qty: e.pieces || 1, unit_value: 0, origin_country: ent }] : [],
  }, { paymentMode: 'CASH' });
  req.db.run('UPDATE shipments SET pickup_date = ?, enquiry_id = ? WHERE id = ?', e.pickup_date || new Date().toISOString().slice(0, 10), e.id, s.id);
  const driver = autoAssign(req.db, req, req.db.get('SELECT * FROM shipments WHERE id = ?', s.id));
  req.db.run("UPDATE enquiries SET status = 'BOOKED', shipment_id = ?, customer_id = ?, updated_at = datetime('now') WHERE id = ?", s.id, customerId, e.id);
  msg(req.db, req, e.id, 'SYSTEM', `Collection booked — ${s.awb}. ${driver ? `Driver ${driver.name} auto-assigned${driver.km != null ? ` (${driver.km} km)` : ''}.` : 'No free driver — waiting for dispatch.'}`);
  audit(req.db, req, 'enquiry.book', 'enquiry', e.ref, { awb: s.awb, driver: driver?.id ?? null });
  return { awb: s.awb, driver };
}

r.post('/', validate(enquiryInput), (req, res) => {
  const b = req.body;
  const entity = entityForWrite(req, b.entity_code);
  const out = req.db.tx(() => {
    const { id } = insertEnquiry(req, { ...b, owner_id: b.owner_id ?? req.user.id, whatsapp: b.whatsapp ?? b.mobile, country: b.country ?? entity }, entity);
    msg(req.db, req, id, 'SYSTEM', `Enquiry logged via ${b.channel.toLowerCase()} — ${LEAD_TYPES[b.lead_type]}`);
    msg(req.db, req, id, 'IN', b.description, b.channel);
    const e = req.db.get('SELECT * FROM enquiries WHERE id = ?', id);
    audit(req.db, req, 'enquiry.create', 'enquiry', e.ref, { channel: b.channel, type: b.lead_type });
    let booking = null;
    if (b.lead_type === 'COLLECTION' && b.auto_book && !missingForBooking(e).length) booking = bookCollection(req, e);
    return { ...detail(req.db, id), booking };
  });
  res.status(201).json(out);
});

// Incoming contact from PABX / WhatsApp / email (same contract a channel webhook adapter calls).
// Threads into the caller's open enquiry when one exists, otherwise opens a new general enquiry.
r.post('/incoming', validate(z.object({
  channel: z.enum(['PHONE', 'WHATSAPP', 'EMAIL']),
  from: z.string().trim().min(3).max(160),
  name: opt(120),
  body: zText(2000),
  entity_code: enquiryFields.entity_code,
})), (req, res) => {
  const b = req.body;
  const entity = entityForWrite(req, b.entity_code);
  const isEmail = b.channel === 'EMAIL';
  if (isEmail ? !z.string().email().safeParse(b.from).success : !zPhone.safeParse(b.from).success) throw badRequest(isEmail ? 'Invalid email address' : 'Invalid phone number');
  const out = req.db.tx(() => {
    const open = req.db.get(
      `SELECT id FROM enquiries WHERE entity_code = ? AND status IN ('NEW','QUOTED') AND ${isEmail ? 'lower(email) = lower(?)' : '(mobile = ? OR whatsapp = ?)'}
        ORDER BY id DESC LIMIT 1`, entity, b.from, ...(isEmail ? [] : [b.from]));
    let id = open?.id;
    if (!id) {
      const known = req.db.get(`SELECT name, phone, email FROM customers WHERE entity_code = ? AND ${isEmail ? 'lower(email) = lower(?)' : '(phone = ? OR whatsapp = ?)'} LIMIT 1`,
        entity, b.from, ...(isEmail ? [] : [b.from]));
      ({ id } = insertEnquiry(req, {
        channel: b.channel, lead_type: 'GENERAL', customer_name: b.name || known?.name || b.from,
        mobile: isEmail ? (known?.phone || 'unknown') : b.from, whatsapp: b.channel === 'WHATSAPP' ? b.from : undefined,
        email: isEmail ? b.from : known?.email ?? undefined, description: b.body, country: entity, owner_id: req.user.id,
      }, entity));
      msg(req.db, req, id, 'SYSTEM', `New ${b.channel === 'PHONE' ? 'call' : b.channel.toLowerCase()} from ${b.from}`);
    }
    msg(req.db, req, id, 'IN', b.body, b.channel);
    return detail(req.db, id);
  });
  res.status(201).json(out);
});

r.get('/:id', (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) return next();
  res.json(inEntity(req, detail(req.db, idParam(req)), 'Enquiry'));
});

const load = (req) => inEntity(req, req.db.get('SELECT * FROM enquiries WHERE id = ?', idParam(req)), 'Enquiry');

r.put('/:id', validate(z.object(enquiryFields).partial()), (req, res) => {
  const e = load(req);
  const b = req.body;
  const cols = FIELDS.filter((k) => b[k] !== undefined);
  if (cols.length) {
    req.db.run(`UPDATE enquiries SET ${cols.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`, ...cols.map((k) => b[k]), e.id);
    msg(req.db, req, e.id, 'SYSTEM', 'Lead details saved');
  }
  res.json(detail(req.db, e.id));
});

r.post('/:id/messages', validate(z.object({ body: zText(2000), note: z.boolean().default(false) })), (req, res) => {
  const e = load(req);
  // Outbound delivery (WhatsApp Business API / SMTP / PABX) is not connected yet; replies are logged on the thread.
  msg(req.db, req, e.id, req.body.note ? 'NOTE' : 'OUT', req.body.body, req.body.note ? null : e.channel);
  res.status(201).json(detail(req.db, e.id));
});

r.post('/:id/callback', validate(z.object({ at: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/) })), (req, res) => {
  const e = load(req);
  const at = req.body.at.replace('T', ' ').slice(0, 16);
  req.db.run("UPDATE enquiries SET next_action_at = ?, updated_at = datetime('now') WHERE id = ?", at, e.id);
  msg(req.db, req, e.id, 'SYSTEM', `Callback set for ${at}`);
  res.json(detail(req.db, e.id));
});

r.post('/:id/lost', validate(z.object({ reason: zText(200) })), (req, res) => {
  const e = load(req);
  if (e.status === 'BOOKED') throw conflict('Booked enquiries cannot be marked lost — cancel the booking instead');
  req.db.run("UPDATE enquiries SET status = 'LOST', lost_reason = ?, updated_at = datetime('now') WHERE id = ?", req.body.reason, e.id);
  msg(req.db, req, e.id, 'SYSTEM', `Marked lost: ${req.body.reason}`);
  audit(req.db, req, 'enquiry.lost', 'enquiry', e.ref, { reason: req.body.reason });
  res.json(detail(req.db, e.id));
});

r.post('/:id/close', (req, res) => {
  const e = load(req);
  if (!['NEW', 'QUOTED'].includes(e.status)) throw conflict(`Enquiry is ${e.status}`);
  req.db.run("UPDATE enquiries SET status = 'CLOSED', updated_at = datetime('now') WHERE id = ?", e.id);
  msg(req.db, req, e.id, 'SYSTEM', 'Enquiry closed — resolved');
  res.json(detail(req.db, e.id));
});

r.post('/:id/reopen', (req, res) => {
  const e = load(req);
  if (!['LOST', 'CLOSED'].includes(e.status)) throw conflict(`Enquiry is ${e.status}`);
  req.db.run("UPDATE enquiries SET status = ?, lost_reason = NULL, updated_at = datetime('now') WHERE id = ?", e.quotation_id ? 'QUOTED' : 'NEW', e.id);
  msg(req.db, req, e.id, 'SYSTEM', 'Enquiry reopened');
  res.json(detail(req.db, e.id));
});

r.post('/:id/book', requireRole('ADMIN', 'OPS', 'SALES'), (req, res) => {
  const out = req.db.tx(() => {
    const e = load(req);
    if (!['NEW', 'QUOTED'].includes(e.status)) throw conflict(`Enquiry is ${e.status}`);
    const booking = bookCollection(req, e);
    return { ...detail(req.db, e.id), booking };
  });
  res.status(201).json(out);
});

export default r;
