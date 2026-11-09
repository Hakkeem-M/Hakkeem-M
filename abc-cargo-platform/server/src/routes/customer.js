// Public Customer App API (CUSTOMER role, scoped to the caller's own customer account).
import { Router } from 'express';
import { z } from 'zod';
import { audit } from '../db.js';
import { requireRole } from '../lib/auth.js';
import { createShipment, createInvoice, recordInvoicePayment, setStatus, addEvent, shipmentDetail } from '../lib/shipments.js';
import { shipmentInput } from '../lib/schemas.js';
import { invoiceDetail } from './finance.js';
import { createTicket, ticketDetail } from './crm.js';
import { validate, idParam, notFound, conflict, normalizeAwb, zText, HttpError } from '../lib/util.js';
import { round2 } from '../lib/pricing.js';

export default (config) => {
  const r = Router();
  r.use(requireRole('CUSTOMER'));
  r.use((req, _res, next) => {
    if (!req.user.customer_id) return next(new HttpError(403, 'Account is not linked to a customer'));
    next();
  });

  const strip = (s) => {
    if (!s) return s;
    const { pod_signature, created_by, driver_phone, ...rest } = s;
    rest.events = (s.events || []).filter((e) => e.public).map(({ status, location, note, created_at }) => ({ status, location, note, created_at }));
    delete rest.scans;
    rest.has_pod = !!pod_signature;
    return rest;
  };

  r.get('/profile', (req, res) => {
    const c = req.db.get('SELECT id, code, name, type, phone, email, address, city, trn, credit_limit, payment_terms_days FROM customers WHERE id = ?', req.user.customer_id);
    const stats = req.db.get(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status NOT IN ('DELIVERED','CANCELLED','RETURNED') THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN status = 'DELIVERED' THEN 1 ELSE 0 END) AS delivered
         FROM shipments WHERE customer_id = ?`, req.user.customer_id);
    const due = req.db.get("SELECT ROUND(COALESCE(SUM(total - paid),0),2) AS t FROM invoices WHERE customer_id = ? AND status IN ('UNPAID','PARTIAL')", req.user.customer_id).t;
    const cod = req.db.get("SELECT ROUND(COALESCE(SUM(cod_collected),0),2) AS t FROM shipments WHERE customer_id = ? AND status = 'DELIVERED' AND cod_remittance_id IS NULL", req.user.customer_id).t;
    res.json({ customer: c, stats: { ...stats, amount_due: due, cod_pending: cod }, payments_demo: config.paymentsDemo });
  });

  r.get('/shipments', (req, res) => {
    const where = ['s.customer_id = ?'];
    const args = [req.user.customer_id];
    if (req.query.active === '1') where.push("s.status NOT IN ('DELIVERED','CANCELLED','RETURNED')");
    if (req.query.q) { where.push('(s.awb LIKE ? OR s.consignee_name LIKE ? OR s.reference LIKE ?)'); args.push(...Array(3).fill(`%${req.query.q}%`)); }
    res.json(req.db.all(
      `SELECT s.id, s.awb, s.status, s.service, s.origin_city, s.dest_city, s.consignee_name, s.pieces, s.chargeable_weight,
              s.cod_amount, s.total_charge, s.payment_mode, s.reference, s.created_at, s.delivered_at
         FROM shipments s WHERE ${where.join(' AND ')} ORDER BY s.id DESC LIMIT 200`, ...args));
  });

  r.get('/shipments/:awb', (req, res) => {
    const row = req.db.get('SELECT id FROM shipments WHERE awb = ? AND customer_id = ?', normalizeAwb(req.params.awb), req.user.customer_id);
    if (!row) throw notFound('Shipment');
    res.json(strip(shipmentDetail(req.db, row.id)));
  });

  r.post('/shipments', validate(shipmentInput.extend({ pay_online: z.boolean().default(false) })), (req, res) => {
    const out = req.db.tx(() => {
      const customer = req.db.get('SELECT * FROM customers WHERE id = ?', req.user.customer_id);
      let mode = customer.type === 'ACCOUNT' ? 'ACCOUNT' : (req.body.pay_online ? 'PREPAID' : 'CASH');
      if (customer.type === 'ACCOUNT') {
        const outstanding = req.db.get("SELECT COALESCE(SUM(total - paid),0) AS t FROM invoices WHERE customer_id = ? AND status IN ('UNPAID','PARTIAL')", customer.id).t;
        const unbilled = req.db.get("SELECT COALESCE(SUM(total_charge),0) AS t FROM shipments WHERE customer_id = ? AND invoice_id IS NULL AND status != 'CANCELLED'", customer.id).t;
        if (customer.credit_limit > 0 && outstanding + unbilled > customer.credit_limit) {
          throw conflict('Credit limit reached. Please settle outstanding invoices or contact your account manager.');
        }
      }
      const s = createShipment(req.db, req, { ...req.body, customer_id: customer.id }, { paymentMode: mode });
      let invoice = null;
      if (mode === 'PREPAID') invoice = createInvoice(req.db, req, customer.id, [s], { type: 'CASH', notes: 'Online prepaid booking' });
      return { shipment: strip(shipmentDetail(req.db, s.id)), invoice };
    });
    res.status(201).json(out);
  });

  r.post('/shipments/:id/cancel', (req, res) => {
    const id = idParam(req);
    req.db.tx(() => {
      const s = req.db.get('SELECT * FROM shipments WHERE id = ? AND customer_id = ?', id, req.user.customer_id);
      if (!s) throw notFound('Shipment');
      if (s.status !== 'BOOKED') throw conflict('Only shipments not yet assigned for pickup can be cancelled online');
      if (s.invoice_id) {
        const inv = req.db.get('SELECT * FROM invoices WHERE id = ?', s.invoice_id);
        if (inv.paid > 0) throw conflict('Paid shipment — please raise a support ticket for a refund');
        req.db.run("UPDATE invoices SET status = 'VOID', notes = 'Cancelled by customer' WHERE id = ?", inv.id);
        req.db.run('UPDATE shipments SET invoice_id = NULL WHERE id = ?', id);
      }
      setStatus(req.db, id, 'CANCELLED');
      addEvent(req.db, id, 'CANCELLED', { note: 'Cancelled by customer', userId: req.user.id });
      audit(req.db, req, 'shipment.cancel', 'shipment', s.awb);
    });
    res.json({ ok: true });
  });

  r.get('/invoices', (req, res) => {
    res.json(req.db.all(
      'SELECT id, number, type, status, issue_date, due_date, subtotal, vat, total, paid, ROUND(total - paid, 2) AS balance FROM invoices WHERE customer_id = ? ORDER BY id DESC',
      req.user.customer_id));
  });

  r.get('/invoices/:id', (req, res) => {
    const inv = invoiceDetail(req.db, idParam(req));
    if (!inv || inv.customer_id !== req.user.customer_id) throw notFound('Invoice');
    inv.payments = inv.payments.map(({ id, amount, method, reference, created_at }) => ({ id, amount, method, reference, created_at }));
    res.json(inv);
  });

  // Payment gateway hook. In demo mode it simulates a successful card payment.
  // Production: replace with a payment-provider checkout session + signed webhook confirmation.
  r.post('/invoices/:id/pay', (req, res) => {
    if (!config.paymentsDemo) throw new HttpError(501, 'Online payment gateway not configured');
    const id = idParam(req);
    const inv = req.db.get('SELECT * FROM invoices WHERE id = ? AND customer_id = ?', id, req.user.customer_id);
    if (!inv) throw notFound('Invoice');
    if (inv.status === 'PAID' || inv.status === 'VOID') throw conflict(`Invoice is ${inv.status}`);
    recordInvoicePayment(req.db, req, id, { amount: round2(inv.total - inv.paid), method: 'ONLINE', reference: `DEMO-${Date.now()}` });
    res.json(invoiceDetail(req.db, id));
  });

  // Support tickets from the customer app.
  r.get('/tickets', (req, res) => {
    res.json(req.db.all(
      `SELECT t.id, t.number, t.subject, t.category, t.status, t.priority, t.created_at, t.updated_at, s.awb
         FROM tickets t LEFT JOIN shipments s ON s.id = t.shipment_id WHERE t.customer_id = ? ORDER BY t.id DESC`, req.user.customer_id));
  });
  r.post('/tickets', validate(z.object({
    awb: z.string().trim().max(20).optional(),
    category: z.enum(['DELAY', 'DAMAGE', 'LOST', 'BILLING', 'PICKUP', 'COD', 'OTHER']),
    subject: zText(200),
    description: z.string().trim().max(4000).optional(),
  })), (req, res) => {
    let shipmentId = null;
    if (req.body.awb) {
      const s = req.db.get('SELECT id FROM shipments WHERE awb = ? AND customer_id = ?', normalizeAwb(req.body.awb), req.user.customer_id);
      if (!s) throw notFound('Shipment');
      shipmentId = s.id;
    }
    const priority = ['LOST', 'DAMAGE'].includes(req.body.category) ? 'HIGH' : 'MEDIUM';
    const t = createTicket(req.db, req, { ...req.body, customer_id: req.user.customer_id, shipment_id: shipmentId, priority, channel: 'PORTAL' });
    res.status(201).json(ticketDetail(req.db, t.id, { includeInternal: false }));
  });
  r.get('/tickets/:id', (req, res) => {
    const t = ticketDetail(req.db, idParam(req), { includeInternal: false });
    if (!t || t.customer_id !== req.user.customer_id) throw notFound('Ticket');
    res.json(t);
  });
  r.post('/tickets/:id/comments', validate(z.object({ body: zText(4000) })), (req, res) => {
    const id = idParam(req);
    const t = req.db.get('SELECT * FROM tickets WHERE id = ? AND customer_id = ?', id, req.user.customer_id);
    if (!t) throw notFound('Ticket');
    req.db.run('INSERT INTO ticket_comments (ticket_id, user_id, body) VALUES (?, ?, ?)', id, req.user.id, req.body.body);
    req.db.run("UPDATE tickets SET updated_at = datetime('now'), status = CASE WHEN status IN ('WAITING_CUSTOMER','RESOLVED') THEN 'OPEN' ELSE status END WHERE id = ?", id);
    res.status(201).json(ticketDetail(req.db, id, { includeInternal: false }));
  });

  return r;
};
