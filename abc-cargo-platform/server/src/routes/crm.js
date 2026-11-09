// CRM: leads & sales pipeline, lead→customer conversion, contacts, activities/tasks,
// support tickets with SLA, and a Customer 360 view.
import { Router } from 'express';
import { z } from 'zod';
import { audit, nextSeq } from '../db.js';
import { requireRole } from '../lib/auth.js';
import { round2 } from '../lib/pricing.js';
import { validate, idParam, notFound, conflict, zText, zPhone, paginate } from '../lib/util.js';

const r = Router();
const CRM = requireRole('ADMIN', 'SALES', 'OPS', 'FINANCE');
const SALES = requireRole('ADMIN', 'SALES');
const SUPPORT = requireRole('ADMIN', 'OPS', 'SALES', 'FINANCE');

export const STAGES = ['NEW', 'CONTACTED', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST'];
const STAGE_PROB = { NEW: 10, CONTACTED: 20, QUALIFIED: 40, PROPOSAL: 60, NEGOTIATION: 80, WON: 100, LOST: 0 };
export const SLA_HOURS = { URGENT: 4, HIGH: 8, MEDIUM: 24, LOW: 72 };

const optEmail = z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().trim().email().max(160).optional());
const optPhone = z.preprocess((v) => (v === '' || v === null ? undefined : v), zPhone.optional());

// ---------------- Leads / pipeline ----------------
const leadInput = z.object({
  company: zText(160),
  contact_name: zText(120),
  phone: optPhone,
  email: optEmail,
  city: z.string().trim().max(60).optional(),
  source: z.enum(['WEBSITE', 'REFERRAL', 'COLD_CALL', 'WALK_IN', 'EXHIBITION', 'SOCIAL', 'OTHER']).default('OTHER'),
  stage: z.enum(STAGES).optional(),
  est_monthly_shipments: z.coerce.number().int().min(0).max(1_000_000).default(0),
  est_monthly_value: z.coerce.number().min(0).max(100_000_000).default(0),
  expected_close: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  owner_id: z.coerce.number().int().positive().optional(),
  notes: z.string().trim().max(2000).optional(),
});

r.get('/leads', CRM, (req, res) => {
  const where = [];
  const args = [];
  if (req.query.stage) { where.push('l.stage = ?'); args.push(String(req.query.stage)); }
  if (req.query.owner_id) { where.push('l.owner_id = ?'); args.push(Number(req.query.owner_id)); }
  if (req.query.q) { where.push('(l.company LIKE ? OR l.contact_name LIKE ? OR l.phone LIKE ?)'); args.push(...Array(3).fill(`%${req.query.q}%`)); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  res.json(req.db.all(
    `SELECT l.*, u.name AS owner_name,
            (SELECT MIN(due_at) FROM activities a WHERE a.entity = 'LEAD' AND a.entity_id = l.id AND a.done = 0) AS next_action_at
       FROM leads l LEFT JOIN users u ON u.id = l.owner_id ${w} ORDER BY l.updated_at DESC LIMIT 500`, ...args));
});

r.get('/pipeline', CRM, (req, res) => {
  const stages = req.db.all(
    `SELECT stage, COUNT(*) AS count, ROUND(SUM(est_monthly_value), 2) AS value,
            ROUND(SUM(est_monthly_value * probability / 100.0), 2) AS weighted
       FROM leads GROUP BY stage`);
  const by = Object.fromEntries(stages.map((s) => [s.stage, s]));
  const won = by.WON?.count || 0;
  const lost = by.LOST?.count || 0;
  res.json({
    stages: STAGES.map((s) => by[s] || { stage: s, count: 0, value: 0, weighted: 0 }),
    open_weighted: round2(STAGES.filter((s) => !['WON', 'LOST'].includes(s)).reduce((a, s) => a + (by[s]?.weighted || 0), 0)),
    win_rate: won + lost ? Math.round((won / (won + lost)) * 100) : null,
  });
});

r.post('/leads', SALES, validate(leadInput), (req, res) => {
  const b = req.body;
  const stage = b.stage || 'NEW';
  const ins = req.db.run(
    `INSERT INTO leads (company, contact_name, phone, email, city, source, stage, est_monthly_shipments, est_monthly_value,
                        probability, expected_close, owner_id, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    b.company, b.contact_name, b.phone ?? null, b.email ?? null, b.city ?? null, b.source, stage, b.est_monthly_shipments,
    b.est_monthly_value, STAGE_PROB[stage], b.expected_close ?? null, b.owner_id ?? req.user.id, b.notes ?? null);
  audit(req.db, req, 'lead.create', 'lead', ins.lastInsertRowid, { company: b.company });
  res.status(201).json(req.db.get('SELECT * FROM leads WHERE id = ?', Number(ins.lastInsertRowid)));
});

r.get('/leads/:id', CRM, (req, res) => {
  const id = idParam(req);
  const lead = req.db.get('SELECT l.*, u.name AS owner_name FROM leads l LEFT JOIN users u ON u.id = l.owner_id WHERE l.id = ?', id);
  if (!lead) throw notFound('Lead');
  lead.activities = activitiesFor(req.db, 'LEAD', id);
  res.json(lead);
});

r.patch('/leads/:id', SALES, validate(leadInput.partial().extend({ lost_reason: z.string().trim().max(200).optional() })), (req, res) => {
  const id = idParam(req);
  const lead = req.db.get('SELECT * FROM leads WHERE id = ?', id);
  if (!lead) throw notFound('Lead');
  if (lead.stage === 'WON') throw conflict('Lead already converted to a customer');
  if (req.body.stage === 'WON') throw conflict('Use "Convert to customer" to win a lead');
  if (req.body.stage === 'LOST' && !req.body.lost_reason && !lead.lost_reason) throw conflict('Lost reason is required');
  const fields = Object.fromEntries(Object.entries(req.body).filter(([, v]) => v !== undefined));
  if (fields.stage) fields.probability = STAGE_PROB[fields.stage];
  const keys = Object.keys(fields);
  if (keys.length) {
    req.db.run(`UPDATE leads SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
      ...keys.map((k) => fields[k] ?? null), id);
    if (fields.stage && fields.stage !== lead.stage) {
      logActivity(req, 'LEAD', id, 'NOTE', `Stage changed ${lead.stage} → ${fields.stage}`, fields.lost_reason, true);
    }
  }
  audit(req.db, req, 'lead.update', 'lead', id, fields);
  res.json(req.db.get('SELECT * FROM leads WHERE id = ?', id));
});

