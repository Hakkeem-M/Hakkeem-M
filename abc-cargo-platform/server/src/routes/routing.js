// Dispatch & routing: live GPS fleet map, AUTO route planning (preview + commit), MANUAL routes and re-sequencing.
import { Router } from 'express';
import { z } from 'zod';
import { audit } from '../db.js';
import { requireRole } from '../lib/auth.js';
import { addEvent, setStatus } from '../lib/shipments.js';
import { autoRoute, optimiseSequence, pathKm, validPoint, AVG_SPEED_KMH, SERVICE_MIN_PER_STOP } from '../lib/geo.js';
import { validate, badRequest, idParam, notFound, today } from '../lib/util.js';
import { inEntity } from '../lib/entity.js';

const r = Router();
r.use(requireRole('ADMIN', 'OPS'));

const ONLINE_MIN = 10;

function fleet(db, entity) {
  return db.all(
    `SELECT u.id, u.name, u.phone, u.vehicle_no, u.capacity, u.branch_id,
            l.lat, l.lng, l.speed, l.heading, l.battery, l.recorded_at,
            CASE WHEN l.recorded_at IS NOT NULL AND (julianday('now') - julianday(l.recorded_at)) * 1440 <= ${ONLINE_MIN} THEN 1 ELSE 0 END AS online,
            (SELECT COUNT(*) FROM shipments s WHERE s.driver_id = u.id AND s.status = 'PICKUP_ASSIGNED') AS pickups,
            (SELECT COUNT(*) FROM shipments s WHERE s.driver_id = u.id AND s.status = 'OUT_FOR_DELIVERY') AS deliveries,
            b.lat AS depot_lat, b.lng AS depot_lng
       FROM users u
       LEFT JOIN driver_locations l ON l.id = (SELECT MAX(id) FROM driver_locations WHERE driver_id = u.id)
       LEFT JOIN branches b ON b.id = u.branch_id
      WHERE u.role = 'DRIVER' AND u.active = 1 ${entity ? 'AND u.entity_code = ?' : ''} ORDER BY u.name`, ...(entity ? [entity] : []));
}

const STOP_COLS = `s.id, s.awb, s.status, s.service, s.shipper_name, s.shipper_address, s.origin_city, s.consignee_name,
  s.consignee_address, s.dest_city, s.pickup_lat, s.pickup_lng, s.dest_lat, s.dest_lng, s.pickup_window,
  s.pieces, s.chargeable_weight, s.cod_amount, s.driver_id, s.route_id, s.route_seq, c.name AS customer_name`;

// Live map payload: drivers with last GPS fix, open pickups and active stops.
r.get('/live', (req, res) => {
  const stops = req.db.all(
    `SELECT ${STOP_COLS} FROM shipments s JOIN customers c ON c.id = s.customer_id
      WHERE s.status IN ('BOOKED','PICKUP_ASSIGNED','OUT_FOR_DELIVERY') ${req.entity ? 'AND s.entity_code = ?' : ''}
      ORDER BY s.driver_id, COALESCE(s.route_seq, 9999)`, ...(req.entity ? [req.entity] : []));
  res.json({ drivers: fleet(req.db, req.entity), stops, generated_at: new Date().toISOString() });
});

r.get('/drivers/:id/trail', (req, res) => {
  const hours = Math.min(24, Number(req.query.hours) || 8);
  res.json(req.db.all(
    `SELECT lat, lng, speed, recorded_at FROM driver_locations
      WHERE driver_id = ? AND julianday(recorded_at) >= julianday('now') - ? / 24.0 ORDER BY id`, idParam(req), hours));
});

const planInput = z.object({
  kind: z.enum(['PICKUP', 'DELIVERY']).default('PICKUP'),
  driver_ids: z.array(z.coerce.number().int().positive()).optional(),
  city: z.string().trim().max(60).optional(),
  include_assigned: z.boolean().default(false), // re-plan stops already given to these drivers
  max_route_km: z.coerce.number().min(5).max(1000).default(250),
  commit: z.boolean().default(false),
});

function stopPoint(s, kind) {
  return kind === 'PICKUP' ? { lat: s.pickup_lat, lng: s.pickup_lng } : { lat: s.dest_lat, lng: s.dest_lng };
}

/**
 * AUTO routing. PICKUP: open BOOKED collections. DELIVERY: parcels in warehouse awaiting a courier.
 * Drivers start from their live GPS position (if online) or their depot branch.
 */
