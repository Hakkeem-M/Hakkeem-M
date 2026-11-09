// Base reference data (always) + fictional demo data (dev only). No real customer or employee data.
import bcrypt from 'bcryptjs';
import { createShipment, addEvent, setStatus, createInvoice, recordInvoicePayment } from './lib/shipments.js';
import { approxPoint } from './lib/geo.js';
import { nextSeq } from './db.js';

export const DEMO_PASSWORD = 'Demo@2026';

export function seedBase(db) {
  const settings = {
    company_name: 'ABC Cargo & Courier',
    company_trn: '100000000000003',
    company_phone: '+971 4 000 0000',
    company_email: 'info@example.com',
    company_address: 'Dubai, United Arab Emirates',
    vat_rate_pct: '5', fuel_surcharge_pct: '8', cod_fee_pct: '2', cod_fee_min: '10', volumetric_divisor: '5000',
  };
  for (const [k, v] of Object.entries(settings)) db.run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', k, v);

  const rates = [
    ['SAME_DAY', 'LOCAL', 5, 35, 3, 'Same day (book before 12:00)'],
    ['EXPRESS', 'LOCAL', 5, 25, 2, 'Next day'],
    ['EXPRESS', 'DOMESTIC', 5, 30, 2.5, 'Next day'],
    ['EXPRESS', 'GCC', 1, 95, 25, '2-3 days'],
    ['EXPRESS', 'INTL', 1, 140, 45, '3-5 days'],
    ['STANDARD', 'LOCAL', 5, 18, 1.5, '1-2 days'],
    ['STANDARD', 'DOMESTIC', 5, 22, 2, '2-3 days'],
    ['STANDARD', 'GCC', 1, 70, 18, '4-6 days'],
    ['STANDARD', 'INTL', 1, 110, 38, '6-9 days'],
  ];
  for (const r of rates) {
    db.run('INSERT OR IGNORE INTO rates (service, zone, base_weight, base_price, per_kg, transit) VALUES (?, ?, ?, ?, ?, ?)', ...r);
  }
  const branches = [
    ['DXB-HUB', 'Dubai Hub — Al Quoz', 'Dubai', 25.1367, 55.2283],
    ['AUH-WH', 'Abu Dhabi — Mussafah', 'Abu Dhabi', 24.3604, 54.504],
    ['SHJ-WH', 'Sharjah — Industrial Area', 'Sharjah', 25.31, 55.43],
  ];
  for (const b of branches) db.run('INSERT OR IGNORE INTO branches (code, name, city, lat, lng) VALUES (?, ?, ?, ?, ?)', ...b);
  db.run("INSERT OR IGNORE INTO customers (code, name, type, city) VALUES ('WALKIN', 'Walk-in / Cash Customer', 'CASH', 'Dubai')");
}

function rng(seed) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
}

