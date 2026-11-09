// Management dashboard & operational reports.
import { Router } from 'express';
import { requireRole, STAFF } from '../lib/auth.js';
import { round2 } from '../lib/pricing.js';

const r = Router();
r.use(requireRole(...STAFF));

r.get('/dashboard', (req, res) => {
  const db = req.db;
  const one = (sql, ...a) => db.get(sql, ...a);
  const statusCounts = Object.fromEntries(db.all('SELECT status, COUNT(*) AS n FROM shipments GROUP BY status').map((x) => [x.status, x.n]));
  const kpi = {
    bookings_today: one("SELECT COUNT(*) AS n FROM shipments WHERE date(created_at) = date('now')").n,
    delivered_today: one("SELECT COUNT(*) AS n FROM shipments WHERE status = 'DELIVERED' AND date(delivered_at) = date('now')").n,
    pending_pickups: (statusCounts.BOOKED || 0) + (statusCounts.PICKUP_ASSIGNED || 0),
    unassigned_pickups: statusCounts.BOOKED || 0,
    in_warehouse: statusCounts.IN_WAREHOUSE || 0,
    out_for_delivery: statusCounts.OUT_FOR_DELIVERY || 0,
    failed_attempts: statusCounts.DELIVERY_FAILED || 0,
    revenue_mtd: round2(one("SELECT COALESCE(SUM(total_charge),0) AS t FROM shipments WHERE status != 'CANCELLED' AND strftime('%Y-%m', created_at) = strftime('%Y-%m','now')").t),
    collected_mtd: round2(one("SELECT COALESCE(SUM(amount),0) AS t FROM payments WHERE kind = 'INVOICE' AND strftime('%Y-%m', created_at) = strftime('%Y-%m','now')").t),
    ar_outstanding: round2(one("SELECT COALESCE(SUM(total - paid),0) AS t FROM invoices WHERE status IN ('UNPAID','PARTIAL')").t),
    ar_overdue: round2(one("SELECT COALESCE(SUM(total - paid),0) AS t FROM invoices WHERE status IN ('UNPAID','PARTIAL') AND date(due_date) < date('now')").t),
    driver_cash: round2(one("SELECT COALESCE(SUM(amount),0) AS t FROM payments WHERE method = 'CASH' AND settlement_id IS NULL AND collected_by IN (SELECT id FROM users WHERE role = 'DRIVER')").t),
    cod_pending_remit: round2(one("SELECT COALESCE(SUM(cod_collected),0) AS t FROM shipments WHERE status = 'DELIVERED' AND cod_collected > 0 AND cod_remittance_id IS NULL").t),
    open_tickets: one("SELECT COUNT(*) AS n FROM tickets WHERE status NOT IN ('RESOLVED','CLOSED')").n,
    sla_breached: one("SELECT COUNT(*) AS n FROM tickets WHERE status NOT IN ('RESOLVED','CLOSED') AND datetime('now') > sla_due_at").n,
    pipeline_weighted: round2(one("SELECT COALESCE(SUM(est_monthly_value * probability / 100.0),0) AS t FROM leads WHERE stage NOT IN ('WON','LOST')").t),
    drivers_online: one("SELECT COUNT(DISTINCT driver_id) AS n FROM driver_locations WHERE (julianday('now') - julianday(recorded_at)) * 1440 <= 10").n,
  };
  const delivered30 = one("SELECT COUNT(*) AS n, SUM(CASE WHEN attempts = 0 THEN 1 ELSE 0 END) AS first FROM shipments WHERE status = 'DELIVERED' AND date(delivered_at) >= date('now','-30 day')");
  kpi.first_attempt_rate = delivered30.n ? Math.round((delivered30.first / delivered30.n) * 100) : null;

  const days = db.all(
    `WITH RECURSIVE d(day) AS (SELECT date('now','-13 day') UNION ALL SELECT date(day,'+1 day') FROM d WHERE day < date('now'))
     SELECT d.day,
            (SELECT COUNT(*) FROM shipments s WHERE date(s.created_at) = d.day) AS bookings,
            (SELECT COUNT(*) FROM shipments s WHERE s.status = 'DELIVERED' AND date(s.delivered_at) = d.day) AS delivered,
            (SELECT ROUND(COALESCE(SUM(total_charge),0),2) FROM shipments s WHERE s.status != 'CANCELLED' AND date(s.created_at) = d.day) AS revenue
       FROM d`);
  const byService = db.all(
    `SELECT service, COUNT(*) AS shipments, ROUND(SUM(total_charge),2) AS revenue FROM shipments
      WHERE status != 'CANCELLED' AND date(created_at) >= date('now','-30 day') GROUP BY service ORDER BY revenue DESC`);
  const drivers = db.all(
    `SELECT u.id, u.name, u.vehicle_no,
            SUM(CASE WHEN s.status = 'DELIVERED' AND date(s.delivered_at) >= date('now','-7 day') THEN 1 ELSE 0 END) AS delivered_7d,
            SUM(CASE WHEN s.status = 'OUT_FOR_DELIVERY' THEN 1 ELSE 0 END) AS on_board,
            SUM(CASE WHEN s.status = 'PICKUP_ASSIGNED' THEN 1 ELSE 0 END) AS pickups
       FROM users u LEFT JOIN shipments s ON s.driver_id = u.id
      WHERE u.role = 'DRIVER' AND u.active = 1 GROUP BY u.id ORDER BY delivered_7d DESC`);
  const topCustomers = db.all(
    `SELECT c.id, c.name, COUNT(s.id) AS shipments, ROUND(SUM(s.total_charge),2) AS revenue FROM shipments s
       JOIN customers c ON c.id = s.customer_id WHERE s.status != 'CANCELLED' AND date(s.created_at) >= date('now','-30 day')
      GROUP BY c.id ORDER BY revenue DESC LIMIT 5`);
  const recent = db.all(
    `SELECT e.status, e.location, e.note, e.created_at, s.awb, s.id AS shipment_id, u.name AS user_name
       FROM shipment_events e JOIN shipments s ON s.id = e.shipment_id LEFT JOIN users u ON u.id = e.user_id
      ORDER BY e.id DESC LIMIT 15`);
  res.json({ kpi, status_counts: statusCounts, days, by_service: byService, drivers, top_customers: topCustomers, recent });
});

r.get('/exceptions', (req, res) => {
  res.json({
    stuck_in_warehouse: req.db.all(
      `SELECT id, awb, dest_city, bin, updated_at FROM shipments WHERE status = 'IN_WAREHOUSE'
         AND (julianday('now') - julianday(updated_at)) > 2 ORDER BY updated_at LIMIT 100`),
    failed_attempts: req.db.all("SELECT id, awb, dest_city, attempts, updated_at FROM shipments WHERE status = 'DELIVERY_FAILED' ORDER BY attempts DESC LIMIT 100"),
    scan_exceptions: req.db.all("SELECT * FROM warehouse_scans WHERE result = 'EXCEPTION' ORDER BY id DESC LIMIT 100"),
    geofence: req.db.all("SELECT * FROM audit_log WHERE action = 'driver.geofence' ORDER BY id DESC LIMIT 100"),
  });
});

export default r;