r.post('/auto-plan', validate(planInput), (req, res) => {
  const b = req.body;
  let drivers = fleet(req.db, req.entity);
  if (b.driver_ids?.length) drivers = drivers.filter((d) => b.driver_ids.includes(d.id));
  if (!drivers.length) throw badRequest('No active drivers available');

  const statusOpen = b.kind === 'PICKUP' ? ['BOOKED'] : ['IN_WAREHOUSE', 'DELIVERY_FAILED'];
  const cityCol = b.kind === 'PICKUP' ? 's.origin_city' : 's.dest_city';
  const args = [...statusOpen];
  let where = `s.status IN (${statusOpen.map(() => '?').join(',')})`;
  if (req.entity) { where += ' AND s.entity_code = ?'; args.push(req.entity); }
  if (b.kind === 'DELIVERY') where += ' AND s.driver_id IS NULL';
  if (b.city) { where += ` AND ${cityCol} = ?`; args.push(b.city); }
  const open = req.db.all(`SELECT ${STOP_COLS} FROM shipments s JOIN customers c ON c.id = s.customer_id WHERE ${where}`, ...args);

  const assignedStatus = b.kind === 'PICKUP' ? 'PICKUP_ASSIGNED' : null;
  const driverInputs = drivers.map((d) => {
    const start = d.online && validPoint(d) ? { lat: d.lat, lng: d.lng } : { lat: d.depot_lat, lng: d.depot_lng };
    const existing = !b.include_assigned && assignedStatus
      ? req.db.all(`SELECT ${STOP_COLS} FROM shipments s JOIN customers c ON c.id = s.customer_id
                     WHERE s.driver_id = ? AND s.status = ? ORDER BY COALESCE(s.route_seq, 9999)`, d.id, assignedStatus)
        .map((s) => ({ ...s, ...stopPoint(s, b.kind), locked: true }))
      : [];
    return { ...start, id: d.id, name: d.name, capacity: d.capacity, existing, start };
  }).filter((d) => validPoint(d));
  if (!driverInputs.length) throw badRequest('No driver has a GPS fix or depot location');

  if (b.include_assigned && assignedStatus) {
    const ids = driverInputs.map((d) => d.id);
    open.push(...req.db.all(
      `SELECT ${STOP_COLS} FROM shipments s JOIN customers c ON c.id = s.customer_id
        WHERE s.status = ? AND s.driver_id IN (${ids.map(() => '?').join(',')})`, assignedStatus, ...ids));
  }

  const plan = autoRoute(open.map((s) => ({ ...s, ...stopPoint(s, b.kind) })), driverInputs, { maxRouteKm: b.max_route_km });
  const named = Object.fromEntries(driverInputs.map((d) => [d.id, d]));
  const result = {
    kind: b.kind,
    routes: plan.routes.map((rt) => ({
      ...rt, driver_name: named[rt.driver_id].name, start: named[rt.driver_id].start,
      stops: rt.stops.map((s, i) => ({ seq: i + 1, id: s.id, awb: s.awb, lat: s.lat, lng: s.lng, name: b.kind === 'PICKUP' ? s.shipper_name : s.consignee_name, address: b.kind === 'PICKUP' ? s.shipper_address : s.consignee_address, city: b.kind === 'PICKUP' ? s.origin_city : s.dest_city, locked: !!s.locked, window: s.pickup_window })),
    })),
    unassigned: plan.unassigned.map((s) => ({ id: s.id, awb: s.awb, reason: validPoint(s) ? 'Capacity / distance limit' : 'No GPS location' })),
    committed: false,
  };

  if (b.commit) {
    req.db.tx(() => {
      for (const rt of result.routes) {
        const ins = req.db.run(
          `INSERT INTO routes (driver_id, route_date, kind, mode, stops, distance_km, duration_min, created_by)
           VALUES (?, ?, ?, 'AUTO', ?, ?, ?, ?)`, rt.driver_id, today(), b.kind, rt.stops.length, rt.distance_km, rt.duration_min, req.user.id);
        const routeId = Number(ins.lastInsertRowid);
        rt.route_id = routeId;
        for (const st of rt.stops) applyStop(req, st.id, rt.driver_id, routeId, st.seq, b.kind, rt.driver_name);
      }
      audit(req.db, req, 'routing.auto_commit', 'routes', null, { kind: b.kind, routes: result.routes.length, stops: result.routes.reduce((a, x) => a + x.stops.length, 0) });
    });
    result.committed = true;
  }
  res.json(result);
});

function applyStop(req, shipmentId, driverId, routeId, seq, kind, driverName) {
  const s = req.db.get('SELECT * FROM shipments WHERE id = ?', shipmentId);
  if (kind === 'PICKUP') {
    if (!['BOOKED', 'PICKUP_ASSIGNED'].includes(s.status)) throw badRequest(`${s.awb} is no longer open for pickup (${s.status})`);
    const changed = s.status !== 'PICKUP_ASSIGNED' || s.driver_id !== driverId;
    setStatus(req.db, s.id, 'PICKUP_ASSIGNED', { driver_id: driverId, route_id: routeId, route_seq: seq });
    if (changed) addEvent(req.db, s.id, 'PICKUP_ASSIGNED', { location: s.origin_city, note: 'Courier assigned for pickup', userId: req.user.id });
  } else {
    if (!['IN_WAREHOUSE', 'DELIVERY_FAILED', 'OUT_FOR_DELIVERY'].includes(s.status)) throw badRequest(`${s.awb} is not ready for delivery (${s.status})`);
    req.db.run("UPDATE shipments SET driver_id = ?, route_id = ?, route_seq = ?, updated_at = datetime('now') WHERE id = ?", driverId, routeId, seq, s.id);
    if (s.driver_id !== driverId) addEvent(req.db, s.id, s.status, { note: `Delivery route assigned to ${driverName}`, userId: req.user.id, isPublic: false });
  }
}

