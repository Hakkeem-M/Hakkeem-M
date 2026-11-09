// Driver mobile app API: run sheet, pickup with on-the-spot billing, POD delivery with COD, wallet.
import { Router } from 'express';
import { z } from 'zod';
import { audit, getSettings } from '../db.js';
import { requireRole } from '../lib/auth.js';
import {
  createShipment, createInvoice, recordInvoicePayment, repriceShipment, setStatus, addEvent, shipmentDetail,
} from '../lib/shipments.js';
import { shipmentInput, quoteInput } from '../lib/schemas.js';
import { quoteAll, round2 } from '../lib/pricing.js';
import { haversineKm, validPoint } from '../lib/geo.js';
import { validate, idParam, notFound, conflict, badRequest, zDataImage, normalizeAwb, zLat, zLng } from '../lib/util.js';

const r = Router();
r.use(requireRole('DRIVER'));

const geo = { lat: zLat, lng: zLng };
const payMethod = z.enum(['CASH', 'CARD']);

const GEOFENCE_KM = 0.5;
/** Record an internal exception event when the courier confirms a stop far from its GPS pin. */
function geofence(req, s, at, target, what) {
  if (!validPoint(at) || !validPoint(target)) return;
  const km = haversineKm(at, target);
  if (km > GEOFENCE_KM) {
    addEvent(req.db, s.id, s.status, { note: `GPS check: ${what} confirmed ${km.toFixed(2)} km from pin`, userId: req.user.id, lat: at.lat, lng: at.lng, isPublic: false });
    audit(req.db, req, 'driver.geofence', 'shipment', s.awb, { km: Math.round(km * 100) / 100, what });
  }
}

function ownShipment(req, id) {
  const s = req.db.get('SELECT * FROM shipments WHERE id = ? AND driver_id = ?', id, req.user.id);
  if (!s) throw notFound('Task');
  return s;
}

r.get('/tasks', (req, res) => {
  const cols = `s.id, s.awb, s.status, s.service, s.payment_mode, s.pieces, s.chargeable_weight, s.cod_amount, s.total_charge,
    s.invoice_id, s.attempts, s.shipper_name, s.shipper_phone, s.shipper_address, s.origin_city,
    s.consignee_name, s.consignee_phone, s.consignee_address, s.dest_city, s.description, c.name AS customer_name,
    s.pickup_lat, s.pickup_lng, s.dest_lat, s.dest_lng, s.pickup_window, s.route_id, s.route_seq`;
  const pickups = req.db.all(
    `SELECT ${cols} FROM shipments s JOIN customers c ON c.id = s.customer_id
      WHERE s.driver_id = ? AND s.status = 'PICKUP_ASSIGNED' ORDER BY COALESCE(s.route_seq, 9999), s.id`, req.user.id);
  const deliveries = req.db.all(
    `SELECT ${cols} FROM shipments s JOIN customers c ON c.id = s.customer_id
      WHERE s.driver_id = ? AND s.status = 'OUT_FOR_DELIVERY' ORDER BY COALESCE(s.route_seq, 9999), s.id`, req.user.id);
  const done = req.db.get(
    `SELECT
       SUM(CASE WHEN status = 'DELIVERED' AND date(delivered_at) = date('now') THEN 1 ELSE 0 END) AS delivered,
       SUM(CASE WHEN status = 'DELIVERY_FAILED' THEN 1 ELSE 0 END) AS failed
     FROM shipments WHERE driver_id = ?`, req.user.id);
  const picked = req.db.get(
    `SELECT COUNT(DISTINCT e.shipment_id) AS n FROM shipment_events e
      WHERE e.user_id = ? AND e.status = 'PICKED_UP' AND date(e.created_at) = date('now')`, req.user.id).n;
  res.json({ pickups, deliveries, stats: { delivered_today: done.delivered || 0, failed_open: done.failed || 0, picked_today: picked } });
});

r.get('/tasks/:id', (req, res) => {
  const s = ownShipment(req, idParam(req));
  res.json(shipmentDetail(req.db, s.id));
});

r.get('/lookup/:awb', (req, res) => {
  const s = req.db.get('SELECT id FROM shipments WHERE awb = ? AND driver_id = ?', normalizeAwb(req.params.awb), req.user.id);
  if (!s) throw notFound('Task with this AWB');
  res.json(shipmentDetail(req.db, s.id));
});

r.post('/quote', validate(quoteInput), (req, res) => {
  res.json({ quotes: quoteAll(req.db, getSettings(req.db), req.body) });
});

r.get('/customers', (req, res) => {
  const q = `%${String(req.query.q || '').trim().slice(0, 40)}%`;
  res.json(req.db.all(
    `SELECT id, code, name, type, phone, address, city FROM customers
      WHERE active = 1 AND (name LIKE ? OR code LIKE ? OR phone LIKE ?) ORDER BY type DESC, name LIMIT 20`, q, q, q));
});

