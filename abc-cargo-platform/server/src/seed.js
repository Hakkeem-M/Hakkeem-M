// Base reference data (always) + fictional demo data (dev only). No real customer or employee data.
import bcrypt from 'bcryptjs';
import { createShipment, addEvent, setStatus, createInvoice, recordInvoicePayment } from './lib/shipments.js';
import { approxPoint } from './lib/geo.js';
import { nextSeq } from './db.js';

export const DEMO_PASSWORD = 'Demo@2026';
const UAE_SAME_DAY = true;

export function seedBase(db) {
  const settings = {
    company_name: 'ABC Cargo & Courier',
    company_trn: '100000000000003',
    company_phone: '+971 4 000 0000',
    company_email: 'info@example.com',
    company_address: 'Dubai, United Arab Emirates',
    vat_rate_pct: '5', fuel_surcharge_pct: '8', intl_fuel_surcharge_pct: '18', dg_surcharge: '150',
    cod_fee_pct: '2', cod_fee_min: '10', volumetric_divisor: '5000',
  };
  for (const [k, v] of Object.entries(settings)) db.run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', k, v);

  // International (primary): air courier express / economy and air freight cargo by zone.
  const intl = {
    INTL_EXPRESS: { Z1: [0.5, 75, 30, '1-2 days'], Z2: [0.5, 85, 35, '2-3 days'], Z3: [0.5, 110, 48, '3-4 days'], Z4: [0.5, 140, 55, '2-4 days'], Z5: [0.5, 165, 65, '3-5 days'], Z6: [0.5, 185, 75, '4-6 days'] },
    INTL_ECONOMY: { Z1: [1, 55, 18, '3-5 days'], Z2: [1, 60, 20, '4-6 days'], Z3: [1, 80, 28, '5-8 days'], Z4: [1, 95, 32, '5-7 days'], Z5: [1, 110, 38, '6-9 days'], Z6: [1, 125, 45, '7-10 days'] },
    AIR_CARGO: { Z1: [45, 315, 6.5, 'Airport-to-door 2-3 days', 350], Z2: [45, 340, 7.5, 'Airport-to-door 3-4 days', 380], Z3: [45, 495, 11, 'Airport-to-door 4-6 days', 450],
      Z4: [45, 585, 13, 'Airport-to-door 3-5 days', 500], Z5: [45, 675, 15, 'Airport-to-door 4-6 days', 550], Z6: [45, 765, 17, 'Airport-to-door 5-7 days', 600] },
  };
  for (const [svc, zones] of Object.entries(intl)) {
    for (const [zone, [bw, bp, pk, transit, min]] of Object.entries(zones)) {
      db.run('INSERT OR IGNORE INTO rates (service, zone, base_weight, base_price, per_kg, transit, min_charge, divisor) VALUES (?,?,?,?,?,?,?,?)',
        svc, zone, bw, bp, pk, transit, min || 0, svc === 'AIR_CARGO' ? 6000 : 5000);
    }
  }
  // code, name, zone, airport, duty %, import VAT %, de-minimis (AED customs value)
  const countries = [
    ['SA', 'Saudi Arabia', 'Z1', 'RUH', 5, 15, 1000], ['OM', 'Oman', 'Z1', 'MCT', 5, 5, 1000], ['QA', 'Qatar', 'Z1', 'DOH', 5, 0, 1000],
    ['KW', 'Kuwait', 'Z1', 'KWI', 5, 0, 1000], ['BH', 'Bahrain', 'Z1', 'BAH', 5, 10, 1000],
    ['IN', 'India', 'Z2', 'BOM', 20, 18, 0], ['PK', 'Pakistan', 'Z2', 'KHI', 20, 17, 0], ['BD', 'Bangladesh', 'Z2', 'DAC', 25, 15, 0],
    ['LK', 'Sri Lanka', 'Z2', 'CMB', 15, 18, 0], ['NP', 'Nepal', 'Z2', 'KTM', 15, 13, 0],
    ['PH', 'Philippines', 'Z3', 'MNL', 10, 12, 35], ['CN', 'China', 'Z3', 'PVG', 10, 13, 180], ['SG', 'Singapore', 'Z3', 'SIN', 0, 9, 1450],
    ['MY', 'Malaysia', 'Z3', 'KUL', 10, 10, 400], ['HK', 'Hong Kong', 'Z3', 'HKG', 0, 0, 0], ['JP', 'Japan', 'Z3', 'NRT', 5, 10, 300], ['AU', 'Australia', 'Z3', 'SYD', 5, 10, 2400],
    ['GB', 'United Kingdom', 'Z4', 'LHR', 4, 20, 625], ['DE', 'Germany', 'Z4', 'FRA', 4, 19, 600], ['FR', 'France', 'Z4', 'CDG', 4, 20, 600],
    ['IT', 'Italy', 'Z4', 'MXP', 4, 22, 600], ['NL', 'Netherlands', 'Z4', 'AMS', 4, 21, 600], ['ES', 'Spain', 'Z4', 'MAD', 4, 21, 600], ['TR', 'Turkey', 'Z4', 'IST', 10, 20, 120],
    ['US', 'United States', 'Z5', 'JFK', 5, 0, 2900], ['CA', 'Canada', 'Z5', 'YYZ', 5, 13, 400], ['BR', 'Brazil', 'Z5', 'GRU', 60, 17, 0],
    ['EG', 'Egypt', 'Z6', 'CAI', 20, 14, 0], ['KE', 'Kenya', 'Z6', 'NBO', 25, 16, 0], ['NG', 'Nigeria', 'Z6', 'LOS', 20, 7.5, 0], ['ZA', 'South Africa', 'Z6', 'JNB', 10, 15, 2000],
  ];
  for (const c of countries) db.run('INSERT OR IGNORE INTO countries (code, name, zone, airport, duty_pct, import_vat_pct, de_minimis) VALUES (?,?,?,?,?,?,?)', ...c);
  const airports = [['DXB', 'Dubai International', 'Dubai', 'AE'], ['DWC', 'Dubai World Central (Al Maktoum)', 'Dubai', 'AE'], ['AUH', 'Zayed International', 'Abu Dhabi', 'AE'], ['SHJ', 'Sharjah International', 'Sharjah', 'AE'],
    ['RUH', 'King Khalid Intl', 'Riyadh', 'SA'], ['MCT', 'Muscat Intl', 'Muscat', 'OM'], ['DOH', 'Hamad Intl', 'Doha', 'QA'], ['KWI', 'Kuwait Intl', 'Kuwait City', 'KW'], ['BAH', 'Bahrain Intl', 'Manama', 'BH'],
    ['BOM', 'Chhatrapati Shivaji Maharaj Intl', 'Mumbai', 'IN'], ['DEL', 'Indira Gandhi Intl', 'New Delhi', 'IN'], ['COK', 'Cochin Intl', 'Kochi', 'IN'], ['KHI', 'Jinnah Intl', 'Karachi', 'PK'],
    ['DAC', 'Hazrat Shahjalal Intl', 'Dhaka', 'BD'], ['CMB', 'Bandaranaike Intl', 'Colombo', 'LK'], ['KTM', 'Tribhuvan Intl', 'Kathmandu', 'NP'], ['MNL', 'Ninoy Aquino Intl', 'Manila', 'PH'],
    ['PVG', 'Shanghai Pudong', 'Shanghai', 'CN'], ['SIN', 'Changi', 'Singapore', 'SG'], ['KUL', 'Kuala Lumpur Intl', 'Kuala Lumpur', 'MY'], ['HKG', 'Hong Kong Intl', 'Hong Kong', 'HK'],
    ['NRT', 'Narita', 'Tokyo', 'JP'], ['SYD', 'Sydney Kingsford Smith', 'Sydney', 'AU'], ['LHR', 'Heathrow', 'London', 'GB'], ['FRA', 'Frankfurt', 'Frankfurt', 'DE'], ['CDG', 'Charles de Gaulle', 'Paris', 'FR'],
    ['MXP', 'Milan Malpensa', 'Milan', 'IT'], ['AMS', 'Schiphol', 'Amsterdam', 'NL'], ['MAD', 'Madrid-Barajas', 'Madrid', 'ES'], ['IST', 'Istanbul Airport', 'Istanbul', 'TR'],
    ['JFK', 'John F. Kennedy Intl', 'New York', 'US'], ['YYZ', 'Toronto Pearson', 'Toronto', 'CA'], ['GRU', 'São Paulo Guarulhos', 'São Paulo', 'BR'], ['CAI', 'Cairo Intl', 'Cairo', 'EG'],
    ['NBO', 'Jomo Kenyatta Intl', 'Nairobi', 'KE'], ['LOS', 'Murtala Muhammed Intl', 'Lagos', 'NG'], ['JNB', 'O. R. Tambo Intl', 'Johannesburg', 'ZA']];
  for (const a of airports) db.run('INSERT OR IGNORE INTO airports (code, name, city, country) VALUES (?,?,?,?)', ...a);

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
    const flows = ['BOOKED', 'BOOKED', 'PICKUP_ASSIGNED', 'PICKED_UP', 'IN_WAREHOUSE', 'IN_WAREHOUSE', 'IN_WAREHOUSE',
      'OUT_FOR_DELIVERY', 'OUT_FOR_DELIVERY', 'DELIVERED', 'DELIVERED', 'DELIVERED', 'DELIVERED', 'DELIVERED', 'DELIVERY_FAILED'];
    const ago = (days, h = 0) => new Date(Date.now() - days * 86400000 - h * 3600000).toISOString().replace('T', ' ').slice(0, 19);

    const created = [];
    for (let i = 0; i < 30; i++) {
      const customerId = pick([c1, c1, c1, c2, c3, c4, walkin]);
      const custRow = db.get('SELECT * FROM customers WHERE id = ?', customerId);
      const origin = custRow.city || 'Dubai';
      const dest = pick(cities);
      const target = i < 4 ? 'BOOKED' : pick(flows);
      const pp = approxPoint(origin, i * 7 + 1);
      const dp = approxPoint(dest, i * 11 + 3);
      const s = createShipment(db, opsReq, {
        customer_id: customerId, service: dest === origin && rand() < 0.3 && origin === 'Dubai' && UAE_SAME_DAY ? 'SAME_DAY' : pick(['EXPRESS', 'EXPRESS', 'STANDARD']),
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

    // Give Driver One a ready-made run sheet (3 routed pickups + 2 deliveries) for demos.
    const d1 = drivers[0];
    db.all("SELECT id FROM shipments WHERE status = 'BOOKED' AND shipment_type = 'DOMESTIC' AND origin_city = 'Dubai' ORDER BY id LIMIT 3").forEach((x, i) => {
      setStatus(db, x.id, 'PICKUP_ASSIGNED', { driver_id: d1, route_seq: i + 1 });
      addEvent(db, x.id, 'PICKUP_ASSIGNED', { location: 'Dubai', note: 'Courier assigned for pickup', userId: ops });
    });
    db.all("SELECT id FROM shipments WHERE status = 'IN_WAREHOUSE' AND shipment_type = 'DOMESTIC' ORDER BY id LIMIT 2").forEach((x, i) => {
      setStatus(db, x.id, 'OUT_FOR_DELIVERY', { driver_id: d1, bin: null, route_seq: i + 1 });
      addEvent(db, x.id, 'OUT_FOR_DELIVERY', { note: 'Out for delivery with courier', userId: ops });
    });

    // Live GPS: drivers around their zones (fresh fixes => "online").
    const now = Date.now();
    const starts = [[25.2, 55.27], [25.08, 55.14], [25.34, 55.41]];
    drivers.forEach((d, i) => {
      for (let k = 6; k >= 0; k--) {
        db.run('INSERT INTO driver_locations (driver_id, lat, lng, speed, battery, recorded_at) VALUES (?, ?, ?, ?, ?, ?)',
          d, starts[i][0] + k * 0.004, starts[i][1] - k * 0.003, 8 + k, 0.8, new Date(now - k * 60000).toISOString());
      }
    });

    // ---------------- International demo (primary business) ----------------
    const agent = (name, country) => Number(db.run('INSERT INTO agents (name, country, contact, email) VALUES (?, ?, ?, ?)',
      name, country, 'Operations desk', `ops.${country.toLowerCase()}@partner.example`).lastInsertRowid);
    const agUK = agent('UK Delivery Partner (demo)', 'GB');
    const agIN = agent('India Delivery Partner (demo)', 'IN');
    agent('KSA Delivery Partner (demo)', 'SA');
    agent('Philippines Delivery Partner (demo)', 'PH');
    agent('USA Delivery Partner (demo)', 'US');
    const intlDest = [
      ['GB', 'London', 'INTL_EXPRESS'], ['GB', 'Manchester', 'INTL_EXPRESS'], ['IN', 'Mumbai', 'INTL_EXPRESS'], ['IN', 'Kochi', 'INTL_ECONOMY'],
      ['SA', 'Riyadh', 'INTL_EXPRESS'], ['PH', 'Manila', 'INTL_ECONOMY'], ['US', 'New York', 'INTL_EXPRESS'], ['PK', 'Karachi', 'INTL_ECONOMY'], ['DE', 'Frankfurt', 'AIR_CARGO'],
    ];
    const goods = [['Ladies abaya (textile)', '620442', 120], ['Perfume 100ml', '330300', 85], ['Dates gift box', '080410', 45], ['Mobile phone case', '420232', 25], ['Spare parts — bearings', '848210', 60]];
    const intlIds = [];
    for (let i = 0; i < 26; i++) {
      const [cc, city, svc] = intlDest[i % intlDest.length];
      const customerId = pick([c1, c1, c3, c3, c4, walkin]);
      const custRow = db.get('SELECT * FROM customers WHERE id = ?', customerId);
      const doc = i % 7 === 3;
      const g = goods[i % goods.length];
      const qty = 1 + (i % 4);
      const cargo = svc === 'AIR_CARGO';
      const pp = approxPoint(custRow.city || 'Dubai', i * 13 + 5);
      const sh = createShipment(db, opsReq, {
        customer_id: customerId, service: svc, origin_city: custRow.city || 'Dubai', dest_city: city, dest_country: cc,
        product: doc ? 'DOCUMENT' : (cargo ? 'CARGO' : 'PARCEL'), incoterm: i % 3 === 0 ? 'DDP' : 'DAP', export_reason: 'SALE',
        pieces: cargo ? 6 : 1, weight: cargo ? 180 : (doc ? 0.5 : Math.round((1 + rand() * 9) * 10) / 10),
        length: cargo ? 120 : undefined, width: cargo ? 80 : undefined, height: cargo ? 90 : undefined,
        shipper_name: custRow.name, shipper_phone: '+971 50 000 0001', shipper_address: custRow.address || 'Demo Street, Dubai',
        consignee_name: `${pick(firstNames)} ${String.fromCharCode(75 + (i % 12))}. (demo)`, consignee_phone: `+44 7000 ${String(100000 + i)}`,
        consignee_address: `${10 + i} Demo Road`, consignee_postcode: cc === 'GB' ? 'EC1A 1AA' : '400001', description: doc ? 'Documents' : g[0],
        items: doc ? [] : [{ description: g[0], hs_code: g[1], qty: cargo ? 400 : qty, unit_value: g[2], origin_country: 'AE' }],
        pickup_lat: pp.lat, pickup_lng: pp.lng, reference: customerId === c1 ? `EXP-${7000 + i}` : undefined,
      }, { paymentMode: custRow.type === 'ACCOUNT' ? 'ACCOUNT' : 'CASH' });
      const daysAgo = i < 6 ? 0 : 1 + Math.floor(rand() * 6);
      db.run('UPDATE shipments SET created_at = ?, updated_at = ? WHERE id = ?', ago(daysAgo, 6), ago(daysAgo, 6), sh.id);
      db.run('UPDATE shipment_events SET created_at = ? WHERE shipment_id = ?', ago(daysAgo, 6), sh.id);
      if (i >= 6) { // picked up and received at the Dubai export hub
        const drv = pick(drivers);
        setStatus(db, sh.id, 'PICKED_UP', { driver_id: drv });
        addEvent(db, sh.id, 'PICKED_UP', { location: custRow.city || 'Dubai', userId: drv });
        if (sh.payment_mode === 'CASH') {
          const inv = createInvoice(db, reqAs(drv), sh.customer_id, [db.get('SELECT * FROM shipments WHERE id = ?', sh.id)], { type: 'CASH' });
          recordInvoicePayment(db, reqAs(drv), inv.id, { amount: inv.total, method: 'CARD' });
        }
        setStatus(db, sh.id, 'IN_WAREHOUSE', { branch_id: dxb.id, bin: `EXP-${cc}`, driver_id: null });
        addEvent(db, sh.id, 'IN_WAREHOUSE', { location: dxb.name, note: 'Received at export hub', userId: ops });
        db.run(`INSERT INTO warehouse_scans (shipment_id, awb, branch_id, direction, bin, result, message, user_id, scanned_at)
                VALUES (?, ?, ?, 'IN', ?, 'OK', 'Received', ?, ?)`, sh.id, sh.awb, dxb.id, `EXP-${cc}`, ops, ago(daysAgo, 3));
      }
      if (i === 9) db.run("UPDATE shipments SET customs_status = 'PENDING' WHERE id = ?", sh.id); // demo: docs query
      intlIds.push(sh.id);
    }
    // Manifests: one London consolidation departed & arrived, one Mumbai open for scanning.
    const mkManifest = (dest, cc, agentId, flight, mawb, mode = 'AIR_COURIER') => Number(db.run(
      `INSERT INTO manifests (number, mode, origin_airport, dest_airport, dest_country, airline, flight_no, flight_date, mawb_no, agent_id, created_by)
       VALUES (?, ?, 'DXB', ?, ?, 'Demo Air', ?, date('now'), ?, ?, ?)`,
      `MAN-DXB-${dest}-${String(nextSeq(db, 'manifest')).padStart(5, '0')}`, mode, dest, cc, flight, mawb, agentId, ops).lastInsertRowid);
    const lhr = mkManifest('LHR', 'GB', agUK, 'DA001', '176-10000011');
    const bom = mkManifest('BOM', 'IN', agIN, 'DA500', '176-10000022');
    const onHub = (cc) => db.all("SELECT * FROM shipments WHERE dest_country = ? AND status = 'IN_WAREHOUSE' AND customs_status IN ('DOCS_OK','SUBMITTED')", cc);
    for (const sh of onHub('GB')) {
      setStatus(db, sh.id, 'MANIFESTED', { manifest_id: lhr, agent_id: agUK, bin: null, customs_status: 'SUBMITTED' });
      addEvent(db, sh.id, 'MANIFESTED', { location: 'DXB export hub', note: 'Export processed — consolidated for LHR', userId: ops });
      setStatus(db, sh.id, 'DEPARTED');
      addEvent(db, sh.id, 'DEPARTED', { location: 'DXB', note: 'Departed DXB on Demo Air DA001 to LHR', userId: ops });
      setStatus(db, sh.id, 'ARRIVED');
      addEvent(db, sh.id, 'ARRIVED', { location: 'LHR', note: 'Arrived at LHR — awaiting import customs', userId: ops });
    }
    db.run("UPDATE manifests SET status = 'ARRIVED', departed_at = datetime('now','-10 hour'), arrived_at = datetime('now','-2 hour') WHERE id = ?", lhr);
    const inStock = onHub('IN');
    if (inStock[0]) {
      setStatus(db, inStock[0].id, 'MANIFESTED', { manifest_id: bom, agent_id: agIN, bin: null, customs_status: 'SUBMITTED' });
      addEvent(db, inStock[0].id, 'MANIFESTED', { location: 'DXB export hub', note: 'Export processed — consolidated for BOM', userId: ops });
    }

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
