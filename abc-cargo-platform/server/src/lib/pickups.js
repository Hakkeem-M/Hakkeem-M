// Collection (pickup) lifecycle shared by the ERP pickups board, the agent inbox and the driver app:
// nearest-free-driver assignment, start (en route), missed, postpone and cancel.
import { addEvent, setStatus } from './shipments.js';
import { haversineKm, validPoint } from './geo.js';
import { conflict, badRequest } from './util.js';

export const MISSED_REASONS = ['Customer not available', 'Wrong / incomplete address', 'Goods not ready', 'Customer cancelled', 'Vehicle issue', 'Access / parking problem', 'Other'];
const ONLINE_MIN = 10;

/** Active drivers of a region with spare capacity, nearest to the point first (live GPS, else depot). */
export function freeDrivers(db, entity, point) {
  const rows = db.all(
    `SELECT u.id, u.name, u.capacity, l.lat, l.lng,
            CASE WHEN l.recorded_at IS NOT NULL AND (julianday('now') - julianday(l.recorded_at)) * 1440 <= ${ONLINE_MIN} THEN 1 ELSE 0 END AS online,
            b.lat AS depot_lat, b.lng AS depot_lng,
            (SELECT COUNT(*) FROM shipments s WHERE s.driver_id = u.id AND s.status = 'PICKUP_ASSIGNED') AS load
       FROM users u
       LEFT JOIN driver_locations l ON l.id = (SELECT MAX(id) FROM driver_locations WHERE driver_id = u.id)
       LEFT JOIN branches b ON b.id = u.branch_id
      WHERE u.role = 'DRIVER' AND u.active = 1 AND u.entity_code = ?`, entity);
  return rows
    .filter((d) => d.load < (d.capacity || 25))
    .map((d) => {
      const from = d.online && validPoint(d) ? { lat: d.lat, lng: d.lng } : { lat: d.depot_lat, lng: d.depot_lng };
      const km = validPoint(point) && validPoint(from) ? haversineKm(from, point) : null;
      return { id: d.id, name: d.name, load: d.load, online: !!d.online, km: km == null ? null : Math.round(km * 10) / 10 };
    })
    .sort((a, b) => (a.km ?? 1e9) - (b.km ?? 1e9) || a.load - b.load);
}

/** Auto-assign a BOOKED collection to the nearest free driver. Returns the driver or null when none is free. */
export function autoAssign(db, req, shipment) {
  if (shipment.status !== 'BOOKED') return null;
  const [d] = freeDrivers(db, shipment.entity_code, { lat: shipment.pickup_lat, lng: shipment.pickup_lng });
  if (!d) return null;
  setStatus(db, shipment.id, 'PICKUP_ASSIGNED', { driver_id: d.id, route_seq: d.load + 1, pickup_missed_reason: null });
  addEvent(db, shipment.id, 'PICKUP_ASSIGNED', {
    location: shipment.origin_city, userId: req.user?.id,
    note: `Collection auto-assigned to ${d.name}${d.km != null ? ` (${d.km} km away)` : ''}`,
  });
  return d;
}

const OPEN = ['BOOKED', 'PICKUP_ASSIGNED'];
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

export function startPickup(db, req, s) {
  if (s.status !== 'PICKUP_ASSIGNED') throw conflict(`Collection is ${s.status} — assign a driver first`);
  if (s.pickup_started_at) throw conflict('Driver is already en route');
  db.run("UPDATE shipments SET pickup_started_at = ?, updated_at = datetime('now') WHERE id = ?", stamp(), s.id);
  addEvent(db, s.id, 'PICKUP_ASSIGNED', { location: s.origin_city, note: 'Driver en route to collection', userId: req.user?.id });
}

export function missPickup(db, req, s, reason, note) {
  if (!OPEN.includes(s.status)) throw conflict(`Collection is ${s.status}`);
  if (!MISSED_REASONS.includes(reason)) throw badRequest('Unknown reason');
  setStatus(db, s.id, 'BOOKED', { driver_id: null, route_id: null, route_seq: null, pickup_started_at: null, pickup_missed_reason: reason });
  addEvent(db, s.id, 'BOOKED', { location: s.origin_city, note: `Collection missed: ${reason}${note ? ` — ${note}` : ''}`, userId: req.user?.id });
}

export function postponePickup(db, req, s, date, window) {
  if (!OPEN.includes(s.status)) throw conflict(`Collection is ${s.status}`);
  setStatus(db, s.id, 'BOOKED', {
    driver_id: null, route_id: null, route_seq: null, pickup_started_at: null, pickup_missed_reason: null,
    pickup_date: date, pickup_window: window ?? s.pickup_window ?? null,
  });
  addEvent(db, s.id, 'BOOKED', { location: s.origin_city, note: `Collection postponed to ${date}${window ? ` ${window}` : ''}`, userId: req.user?.id });
}

export function cancelPickup(db, req, s, reason) {
  if (!OPEN.includes(s.status)) throw conflict(`Only open collections can be cancelled (${s.status})`);
  if (s.invoice_id) throw conflict('Shipment is already invoiced — void the invoice first');
  setStatus(db, s.id, 'CANCELLED', { driver_id: null, route_id: null, route_seq: null, pickup_started_at: null });
  addEvent(db, s.id, 'CANCELLED', { location: s.origin_city, note: `Booking cancelled: ${reason}`, userId: req.user?.id });
}