/** Bill a shipment on the spot: invoice it (if not yet) and take payment. Returns the invoice. */
function billNow(req, shipment, payment) {
  let inv = shipment.invoice_id && req.db.get('SELECT * FROM invoices WHERE id = ?', shipment.invoice_id);
  if (!inv) inv = createInvoice(req.db, req, shipment.customer_id, [shipment], { type: 'CASH', notes: 'Collected by courier' });
  const due = round2(inv.total - inv.paid);
  if (due > 0) {
    if (!payment) throw badRequest(`Collect ${due.toFixed(2)} AED before confirming pickup`);
    if (Math.abs(round2(payment.amount) - due) > 0.009) throw badRequest(`Amount must equal ${due.toFixed(2)} AED`);
    inv = recordInvoicePayment(req.db, req, inv.id, { amount: due, method: payment.method, reference: payment.reference });
  }
  return inv;
}

// On-the-spot booking + billing (walk-in / unscheduled pickup).
r.post('/bookings', validate(shipmentInput.extend({
  customer_id: z.coerce.number().int().positive().optional(),
  payment: z.object({ method: payMethod, amount: z.coerce.number().positive(), reference: z.string().max(60).optional() }).optional(),
  ...geo,
})), (req, res) => {
  const b = req.body;
  const out = req.db.tx(() => {
    const walkIn = req.db.get("SELECT id FROM customers WHERE code = 'WALKIN'");
    const customerId = b.customer_id || walkIn?.id;
    const customer = req.db.get('SELECT * FROM customers WHERE id = ?', customerId);
    if (!customer) throw badRequest('Customer not found');
    const s = createShipment(req.db, req, { ...b, customer_id: customer.id, pickup_lat: b.pickup_lat ?? b.lat, pickup_lng: b.pickup_lng ?? b.lng }, {
      status: 'PICKED_UP', driverId: req.user.id, paymentMode: customer.type === 'ACCOUNT' ? 'ACCOUNT' : 'CASH',
    });
    let invoice = null;
    if (s.payment_mode === 'CASH') invoice = billNow(req, s, b.payment);
    return { shipment: shipmentDetail(req.db, s.id), invoice };
  });
  res.status(201).json(out);
});

r.post('/shipments/:id/pickup', validate(z.object({
  pieces: z.coerce.number().int().min(1).max(999).optional(),
  weight: z.coerce.number().positive().max(5000).optional(),
  length: z.coerce.number().positive().max(300).optional(),
  width: z.coerce.number().positive().max(300).optional(),
  height: z.coerce.number().positive().max(300).optional(),
  note: z.string().trim().max(300).optional(),
  payment: z.object({ method: payMethod, amount: z.coerce.number().positive(), reference: z.string().max(60).optional() }).optional(),
  ...geo,
})), (req, res) => {
  const id = idParam(req);
  const out = req.db.tx(() => {
    let s = ownShipment(req, id);
    if (s.status !== 'PICKUP_ASSIGNED') throw conflict(`Shipment is ${s.status}`);
    const b = req.body;
    const changes = {};
    for (const k of ['pieces', 'weight', 'length', 'width', 'height']) if (b[k] != null && b[k] !== s[k]) changes[k] = b[k];
    if (Object.keys(changes).length && !s.invoice_id) s = repriceShipment(req.db, s, changes);
    let invoice = null;
    if (s.payment_mode === 'CASH') invoice = billNow(req, s, b.payment);
    setStatus(req.db, s.id, 'PICKED_UP', { route_seq: null });
    geofence(req, s, { lat: b.lat, lng: b.lng }, { lat: s.pickup_lat, lng: s.pickup_lng }, 'pickup');
    addEvent(req.db, s.id, 'PICKED_UP', { location: s.origin_city, note: b.note || 'Picked up by courier', userId: req.user.id, lat: b.lat, lng: b.lng });
    audit(req.db, req, 'driver.pickup', 'shipment', s.awb);
    return { shipment: shipmentDetail(req.db, s.id), invoice };
  });
  res.json(out);
});

r.post('/shipments/:id/deliver', validate(z.object({
  receiver_name: z.string().trim().min(2).max(120),
  signature: zDataImage(400_000),
  photo: zDataImage(1_500_000).optional(),
  cod_collected: z.coerce.number().min(0).optional(),
  cod_method: payMethod.optional(),
  ...geo,
})), (req, res) => {
  const id = idParam(req);
  const out = req.db.tx(() => {
    const s = ownShipment(req, id);
    if (s.status !== 'OUT_FOR_DELIVERY') throw conflict(`Shipment is ${s.status}`);
    const b = req.body;
    if (s.cod_amount > 0) {
      if (Math.abs(round2(b.cod_collected ?? 0) - s.cod_amount) > 0.009) {
        throw badRequest(`Collect the full COD amount of ${s.cod_amount.toFixed(2)} AED`);
      }
      req.db.run(
        `INSERT INTO payments (kind, shipment_id, amount, method, collected_by) VALUES ('COD', ?, ?, ?, ?)`,
        s.id, s.cod_amount, b.cod_method || 'CASH', req.user.id,
      );
    }
    geofence(req, s, { lat: b.lat, lng: b.lng }, { lat: s.dest_lat, lng: s.dest_lng }, 'delivery');
    setStatus(req.db, s.id, 'DELIVERED', {
      pod_name: b.receiver_name, pod_signature: b.signature, pod_photo: b.photo ?? null,
      cod_collected: s.cod_amount, delivered_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
    });
    addEvent(req.db, s.id, 'DELIVERED', { location: s.dest_city, note: `Delivered — received by ${b.receiver_name}`, userId: req.user.id, lat: b.lat, lng: b.lng });
    audit(req.db, req, 'driver.deliver', 'shipment', s.awb, { cod: s.cod_amount });
    return shipmentDetail(req.db, s.id);
  });
  res.json(out);
});

