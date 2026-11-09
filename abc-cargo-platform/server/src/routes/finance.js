// Billing & finance: invoices, receivables, driver cash settlement, COD remittance.
import { Router } from 'express';
import { z } from 'zod';
import { audit } from '../db.js';
import { requireRole } from '../lib/auth.js';
import { createInvoice, recordInvoicePayment } from '../lib/shipments.js';
import { round2 } from '../lib/pricing.js';
import { validate, idParam, notFound, conflict, badRequest, paginate } from '../lib/util.js';

const r = Router();
const READ = requireRole('ADMIN', 'FINANCE', 'OPS');
const WRITE = requireRole('ADMIN', 'FINANCE');

export function invoiceDetail(db, id) {
  const inv = db.get(
    `SELECT i.*, c.name AS customer_name, c.code AS customer_code, c.trn AS customer_trn, c.address AS customer_address,
            c.city AS customer_city, c.phone AS customer_phone, c.email AS customer_email
       FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.id = ?`, id);
  if (!inv) return null;
  inv.lines = db.all('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY id', id);
  inv.payments = db.all(
    'SELECT p.*, u.name AS collected_by_name FROM payments p LEFT JOIN users u ON u.id = p.collected_by WHERE invoice_id = ? ORDER BY p.id', id);
  inv.balance = round2(inv.total - inv.paid);
  return inv;
}

