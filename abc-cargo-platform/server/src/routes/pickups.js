// Pickups & deliveries board: every collection by time window — scheduled, en route, completed, missed.
import { Router } from 'express';
import { z } from 'zod';
import { audit } from '../db.js';
import { requireRole } from '../lib/auth.js';
import { addEvent, setStatus } from '../lib/shipments.js';
import { startPickup, missPickup, postponePickup, cancelPickup, autoAssign, freeDrivers, MISSED_REASONS } from '../lib/pickups.js';
import { validate, idParam, conflict, zText } from '../lib/util.js';
import { inEntity } from '../lib/entity.js';

const r = Router();
r.use(requireRole('ADMIN', 'OPS'));

const COLS = `s.id, s.awb, s.status, s.service, s.shipper_name, s.shipper_address, s.origin_city, s.pieces, s.weight, s.pickup_window,
  COALESCE(s.pickup_date, date(s.created_at)) AS pickup_date, s.pickup_started_at, s.pickup_missed_reason, s.driver_id, s.entity_code,
  s.enquiry_id, u.name AS driver_name, c.name AS customer_name, e.ref AS enquiry_ref`;
const FROM = `FROM shipments s JOIN customers c ON c.id = s.customer_id LEFT JOIN users u ON u.id = s.driver_id
  LEFT JOIN enquiries e ON e.id = s.enquiry_id`;

r.get('/', (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : new Date().toISOString().slice(0, 10);
  const [ew, ea] = req.entity ? [' AND s.entity_code = ?', [req.entity]] : ['', []];
  const day = 'COALESCE(s.pickup_date, date(s.created_at))';
  const scheduled = req.db.all(
    `SELECT ${COLS}, CASE WHEN ${day} < ? THEN 1 ELSE 0 END AS overdue ${FROM}
      WHERE s.status IN ('BOOKED','PICKUP_ASSIGNED') AND s.pickup_started_at IS NULL AND s.pickup_missed_reason IS NULL AND ${day} <= ? ${ew}
      ORDER BY ${day}, s.pickup_window, s.id`, date, date, ...ea);
  const enRoute = req.db.all(
    `SELECT ${COLS} ${FROM} WHERE s.status = 'PICKUP_ASSIGNED' AND s.pickup_started_at IS NOT NULL ${ew} ORDER BY s.pickup_started_at`, ...ea);
  const completed = req.db.all(
    `SELECT ${COLS}, (SELECT MAX(created_at) FROM shipment_events ev WHERE ev.shipment_id = s.id AND ev.status = 'PICKED_UP') AS collected_at ${FROM}
      WHERE EXISTS (SELECT 1 FROM shipment_events ev WHERE ev.shipment_id = s.id AND ev.status = 'PICKED_UP' AND date(ev.created_at) = ?) ${ew}
      ORDER BY collected_at DESC`, date, ...ea);
  const missed = req.db.all(
    `SELECT ${COLS} ${FROM} WHERE s.status = 'BOOKED' AND s.pickup_missed_reason IS NOT NULL ${ew} ORDER BY s.updated_at DESC`, ...ea);
  res.json({ date, scheduled, en_route: enRoute, completed, missed, reasons: MISSED_REASONS });
});

const load = (req) => inEntity(req, req.db.get('SELECT * FROM shipments WHERE id = ?', idParam(req)), 'Shipment');
const done = (req, res, id) => res.json(req.db.get(`SELECT ${COLS} ${FROM} WHERE s.id = ?`, id));

r.get('/:id/drivers', (req, res) => {
  const s = load(req);
  res.json(freeDrivers(req.db, s.entity_code, { lat: s.pickup_lat, lng: s.pickup_lng }));
});

r.post('/:id/assign', validate(z.object({ driver_id: z.coerce.number().int().positive().optional() })), (req, res) => {
  const s = load(req);
  req.db.tx(() => {
    if (!['BOOKED', 'PICKUP_ASSIGNED'].includes(s.status)) throw conflict(`Collection is ${s.status}`);
    if (!req.body.driver_id) {
      if (s.status !== 'BOOKED') throw conflict('Already assigned');
      if (!autoAssign(req.db, req, s)) throw conflict('No free driver in this region');
    } else {
      const d = freeDrivers(req.db, s.entity_code, {}).find((x) => x.id === req.body.driver_id);
      if (!d) throw conflict('Driver is not available in this region');
      setStatus(req.db, s.id, 'PICKUP_ASSIGNED', { driver_id: d.id, route_seq: d.load + 1, pickup_missed_reason: null, pickup_started_at: null });
      addEvent(req.db, s.id, 'PICKUP_ASSIGNED', { location: s.origin_city, note: `Collection assigned to ${d.name}`, userId: req.user.id });
    }
    audit(req.db, req, 'pickup.assign', 'shipment', s.awb, { driver_id: req.body.driver_id ?? 'auto' });
  });
  done(req, res, s.id);
});

r.post('/:id/start', (req, res) => {
  const s = load(req);
  req.db.tx(() => { startPickup(req.db, req, s); audit(req.db, req, 'pickup.start', 'shipment', s.awb); });
  done(req, res, s.id);
});

// Ops marks a collection done on the driver's behalf (e.g. phone confirmation); billing happens at the hub.
r.post('/:id/collected', validate(z.object({ note: z.string().trim().max(300).optional() })), (req, res) => {
  const s = load(req);
  req.db.tx(() => {
    if (s.status !== 'PICKUP_ASSIGNED') throw conflict(`Collection is ${s.status}`);
    setStatus(req.db, s.id, 'PICKED_UP', { route_seq: null, pickup_started_at: null, pickup_missed_reason: null });
    addEvent(req.db, s.id, 'PICKED_UP', { location: s.origin_city, note: req.body.note || 'Collected (confirmed by operations)', userId: req.user.id });
    audit(req.db, req, 'pickup.collected', 'shipment', s.awb);
  });
  done(req, res, s.id);
});

r.post('/:id/missed', validate(z.object({ reason: z.enum(MISSED_REASONS), note: z.string().trim().max(300).optional() })), (req, res) => {
  const s = load(req);
  req.db.tx(() => { missPickup(req.db, req, s, req.body.reason, req.body.note); audit(req.db, req, 'pickup.missed', 'shipment', s.awb, { reason: req.body.reason }); });
  done(req, res, s.id);
});

r.post('/:id/postpone', validate(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), window: z.string().trim().max(40).optional() })), (req, res) => {
  const s = load(req);
  req.db.tx(() => { postponePickup(req.db, req, s, req.body.date, req.body.window); audit(req.db, req, 'pickup.postpone', 'shipment', s.awb, req.body); });
  done(req, res, s.id);
});

r.post('/:id/cancel', validate(z.object({ reason: zText(200) })), (req, res) => {
  const s = load(req);
  req.db.tx(() => { cancelPickup(req.db, req, s, req.body.reason); audit(req.db, req, 'pickup.cancel', 'shipment', s.awb, { reason: req.body.reason }); });
  done(req, res, s.id);
});

export default r;