export const FAIL_REASONS = ['Consignee not available', 'Wrong / incomplete address', 'Consignee refused', 'COD not ready', 'Rescheduled by consignee', 'Business closed', 'Other'];

r.post('/shipments/:id/fail', validate(z.object({
  reason: z.enum(FAIL_REASONS), note: z.string().trim().max(300).optional(), ...geo,
})), (req, res) => {
  const id = idParam(req);
  req.db.tx(() => {
    const s = ownShipment(req, id);
    if (s.status !== 'OUT_FOR_DELIVERY') throw conflict(`Shipment is ${s.status}`);
    setStatus(req.db, s.id, 'DELIVERY_FAILED', { attempts: s.attempts + 1 });
    addEvent(req.db, s.id, 'DELIVERY_FAILED', {
      location: s.dest_city, note: `Delivery attempted: ${req.body.reason}${req.body.note ? ` — ${req.body.note}` : ''}`,
      userId: req.user.id, lat: req.body.lat, lng: req.body.lng,
    });
    audit(req.db, req, 'driver.fail', 'shipment', s.awb, { reason: req.body.reason });
  });
  res.json(shipmentDetail(req.db, id));
});

// Live GPS pings from the driver app (every ~30 s while on duty). Accepts a small batch for offline buffering.
r.post('/location', validate(z.object({
  points: z.array(z.object({
    lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180),
    accuracy: z.coerce.number().min(0).max(100000).optional(), speed: z.coerce.number().min(0).max(100).optional(),
    heading: z.coerce.number().min(0).max(360).optional(), battery: z.coerce.number().min(0).max(1).optional(),
    recorded_at: z.string().datetime().optional(),
  })).min(1).max(100),
})), (req, res) => {
  req.db.tx(() => {
    for (const p of req.body.points) {
      req.db.run(
        'INSERT INTO driver_locations (driver_id, lat, lng, accuracy, speed, heading, battery, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        req.user.id, p.lat, p.lng, p.accuracy ?? null, p.speed ?? null, p.heading ?? null, p.battery ?? null,
        p.recorded_at || new Date().toISOString());
    }
  });
  res.json({ ok: true, stored: req.body.points.length });
});

r.get('/fail-reasons', (_req, res) => res.json(FAIL_REASONS));

// Cash in hand (not yet handed over to finance) + today's collections.
r.get('/wallet', (req, res) => {
  const unsettled = req.db.all(
    `SELECT p.id, p.kind, p.amount, p.method, p.created_at, COALESCE(s.awb, s2.awb) AS awb, i.number AS invoice_number
       FROM payments p
       LEFT JOIN shipments s ON s.id = p.shipment_id
       LEFT JOIN invoices i ON i.id = p.invoice_id
       LEFT JOIN invoice_lines il ON il.invoice_id = p.invoice_id AND il.id = (SELECT MIN(id) FROM invoice_lines WHERE invoice_id = p.invoice_id)
       LEFT JOIN shipments s2 ON s2.id = il.shipment_id
      WHERE p.collected_by = ? AND p.settlement_id IS NULL ORDER BY p.id DESC`, req.user.id);
  const sum = (f) => round2(unsettled.filter(f).reduce((a, p) => a + p.amount, 0));
  res.json({
    cash_in_hand: sum((p) => p.method === 'CASH'),
    cod_cash: sum((p) => p.method === 'CASH' && p.kind === 'COD'),
    freight_cash: sum((p) => p.method === 'CASH' && p.kind === 'INVOICE'),
    card_total: sum((p) => p.method === 'CARD'),
    collections: unsettled,
    settlements: req.db.all('SELECT * FROM cash_settlements WHERE driver_id = ? ORDER BY id DESC LIMIT 10', req.user.id),
  });
});

r.get('/invoices/:id', (req, res) => {
  const inv = req.db.get(
    `SELECT i.*, c.name AS customer_name, c.trn AS customer_trn, c.phone AS customer_phone FROM invoices i
       JOIN customers c ON c.id = i.customer_id
      WHERE i.id = ? AND EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = i.id AND p.collected_by = ?)`,
    idParam(req), req.user.id);
  if (!inv) throw notFound('Invoice');
  inv.lines = req.db.all('SELECT * FROM invoice_lines WHERE invoice_id = ?', inv.id);
  inv.payments = req.db.all('SELECT * FROM payments WHERE invoice_id = ?', inv.id);
  res.json(inv);
});

export default r;