r.get('/invoices', READ, (req, res) => {
  const q = req.query;
  const where = [];
  const args = [];
  if (q.status) { where.push('i.status = ?'); args.push(String(q.status)); }
  if (q.customer_id) { where.push('i.customer_id = ?'); args.push(Number(q.customer_id)); }
  if (q.overdue === '1') where.push("i.status IN ('UNPAID','PARTIAL') AND date(i.due_date) < date('now')");
  if (q.q) { where.push('(i.number LIKE ? OR c.name LIKE ?)'); args.push(`%${q.q}%`, `%${q.q}%`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { limit, offset, page } = paginate(q);
  const total = req.db.get(`SELECT COUNT(*) AS n FROM invoices i JOIN customers c ON c.id = i.customer_id ${w}`, ...args).n;
  const rows = req.db.all(
    `SELECT i.*, c.name AS customer_name, (i.total - i.paid) AS balance,
            (SELECT COUNT(*) FROM invoice_lines l WHERE l.invoice_id = i.id) AS line_count
       FROM invoices i JOIN customers c ON c.id = i.customer_id ${w} ORDER BY i.id DESC LIMIT ? OFFSET ?`,
    ...args, limit, offset);
  res.json({ rows, total, page, limit });
});

r.get('/invoices/:id', READ, (req, res) => {
  const inv = invoiceDetail(req.db, idParam(req));
  if (!inv) throw notFound('Invoice');
  res.json(inv);
});

// Uninvoiced billable shipments for a customer (account billing run preview).
r.get('/billable', READ, (req, res) => {
  const cid = Number(req.query.customer_id);
  if (!cid) throw badRequest('customer_id required');
  res.json(req.db.all(
    `SELECT id, awb, service, origin_city, dest_city, chargeable_weight, subtotal, vat, total_charge, status, created_at
       FROM shipments WHERE customer_id = ? AND invoice_id IS NULL AND status NOT IN ('CANCELLED','BOOKED','PICKUP_ASSIGNED')
       AND (? IS NULL OR date(created_at) <= date(?)) ORDER BY id`, cid, req.query.to ?? null, req.query.to ?? null));
});

r.post('/invoices/generate', WRITE, validate(z.object({
  customer_id: z.coerce.number().int().positive(),
  shipment_ids: z.array(z.coerce.number().int().positive()).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  notes: z.string().max(300).optional(),
})), (req, res) => {
  const { customer_id: cid, shipment_ids: ids, to, notes } = req.body;
  let ships;
  if (ids?.length) {
    ships = req.db.all(`SELECT * FROM shipments WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
    if (ships.length !== ids.length) throw badRequest('Some shipments were not found');
    if (ships.some((s) => s.status === 'CANCELLED')) throw badRequest('Cancelled shipments cannot be invoiced');
  } else {
    ships = req.db.all(
      `SELECT * FROM shipments WHERE customer_id = ? AND invoice_id IS NULL AND status NOT IN ('CANCELLED','BOOKED','PICKUP_ASSIGNED')
         AND (? IS NULL OR date(created_at) <= date(?)) ORDER BY id`, cid, to ?? null, to ?? null);
  }
  const inv = createInvoice(req.db, req, cid, ships, { notes });
  res.status(201).json(invoiceDetail(req.db, inv.id));
});

r.post('/invoices/:id/payments', WRITE, validate(z.object({
  amount: z.coerce.number().positive().max(10_000_000),
  method: z.enum(['CASH', 'CARD', 'BANK', 'ONLINE']),
  reference: z.string().trim().max(60).optional(),
})), (req, res) => {
  const id = idParam(req);
  recordInvoicePayment(req.db, req, id, req.body);
  // Payments received at the office are already "settled" (not in a courier's hand).
  res.status(201).json(invoiceDetail(req.db, id));
});

r.post('/invoices/:id/void', requireRole('ADMIN'), validate(z.object({ reason: z.string().trim().min(3).max(200) })), (req, res) => {
  const id = idParam(req);
  req.db.tx(() => {
    const inv = req.db.get('SELECT * FROM invoices WHERE id = ?', id);
    if (!inv) throw notFound('Invoice');
    if (inv.paid > 0) throw conflict('Invoice has payments; issue a credit note instead');
    if (inv.status === 'VOID') throw conflict('Already void');
    req.db.run("UPDATE invoices SET status = 'VOID', notes = COALESCE(notes || ' | ', '') || ? WHERE id = ?", `VOID: ${req.body.reason}`, id);
    req.db.run('UPDATE shipments SET invoice_id = NULL WHERE invoice_id = ?', id);
    audit(req.db, req, 'invoice.void', 'invoice', inv.number, req.body);
  });
  res.json(invoiceDetail(req.db, id));
});

// ---- Driver cash control ----
r.get('/driver-cash', READ, (req, res) => {
  res.json(req.db.all(
    `SELECT u.id AS driver_id, u.name, u.vehicle_no,
            ROUND(COALESCE(SUM(CASE WHEN p.method = 'CASH' THEN p.amount END), 0), 2) AS cash_in_hand,
            ROUND(COALESCE(SUM(CASE WHEN p.method = 'CASH' AND p.kind = 'COD' THEN p.amount END), 0), 2) AS cod_cash,
            ROUND(COALESCE(SUM(CASE WHEN p.method = 'CARD' THEN p.amount END), 0), 2) AS card_total,
            COUNT(p.id) AS collections, MIN(p.created_at) AS oldest
       FROM users u LEFT JOIN payments p ON p.collected_by = u.id AND p.settlement_id IS NULL
      WHERE u.role = 'DRIVER' GROUP BY u.id ORDER BY cash_in_hand DESC`));
});

r.post('/driver-cash/:id/settle', WRITE, validate(z.object({
  amount_received: z.coerce.number().min(0),
  note: z.string().trim().max(200).optional(),
})), (req, res) => {
  const driverId = idParam(req);
  const out = req.db.tx(() => {
    const due = round2(req.db.get(
      'SELECT COALESCE(SUM(amount),0) AS t FROM payments WHERE collected_by = ? AND settlement_id IS NULL', driverId).t);
    const cash = round2(req.db.get(
      "SELECT COALESCE(SUM(amount),0) AS t FROM payments WHERE collected_by = ? AND settlement_id IS NULL AND method = 'CASH'", driverId).t);
    if (due <= 0) throw conflict('Nothing to settle');
    if (Math.abs(round2(req.body.amount_received) - cash) > 0.009) {
      throw badRequest(`Cash received (${req.body.amount_received}) does not match cash in hand (${cash.toFixed(2)}). Investigate shortage before settling.`);
    }
    const s = req.db.run('INSERT INTO cash_settlements (driver_id, amount, received_by, note) VALUES (?, ?, ?, ?)',
      driverId, cash, req.user.id, req.body.note ?? null);
    const sid = Number(s.lastInsertRowid);
    req.db.run('UPDATE payments SET settlement_id = ? WHERE collected_by = ? AND settlement_id IS NULL', sid, driverId);
    audit(req.db, req, 'cash.settle', 'driver', driverId, { cash });
    return req.db.get('SELECT * FROM cash_settlements WHERE id = ?', sid);
  });
  res.status(201).json(out);
});

r.get('/settlements', READ, (req, res) => {
  res.json(req.db.all(
    `SELECT s.*, d.name AS driver_name, u.name AS received_by_name FROM cash_settlements s
       JOIN users d ON d.id = s.driver_id JOIN users u ON u.id = s.received_by ORDER BY s.id DESC LIMIT 100`));
});

// ---- COD remittance to shippers ----
r.get('/cod', READ, (req, res) => {
  res.json(req.db.all(
    `SELECT c.id AS customer_id, c.name, c.code, COUNT(s.id) AS shipments, ROUND(SUM(s.cod_collected), 2) AS amount
       FROM shipments s JOIN customers c ON c.id = s.customer_id
      WHERE s.status = 'DELIVERED' AND s.cod_collected > 0 AND s.cod_remittance_id IS NULL
      GROUP BY c.id ORDER BY amount DESC`));
});

r.post('/cod/:id/remit', WRITE, validate(z.object({ reference: z.string().trim().min(2).max(60) })), (req, res) => {
  const customerId = idParam(req);
  const out = req.db.tx(() => {
    const amt = round2(req.db.get(
      `SELECT COALESCE(SUM(cod_collected),0) AS t FROM shipments
        WHERE customer_id = ? AND status = 'DELIVERED' AND cod_collected > 0 AND cod_remittance_id IS NULL`, customerId).t);
    if (amt <= 0) throw conflict('No COD pending for this customer');
    const rr = req.db.run('INSERT INTO cod_remittances (customer_id, amount, reference, created_by) VALUES (?, ?, ?, ?)',
      customerId, amt, req.body.reference, req.user.id);
    const rid = Number(rr.lastInsertRowid);
    req.db.run(
      `UPDATE shipments SET cod_remittance_id = ? WHERE customer_id = ? AND status = 'DELIVERED' AND cod_collected > 0 AND cod_remittance_id IS NULL`,
      rid, customerId);
    audit(req.db, req, 'cod.remit', 'customer', customerId, { amount: amt, reference: req.body.reference });
    return req.db.get('SELECT * FROM cod_remittances WHERE id = ?', rid);
  });
  res.status(201).json(out);
});

r.get('/receivables', READ, (req, res) => {
  res.json(req.db.all(
    `SELECT c.id AS customer_id, c.name, c.code, c.credit_limit,
            ROUND(SUM(i.total - i.paid), 2) AS outstanding,
            ROUND(SUM(CASE WHEN date(i.due_date) < date('now') THEN i.total - i.paid ELSE 0 END), 2) AS overdue,
            COUNT(i.id) AS open_invoices
       FROM invoices i JOIN customers c ON c.id = i.customer_id
      WHERE i.status IN ('UNPAID','PARTIAL') GROUP BY c.id ORDER BY outstanding DESC`));
});

export default r;