// Convert a qualified lead into an ACCOUNT (credit) or CASH customer, with primary contact.
r.post('/leads/:id/convert', SALES, validate(z.object({
  type: z.enum(['ACCOUNT', 'CASH']).default('ACCOUNT'),
  credit_limit: z.coerce.number().min(0).max(10_000_000).default(0),
  payment_terms_days: z.coerce.number().int().min(0).max(120).default(30),
  trn: z.string().trim().max(20).optional(),
  address: z.string().trim().max(300).optional(),
})), (req, res) => {
  const id = idParam(req);
  const out = req.db.tx(() => {
    const lead = req.db.get('SELECT * FROM leads WHERE id = ?', id);
    if (!lead) throw notFound('Lead');
    if (lead.customer_id) throw conflict('Lead already converted');
    const code = `C${String(nextSeq(req.db, 'customer')).padStart(5, '0')}`;
    const c = req.db.run(
      `INSERT INTO customers (code, name, type, phone, email, address, city, trn, credit_limit, payment_terms_days, account_manager_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      code, lead.company, req.body.type, lead.phone, lead.email, req.body.address ?? null, lead.city, req.body.trn ?? null,
      req.body.credit_limit, req.body.payment_terms_days, lead.owner_id ?? req.user.id);
    const cid = Number(c.lastInsertRowid);
    req.db.run('INSERT INTO contacts (customer_id, name, phone, email, is_primary) VALUES (?, ?, ?, ?, 1)', cid, lead.contact_name, lead.phone, lead.email);
    req.db.run("UPDATE leads SET stage = 'WON', probability = 100, customer_id = ?, updated_at = datetime('now') WHERE id = ?", cid, id);
    logActivity(req, 'LEAD', id, 'NOTE', `Converted to customer ${code}`, null, true);
    logActivity(req, 'CUSTOMER', cid, 'NOTE', 'Account opened from CRM lead', lead.notes, true);
    audit(req.db, req, 'lead.convert', 'customer', code, { lead_id: id });
    return req.db.get('SELECT * FROM customers WHERE id = ?', cid);
  });
  res.status(201).json(out);
});

// ---------------- Contacts ----------------
r.get('/customers/:id/contacts', CRM, (req, res) => {
  res.json(req.db.all('SELECT * FROM contacts WHERE customer_id = ? ORDER BY is_primary DESC, name', idParam(req)));
});
r.post('/customers/:id/contacts', CRM, validate(z.object({
  name: zText(120), title: z.string().trim().max(80).optional(), phone: optPhone, email: optEmail, is_primary: z.boolean().default(false),
})), (req, res) => {
  const cid = idParam(req);
  if (!req.db.get('SELECT id FROM customers WHERE id = ?', cid)) throw notFound('Customer');
  const b = req.body;
  const out = req.db.tx(() => {
    if (b.is_primary) req.db.run('UPDATE contacts SET is_primary = 0 WHERE customer_id = ?', cid);
    const ins = req.db.run('INSERT INTO contacts (customer_id, name, title, phone, email, is_primary) VALUES (?,?,?,?,?,?)',
      cid, b.name, b.title ?? null, b.phone ?? null, b.email ?? null, b.is_primary ? 1 : 0);
    return req.db.get('SELECT * FROM contacts WHERE id = ?', Number(ins.lastInsertRowid));
  });
  res.status(201).json(out);
});
r.delete('/contacts/:id', CRM, (req, res) => {
  req.db.run('DELETE FROM contacts WHERE id = ?', idParam(req));
  res.json({ ok: true });
});

// ---------------- Activities / tasks ----------------
function activitiesFor(db, entity, id) {
  return db.all(
    `SELECT a.*, u.name AS owner_name FROM activities a LEFT JOIN users u ON u.id = a.owner_id
      WHERE a.entity = ? AND a.entity_id = ? ORDER BY a.done, COALESCE(a.due_at, a.created_at) DESC`, entity, id);
}
function logActivity(req, entity, id, type, subject, notes, done = false, dueAt = null) {
  req.db.run('INSERT INTO activities (entity, entity_id, type, subject, notes, due_at, done, owner_id) VALUES (?,?,?,?,?,?,?,?)',
    entity, id, type, subject, notes ?? null, dueAt, done ? 1 : 0, req.user.id);
}

r.post('/activities', CRM, validate(z.object({
  entity: z.enum(['LEAD', 'CUSTOMER']),
  entity_id: z.coerce.number().int().positive(),
  type: z.enum(['CALL', 'MEETING', 'EMAIL', 'WHATSAPP', 'NOTE', 'TASK']),
  subject: zText(200),
  notes: z.string().trim().max(2000).optional(),
  due_at: z.string().max(25).optional(),
  done: z.boolean().default(false),
})), (req, res) => {
  const b = req.body;
  const table = b.entity === 'LEAD' ? 'leads' : 'customers';
  if (!req.db.get(`SELECT id FROM ${table} WHERE id = ?`, b.entity_id)) throw notFound(b.entity);
  logActivity(req, b.entity, b.entity_id, b.type, b.subject, b.notes, b.done, b.due_at ?? null);
  if (b.entity === 'LEAD') req.db.run("UPDATE leads SET updated_at = datetime('now'), stage = CASE WHEN stage = 'NEW' THEN 'CONTACTED' ELSE stage END, probability = CASE WHEN stage = 'NEW' THEN 20 ELSE probability END WHERE id = ?", b.entity_id);
  res.status(201).json(activitiesFor(req.db, b.entity, b.entity_id));
});

r.post('/activities/:id/done', CRM, (req, res) => {
  req.db.run('UPDATE activities SET done = 1 WHERE id = ?', idParam(req));
  res.json({ ok: true });
});

// My open tasks / follow-ups (overdue first).
r.get('/tasks', CRM, (req, res) => {
  const mine = req.query.all === '1' ? '' : 'AND a.owner_id = ?';
  res.json(req.db.all(
    `SELECT a.*, CASE a.entity WHEN 'LEAD' THEN l.company ELSE c.name END AS entity_name
       FROM activities a LEFT JOIN leads l ON a.entity = 'LEAD' AND l.id = a.entity_id
       LEFT JOIN customers c ON a.entity = 'CUSTOMER' AND c.id = a.entity_id
      WHERE a.done = 0 AND a.due_at IS NOT NULL ${mine} ORDER BY a.due_at LIMIT 200`, ...(mine ? [req.user.id] : [])));
});

// ---------------- Customer 360 ----------------
r.get('/customers/:id/360', CRM, (req, res) => {
  const id = idParam(req);
  const c = req.db.get('SELECT c.*, u.name AS account_manager FROM customers c LEFT JOIN users u ON u.id = c.account_manager_id WHERE c.id = ?', id);
  if (!c) throw notFound('Customer');
  const kpi = req.db.get(
    `SELECT COUNT(*) AS shipments,
            SUM(CASE WHEN date(created_at) >= date('now','-30 day') THEN 1 ELSE 0 END) AS shipments_30d,
            ROUND(SUM(CASE WHEN status != 'CANCELLED' THEN total_charge ELSE 0 END), 2) AS lifetime_revenue,
            ROUND(SUM(CASE WHEN status != 'CANCELLED' AND date(created_at) >= date('now','-30 day') THEN total_charge ELSE 0 END), 2) AS revenue_30d,
            SUM(CASE WHEN status = 'DELIVERED' THEN 1 ELSE 0 END) AS delivered,
            SUM(CASE WHEN attempts > 0 THEN 1 ELSE 0 END) AS with_failed_attempts,
            MAX(created_at) AS last_shipment_at
       FROM shipments WHERE customer_id = ?`, id);
  const ar = req.db.get(
    `SELECT ROUND(COALESCE(SUM(total - paid), 0), 2) AS outstanding,
            ROUND(COALESCE(SUM(CASE WHEN date(due_date) < date('now') THEN total - paid ELSE 0 END), 0), 2) AS overdue
       FROM invoices WHERE customer_id = ? AND status IN ('UNPAID','PARTIAL')`, id);
  const codPending = req.db.get(
    `SELECT ROUND(COALESCE(SUM(cod_collected), 0), 2) AS t FROM shipments
      WHERE customer_id = ? AND status = 'DELIVERED' AND cod_collected > 0 AND cod_remittance_id IS NULL`, id).t;
  res.json({
    customer: c,
    kpi: { ...kpi, ...ar, cod_pending: codPending, credit_available: c.type === 'ACCOUNT' ? round2(c.credit_limit - ar.outstanding) : null },
    contacts: req.db.all('SELECT * FROM contacts WHERE customer_id = ? ORDER BY is_primary DESC', id),
    activities: activitiesFor(req.db, 'CUSTOMER', id),
    tickets: req.db.all('SELECT id, number, subject, status, priority, created_at FROM tickets WHERE customer_id = ? ORDER BY id DESC LIMIT 20', id),
    recent_shipments: req.db.all('SELECT id, awb, status, dest_city, total_charge, created_at FROM shipments WHERE customer_id = ? ORDER BY id DESC LIMIT 10', id),
    invoices: req.db.all('SELECT id, number, status, total, paid, due_date FROM invoices WHERE customer_id = ? ORDER BY id DESC LIMIT 10', id),
  });
});

// ---------------- Support tickets ----------------
export function createTicket(db, req, t) {
  const number = `TKT-${String(nextSeq(db, 'ticket')).padStart(6, '0')}`;
  const sla = new Date(Date.now() + SLA_HOURS[t.priority || 'MEDIUM'] * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
  const ins = db.run(
    `INSERT INTO tickets (number, customer_id, shipment_id, category, priority, channel, subject, description, created_by, sla_due_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    number, t.customer_id ?? null, t.shipment_id ?? null, t.category, t.priority || 'MEDIUM', t.channel || 'PORTAL',
    t.subject, t.description ?? null, req.user.id, sla);
  audit(db, req, 'ticket.create', 'ticket', number, { category: t.category });
  return db.get('SELECT * FROM tickets WHERE id = ?', Number(ins.lastInsertRowid));
}

export function ticketDetail(db, id, { includeInternal = true } = {}) {
  const t = db.get(
    `SELECT t.*, c.name AS customer_name, s.awb, u.name AS assigned_name,
            CASE WHEN t.status NOT IN ('RESOLVED','CLOSED') AND datetime('now') > t.sla_due_at THEN 1 ELSE 0 END AS sla_breached
       FROM tickets t LEFT JOIN customers c ON c.id = t.customer_id LEFT JOIN shipments s ON s.id = t.shipment_id
       LEFT JOIN users u ON u.id = t.assigned_to WHERE t.id = ?`, id);
  if (!t) return null;
  t.comments = db.all(
    `SELECT tc.id, tc.body, tc.internal, tc.created_at, u.name AS user_name, u.role AS user_role
       FROM ticket_comments tc LEFT JOIN users u ON u.id = tc.user_id
      WHERE tc.ticket_id = ? ${includeInternal ? '' : 'AND tc.internal = 0'} ORDER BY tc.id`, id);
  return t;
}

const ticketInput = z.object({
  customer_id: z.coerce.number().int().positive().optional(),
  awb: z.string().trim().max(20).optional(),
  category: z.enum(['DELAY', 'DAMAGE', 'LOST', 'BILLING', 'PICKUP', 'COD', 'OTHER']),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
  channel: z.enum(['PORTAL', 'PHONE', 'EMAIL', 'WHATSAPP', 'WALK_IN']).default('PHONE'),
  subject: zText(200),
  description: z.string().trim().max(4000).optional(),
});

r.get('/tickets', SUPPORT, (req, res) => {
  const where = [];
  const args = [];
  if (req.query.status) { where.push('t.status = ?'); args.push(String(req.query.status)); }
  if (req.query.open === '1') where.push("t.status NOT IN ('RESOLVED','CLOSED')");
  if (req.query.mine === '1') { where.push('t.assigned_to = ?'); args.push(req.user.id); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { limit, offset } = paginate(req.query);
  res.json(req.db.all(
    `SELECT t.*, c.name AS customer_name, s.awb, u.name AS assigned_name,
            CASE WHEN t.status NOT IN ('RESOLVED','CLOSED') AND datetime('now') > t.sla_due_at THEN 1 ELSE 0 END AS sla_breached
       FROM tickets t LEFT JOIN customers c ON c.id = t.customer_id LEFT JOIN shipments s ON s.id = t.shipment_id
       LEFT JOIN users u ON u.id = t.assigned_to ${w}
      ORDER BY CASE t.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END, t.id DESC
      LIMIT ? OFFSET ?`, ...args, limit, offset));
});

r.post('/tickets', SUPPORT, validate(ticketInput), (req, res) => {
  const b = req.body;
  let shipment = null;
  if (b.awb) {
    shipment = req.db.get('SELECT id, customer_id FROM shipments WHERE awb = ?', b.awb.toUpperCase());
    if (!shipment) throw notFound('Shipment');
  }
  const t = createTicket(req.db, req, { ...b, customer_id: b.customer_id ?? shipment?.customer_id, shipment_id: shipment?.id });
  res.status(201).json(ticketDetail(req.db, t.id));
});

r.get('/tickets/:id', SUPPORT, (req, res) => {
  const t = ticketDetail(req.db, idParam(req));
  if (!t) throw notFound('Ticket');
  res.json(t);
});

r.patch('/tickets/:id', SUPPORT, validate(z.object({
  status: z.enum(['OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED', 'CLOSED']).optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
  assigned_to: z.coerce.number().int().positive().nullable().optional(),
})), (req, res) => {
  const id = idParam(req);
  const t = req.db.get('SELECT * FROM tickets WHERE id = ?', id);
  if (!t) throw notFound('Ticket');
  const f = Object.fromEntries(Object.entries(req.body).filter(([, v]) => v !== undefined));
  if (f.status && ['RESOLVED', 'CLOSED'].includes(f.status) && !t.resolved_at) f.resolved_at = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const keys = Object.keys(f);
  if (keys.length) req.db.run(`UPDATE tickets SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`, ...keys.map((k) => f[k]), id);
  audit(req.db, req, 'ticket.update', 'ticket', t.number, f);
  res.json(ticketDetail(req.db, id));
});

r.post('/tickets/:id/comments', SUPPORT, validate(z.object({ body: zText(4000), internal: z.boolean().default(false) })), (req, res) => {
  const id = idParam(req);
  if (!req.db.get('SELECT id FROM tickets WHERE id = ?', id)) throw notFound('Ticket');
  req.db.run('INSERT INTO ticket_comments (ticket_id, user_id, body, internal) VALUES (?, ?, ?, ?)', id, req.user.id, req.body.body, req.body.internal ? 1 : 0);
  req.db.run("UPDATE tickets SET updated_at = datetime('now'), status = CASE WHEN status = 'OPEN' THEN 'IN_PROGRESS' ELSE status END WHERE id = ?", id);
  res.status(201).json(ticketDetail(req.db, id));
});

export default r;