export function seedDemo(db) {
  const rand = rng(42);
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const hash = bcrypt.hashSync(DEMO_PASSWORD, 10);
  const branch = (code) => db.get('SELECT * FROM branches WHERE code = ?', code);
  const dxb = branch('DXB-HUB');

  return db.tx(() => {
    const cust = (name, type, city, extra = {}) => {
      const code = `C${String(nextSeq(db, 'customer')).padStart(5, '0')}`;
      const p = approxPoint(city, code.length + name.length);
      const r = db.run(
        `INSERT INTO customers (code, name, type, phone, email, address, city, trn, credit_limit, payment_terms_days, lat, lng, industry)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        code, name, type, extra.phone || '+971 50 000 0001', extra.email || null, extra.address || `Demo Street, ${city}`, city,
        extra.trn || null, extra.credit || 0, extra.terms || 30, p.lat, p.lng, extra.industry || null);
      return Number(r.lastInsertRowid);
    };
    const c1 = cust('Desert Bloom Trading LLC', 'ACCOUNT', 'Dubai', { credit: 50000, trn: '100000000000011', email: 'accounts@desertbloom.example', industry: 'E-commerce' });
    const c2 = cust('Gulf Spice Retail', 'ACCOUNT', 'Sharjah', { credit: 20000, terms: 15, industry: 'Retail' });
    const c3 = cust('Oasis Electronics FZE', 'ACCOUNT', 'Abu Dhabi', { credit: 80000, terms: 45, industry: 'Electronics' });
    const c4 = cust('Palm Gifts Boutique', 'CASH', 'Dubai', { industry: 'Gifts' });
    const walkin = db.get("SELECT id FROM customers WHERE code = 'WALKIN'").id;

    const user = (name, email, role, extra = {}) => Number(db.run(
      `INSERT INTO users (name, email, phone, password_hash, role, customer_id, branch_id, vehicle_no, capacity)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      name, email, extra.phone || null, hash, role, extra.customer_id || null, extra.branch_id || null, extra.vehicle || null, extra.capacity || 25,
    ).lastInsertRowid);
    const admin = user('System Admin', 'admin@abccargo.demo', 'ADMIN');
    const ops = user('Ops Dispatcher', 'ops@abccargo.demo', 'OPS', { branch_id: dxb.id });
    user('Finance Officer', 'finance@abccargo.demo', 'FINANCE');
    const sales = user('Sales Executive', 'sales@abccargo.demo', 'SALES');
    user('Warehouse Supervisor', 'warehouse@abccargo.demo', 'WAREHOUSE', { branch_id: dxb.id });
    const drivers = [
      user('Driver One', 'driver1@abccargo.demo', 'DRIVER', { vehicle: 'DXB-V-101', branch_id: dxb.id, phone: '+971 55 000 0101', capacity: 20 }),
      user('Driver Two', 'driver2@abccargo.demo', 'DRIVER', { vehicle: 'DXB-V-102', branch_id: dxb.id, phone: '+971 55 000 0102', capacity: 20 }),
      user('Driver Three', 'driver3@abccargo.demo', 'DRIVER', { vehicle: 'SHJ-V-201', branch_id: branch('SHJ-WH').id, phone: '+971 55 000 0201', capacity: 15 }),
    ];
    user('Desert Bloom (Customer)', 'customer@abccargo.demo', 'CUSTOMER', { customer_id: c1 });
    user('Palm Gifts (Customer)', 'shop@abccargo.demo', 'CUSTOMER', { customer_id: c4 });
    db.run('UPDATE customers SET account_manager_id = ? WHERE id IN (?, ?, ?)', sales, c1, c2, c3);

    const reqAs = (id) => ({ user: { id }, ip: 'seed' });
    const opsReq = reqAs(ops);
    const cities = ['Dubai', 'Dubai', 'Dubai', 'Sharjah', 'Abu Dhabi', 'Ajman', 'Al Ain', 'Ras Al Khaimah'];
    const firstNames = ['Aisha', 'Omar', 'Fatima', 'Ravi', 'Maria', 'Yousef', 'Sara', 'John', 'Noor', 'Ali'];
    const flows = ['BOOKED', 'BOOKED', 'BOOKED', 'BOOKED', 'BOOKED', 'BOOKED', 'PICKUP_ASSIGNED', 'PICKED_UP', 'IN_WAREHOUSE', 'IN_WAREHOUSE', 'IN_WAREHOUSE',
      'OUT_FOR_DELIVERY', 'OUT_FOR_DELIVERY', 'DELIVERED', 'DELIVERED', 'DELIVERED', 'DELIVERED', 'DELIVERED', 'DELIVERY_FAILED'];
    const ago = (days, h = 0) => new Date(Date.now() - days * 86400000 - h * 3600000).toISOString().replace('T', ' ').slice(0, 19);

    const created = [];
    for (let i = 0; i < 48; i++) {
      const customerId = pick([c1, c1, c1, c2, c3, c4, walkin]);
      const custRow = db.get('SELECT * FROM customers WHERE id = ?', customerId);
      const origin = custRow.city || 'Dubai';
      const dest = pick(cities);
      const target = i < 6 ? 'BOOKED' : pick(flows);
      const pp = approxPoint(origin, i * 7 + 1);
      const dp = approxPoint(dest, i * 11 + 3);
      const s = createShipment(db, opsReq, {
        customer_id: customerId, service: dest === origin && rand() < 0.3 && origin === 'Dubai' ? 'SAME_DAY' : pick(['EXPRESS', 'EXPRESS', 'STANDARD']),
        origin_city: origin, dest_city: dest, dest_country: 'AE', pieces: 1 + Math.floor(rand() * 3), weight: Math.round((0.5 + rand() * 12) * 10) / 10,
        cod_amount: customerId === c1 && rand() < 0.6 ? Math.round(50 + rand() * 450) : 0,
        shipper_name: custRow.name, shipper_phone: '+971 50 000 0001', shipper_address: custRow.address || `Demo Street, ${origin}`,
        consignee_name: `${pick(firstNames)} ${String.fromCharCode(65 + (i % 26))}.`, consignee_phone: `+971 56 000 ${String(1000 + i)}`,
        consignee_address: `Villa ${10 + i}, Demo Community, ${dest}`, description: pick(['Documents', 'Apparel', 'Electronics accessory', 'Cosmetics', 'Gift box']),
        pickup_lat: pp.lat, pickup_lng: pp.lng, dest_lat: dp.lat, dest_lng: dp.lng, reference: customerId === c1 ? `ORD-${5000 + i}` : undefined,
      }, { paymentMode: custRow.type === 'ACCOUNT' ? 'ACCOUNT' : 'CASH' });
      const daysAgo = target === 'BOOKED' ? 0 : Math.floor(rand() * 13);
      db.run('UPDATE shipments SET created_at = ?, updated_at = ? WHERE id = ?', ago(daysAgo, 4), ago(daysAgo, 4), s.id);
      db.run('UPDATE shipment_events SET created_at = ? WHERE shipment_id = ?', ago(daysAgo, 4), s.id);
      const drv = pick(drivers);
      const steps = ['PICKUP_ASSIGNED', 'PICKED_UP', 'IN_WAREHOUSE', 'OUT_FOR_DELIVERY', 'DELIVERED'];
      const stopAt = target === 'DELIVERY_FAILED' ? 'OUT_FOR_DELIVERY' : target;
      const n = stopAt === 'BOOKED' ? 0 : steps.indexOf(stopAt) + 1;
      for (let k = 0; k < n; k++) {
        const st = steps[k];
        const t = ago(Math.max(0, daysAgo - (k >= 3 ? 1 : 0)), Math.max(0, 3 - k));
        const extra = {};
        if (st === 'PICKUP_ASSIGNED') extra.driver_id = drv;
        if (st === 'IN_WAREHOUSE') Object.assign(extra, { branch_id: dxb.id, bin: `A-${1 + (i % 6)}`, driver_id: null });
        if (st === 'OUT_FOR_DELIVERY') Object.assign(extra, { driver_id: drv, bin: null });
        if (st === 'DELIVERED') Object.assign(extra, { pod_name: 'Receiver (demo)', delivered_at: t, cod_collected: s.cod_amount });
        setStatus(db, s.id, st, extra);
        if (st === 'PICKED_UP' && s.payment_mode === 'CASH') {
          const inv = createInvoice(db, reqAs(drv), s.customer_id, [db.get('SELECT * FROM shipments WHERE id = ?', s.id)], { type: 'CASH' });
          recordInvoicePayment(db, reqAs(drv), inv.id, { amount: inv.total, method: rand() < 0.7 ? 'CASH' : 'CARD' });
        }
        if (st === 'DELIVERED' && s.cod_amount > 0) {
          db.run("INSERT INTO payments (kind, shipment_id, amount, method, collected_by, created_at) VALUES ('COD', ?, ?, 'CASH', ?, ?)", s.id, s.cod_amount, drv, t);
        }
        const loc = st === 'IN_WAREHOUSE' ? dxb.name : (k >= 3 ? dest : origin);
        addEvent(db, s.id, st, { location: loc, userId: st === 'IN_WAREHOUSE' ? ops : drv, note: st === 'DELIVERED' ? 'Delivered — received by Receiver (demo)' : undefined });
        db.run('UPDATE shipment_events SET created_at = ? WHERE id = (SELECT MAX(id) FROM shipment_events WHERE shipment_id = ?)', t, s.id);
        if (st === 'IN_WAREHOUSE') {
          db.run(`INSERT INTO warehouse_scans (shipment_id, awb, branch_id, direction, bin, result, message, user_id, scanned_at)
                  VALUES (?, ?, ?, 'IN', ?, 'OK', 'Received', ?, ?)`, s.id, s.awb, dxb.id, `A-${1 + (i % 6)}`, ops, t);
        }
      }
      if (target === 'DELIVERY_FAILED') {
        setStatus(db, s.id, 'DELIVERY_FAILED', { attempts: 1 });
        addEvent(db, s.id, 'DELIVERY_FAILED', { location: dest, note: 'Delivery attempted: Consignee not available', userId: drv });
      }
      if (['IN_WAREHOUSE', 'PICKED_UP', 'BOOKED'].includes(target)) db.run('UPDATE shipments SET updated_at = ? WHERE id = ?', ago(Math.min(daysAgo, 3), 2), s.id);
      created.push(s.id);
    }

    // Monthly account invoices for two account customers (older delivered shipments).
    for (const cid of [c2, c3]) {
      const ships = db.all("SELECT * FROM shipments WHERE customer_id = ? AND invoice_id IS NULL AND status = 'DELIVERED'", cid);
      if (ships.length) {
        const inv = createInvoice(db, reqAs(admin), cid, ships, { notes: 'Demo monthly statement' });
        if (cid === c2) recordInvoicePayment(db, reqAs(admin), inv.id, { amount: Math.round(inv.total / 2), method: 'BANK', reference: 'TT-DEMO-1' });
      }
    }

    // Live GPS: drivers around their zones (fresh fixes => "online").
    const now = Date.now();
    const starts = [[25.2, 55.27], [25.08, 55.14], [25.34, 55.41]];
    drivers.forEach((d, i) => {
      for (let k = 6; k >= 0; k--) {
        db.run('INSERT INTO driver_locations (driver_id, lat, lng, speed, battery, recorded_at) VALUES (?, ?, ?, ?, ?, ?)',
          d, starts[i][0] + k * 0.004, starts[i][1] - k * 0.003, 8 + k, 0.8, new Date(now - k * 60000).toISOString());
      }
    });

    // CRM pipeline.
    const leads = [
      ['Sunrise Pharmacy Group', 'Ops Manager', 'QUALIFIED', 600, 9000, 'REFERRAL', 'Dubai'],
      ['Marina Fashion House', 'Founder', 'PROPOSAL', 1200, 18000, 'WEBSITE', 'Dubai'],
      ['Al Noor Auto Parts', 'Purchasing Lead', 'NEW', 300, 4500, 'COLD_CALL', 'Sharjah'],
      ['Bluewave Online Store', 'E-com Head', 'NEGOTIATION', 2500, 32000, 'EXHIBITION', 'Abu Dhabi'],
      ['Green Leaf Organics', 'Owner', 'CONTACTED', 150, 2200, 'SOCIAL', 'Ajman'],
      ['City Books Distributors', 'Logistics Head', 'LOST', 400, 5000, 'WEBSITE', 'Dubai'],
    ];
    const prob = { NEW: 10, CONTACTED: 20, QUALIFIED: 40, PROPOSAL: 60, NEGOTIATION: 80, WON: 100, LOST: 0 };
    leads.forEach(([co, title, stage, ships, value, source, city], i) => {
      const id = Number(db.run(
        `INSERT INTO leads (company, contact_name, phone, email, city, source, stage, est_monthly_shipments, est_monthly_value, probability, owner_id, notes, lost_reason, expected_close)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, date('now', ?))`,
        co, `${title} (demo)`, `+971 50 100 ${1000 + i}`, null, city, source, stage, ships, value, prob[stage], sales,
        'Fictional demo lead', stage === 'LOST' ? 'Price — chose competitor' : null, `+${7 * (i + 1)} day`).lastInsertRowid);
      db.run("INSERT INTO activities (entity, entity_id, type, subject, due_at, done, owner_id) VALUES ('LEAD', ?, ?, ?, datetime('now', ?), 0, ?)",
        id, i % 2 ? 'CALL' : 'MEETING', i % 2 ? 'Follow-up call on rate proposal' : 'Site visit & volume review', `${i - 1} day`, sales);
    });
    db.run("INSERT INTO contacts (customer_id, name, title, phone, email, is_primary) VALUES (?, 'Accounts Team (demo)', 'Accounts Payable', '+971 4 000 0011', 'accounts@desertbloom.example', 1)", c1);
    db.run("INSERT INTO activities (entity, entity_id, type, subject, notes, done, owner_id) VALUES ('CUSTOMER', ?, 'MEETING', 'Quarterly business review', 'Volumes up; requested same-day in Dubai Marina', 1, ?)", c1, sales);

    // Support tickets.
    const tk = (cid, sid, cat, pri, subj, hoursAgo) => {
      const num = `TKT-${String(nextSeq(db, 'ticket')).padStart(6, '0')}`;
      const slaH = { URGENT: 4, HIGH: 8, MEDIUM: 24, LOW: 72 }[pri];
      db.run(`INSERT INTO tickets (number, customer_id, shipment_id, category, priority, channel, subject, created_by, sla_due_at, created_at)
              VALUES (?,?,?,?,?, 'PHONE', ?, ?, datetime('now', ?), datetime('now', ?))`,
      num, cid, sid, cat, pri, subj, ops, `${slaH - hoursAgo} hour`, `-${hoursAgo} hour`);
    };
    const failed = db.get("SELECT id, customer_id FROM shipments WHERE status = 'DELIVERY_FAILED' LIMIT 1");
    if (failed) tk(failed.customer_id, failed.id, 'DELAY', 'HIGH', 'Customer asking for redelivery today', 10);
    tk(c2, null, 'BILLING', 'MEDIUM', 'Query on fuel surcharge in statement', 3);
    tk(c1, created[20], 'COD', 'LOW', 'COD remittance schedule', 1);

    return { drivers, customers: [c1, c2, c3, c4] };
  });
}