/**
 * MANUAL routing: dispatcher sets the exact ordered stop list for a driver (drag & drop in ERP).
 * optimise=true re-sequences the given stops by shortest path from the driver's position.
 */
r.post('/manual', validate(z.object({
  driver_id: z.coerce.number().int().positive(),
  kind: z.enum(['PICKUP', 'DELIVERY']).default('PICKUP'),
  shipment_ids: z.array(z.coerce.number().int().positive()).min(1).max(200),
  optimise: z.boolean().default(false),
})), (req, res) => {
  const b = req.body;
  const d = fleet(req.db, req.entity).find((x) => x.id === b.driver_id);
  if (!d) throw badRequest('Driver not found or inactive');
  if (d.capacity && b.shipment_ids.length > d.capacity) throw badRequest(`Exceeds driver capacity (${d.capacity} stops)`);
  const start = d.online && validPoint(d) ? { lat: d.lat, lng: d.lng } : { lat: d.depot_lat, lng: d.depot_lng };
  const ships = b.shipment_ids.map((id) => {
    const s = inEntity(req, req.db.get('SELECT * FROM shipments WHERE id = ?', id), `Shipment ${id}`);
    return { ...s, ...stopPoint(s, b.kind) };
  });
  const located = ships.filter(validPoint);
  let ordered = ships;
  if (b.optimise && validPoint(start)) ordered = [...optimiseSequence(start, located), ...ships.filter((s) => !validPoint(s))];
  const km = validPoint(start) ? pathKm(start, ordered.filter(validPoint)) : 0;
  const out = req.db.tx(() => {
    const ins = req.db.run(
      `INSERT INTO routes (driver_id, route_date, kind, mode, stops, distance_km, duration_min, created_by)
       VALUES (?, ?, ?, 'MANUAL', ?, ?, ?, ?)`, d.id, today(), b.kind, ordered.length, Math.round(km * 10) / 10,
      Math.round((km / AVG_SPEED_KMH) * 60 + ordered.length * SERVICE_MIN_PER_STOP), req.user.id);
    const routeId = Number(ins.lastInsertRowid);
    ordered.forEach((s, i) => applyStop(req, s.id, d.id, routeId, i + 1, b.kind, d.name));
    audit(req.db, req, 'routing.manual', 'route', routeId, { driver_id: d.id, stops: ordered.length, optimise: b.optimise });
    return req.db.get('SELECT * FROM routes WHERE id = ?', routeId);
  });
  res.status(201).json({ ...out, sequence: ordered.map((s, i) => ({ seq: i + 1, id: s.id, awb: s.awb, lat: s.lat, lng: s.lng })) });
});

// Remove a stop from a driver's pickup run (back to the open pool).
r.post('/unassign', validate(z.object({ shipment_ids: z.array(z.coerce.number().int().positive()).min(1) })), (req, res) => {
  const done = req.db.tx(() => req.body.shipment_ids.map((id) => {
    const s = req.db.get('SELECT * FROM shipments WHERE id = ?', id);
    if (!s) return { id, ok: false };
    if (s.status === 'PICKUP_ASSIGNED') {
      setStatus(req.db, id, 'BOOKED', { driver_id: null, route_id: null, route_seq: null });
      addEvent(req.db, id, 'BOOKED', { note: 'Pickup unassigned by dispatcher', userId: req.user.id, isPublic: false });
    } else if (['IN_WAREHOUSE', 'DELIVERY_FAILED'].includes(s.status)) {
      req.db.run('UPDATE shipments SET driver_id = NULL, route_id = NULL, route_seq = NULL WHERE id = ?', id);
    } else return { id, ok: false, error: `Cannot unassign while ${s.status}` };
    return { id, ok: true };
  }));
  res.json({ results: done });
});

r.get('/routes', (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date)) ? req.query.date : today();
  const routes = req.db.all(
    `SELECT rt.*, u.name AS driver_name, cb.name AS created_by_name,
            (SELECT COUNT(*) FROM shipments s WHERE s.route_id = rt.id AND s.status IN ('PICKUP_ASSIGNED','OUT_FOR_DELIVERY','IN_WAREHOUSE','DELIVERY_FAILED')) AS remaining
       FROM routes rt JOIN users u ON u.id = rt.driver_id LEFT JOIN users cb ON cb.id = rt.created_by
      WHERE rt.route_date = ? ${req.entity ? 'AND u.entity_code = ?' : ''} ORDER BY rt.id DESC`, date, ...(req.entity ? [req.entity] : []));
  res.json(routes);
});

r.get('/routes/:id', (req, res) => {
  const rt = req.db.get('SELECT rt.*, u.name AS driver_name FROM routes rt JOIN users u ON u.id = rt.driver_id WHERE rt.id = ?', idParam(req));
  if (!rt) throw notFound('Route');
  rt.stops = req.db.all(`SELECT ${STOP_COLS} FROM shipments s JOIN customers c ON c.id = s.customer_id WHERE s.route_id = ? ORDER BY s.route_seq`, rt.id);
  res.json(rt);
});

export default r;
