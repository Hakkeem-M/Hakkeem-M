import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { seedBase, seedDemo, DEMO_PASSWORD } from '../src/seed.js';
import { isValidAwb } from '../src/lib/util.js';
import { priceShipment, zoneFor, chargeableWeight } from '../src/lib/pricing.js';
import { autoRoute, optimiseSequence, pathKm } from '../src/lib/geo.js';

let app;
let db;
const tok = {};
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const as = (who) => ({
  get: (u) => request(app).get(u).set('Authorization', `Bearer ${tok[who]}`),
  post: (u, b) => request(app).post(u).set('Authorization', `Bearer ${tok[who]}`).send(b),
  put: (u, b) => request(app).put(u).set('Authorization', `Bearer ${tok[who]}`).send(b),
  patch: (u, b) => request(app).patch(u).set('Authorization', `Bearer ${tok[who]}`).send(b),
});

const parcel = (extra = {}) => ({
  service: 'EXPRESS', origin_city: 'Dubai', dest_city: 'Sharjah', weight: 3, pieces: 1,
  shipper_name: 'Test Shipper', shipper_phone: '+971500000000', shipper_address: 'Test address, Dubai',
  consignee_name: 'Test Consignee', consignee_phone: '+971560000000', consignee_address: 'Consignee address, Sharjah',
  ...extra,
});

before(async () => {
  db = openDb(':memory:');
  seedBase(db);
  seedDemo(db);
  app = createApp({ db, config: { jwtSecret: 'x'.repeat(40), jwtTtl: '1h', loginRateLimit: 1000, paymentsDemo: true, mapTileHosts: [], production: false } });
  for (const who of ['admin', 'ops', 'finance', 'sales', 'warehouse', 'driver1', 'driver2', 'customer', 'shop']) {
    const res = await request(app).post('/api/auth/login').send({ email: `${who}@abccargo.demo`, password: DEMO_PASSWORD });
    assert.equal(res.status, 200, `${who} login`);
    tok[who] = res.body.token;
  }
});

test('pricing: zones, volumetric weight, VAT', () => {
  assert.equal(zoneFor('Dubai', 'Dubai'), 'LOCAL');
  assert.equal(zoneFor('Abu Dhabi', 'Al Ain'), 'LOCAL');
  assert.equal(zoneFor('Dubai', 'Sharjah'), 'DOMESTIC');
  assert.equal(zoneFor('Dubai', 'Riyadh', 'SA'), 'GCC');
  assert.equal(zoneFor('Dubai', 'London', 'GB'), 'INTL');
  assert.equal(chargeableWeight({ weight: 2, length: 50, width: 40, height: 30 }), 12);
  const s = { fuel_surcharge_pct: '10', cod_fee_pct: '2', cod_fee_min: '10', vat_rate_pct: '5' };
  const p = priceShipment({ zone: 'DOMESTIC', weight: 7, cod_amount: 100 }, { base_weight: 5, base_price: 30, per_kg: 2.5 }, s);
  assert.deepEqual([p.freight, p.fuel_surcharge, p.cod_fee, p.subtotal, p.vat, p.total_charge], [35, 3.5, 10, 48.5, 2.43, 50.93]);
  const intl = priceShipment({ zone: 'INTL', weight: 1 }, { base_weight: 1, base_price: 100, per_kg: 40 }, s);
  assert.equal(intl.vat, 0, 'exports zero-rated');
});

test('routing heuristics: capacity, sequencing, 2-opt never worse', () => {
  const depot = { lat: 25.2, lng: 55.27 };
  const stops = [[25.21, 55.28], [25.25, 55.3], [25.19, 55.26], [25.3, 55.4], [25.1, 55.2]].map(([lat, lng], i) => ({ id: i, lat, lng }));
  const seq = optimiseSequence(depot, stops);
  assert.equal(seq.length, 5);
  assert.ok(pathKm(depot, seq) <= pathKm(depot, stops) + 1e-9);
  const plan = autoRoute(stops, [{ id: 1, ...depot, capacity: 2 }, { id: 2, lat: 25.3, lng: 55.4, capacity: 2 }]);
  assert.equal(plan.routes.reduce((a, r) => a + r.stops.length, 0), 4);
  assert.equal(plan.unassigned.length, 1);
  assert.ok(plan.routes.every((r) => r.stops.length <= 2));
});

test('auth: bad password, wrong app, RBAC, no token', async () => {
  assert.equal((await request(app).post('/api/auth/login').send({ email: 'admin@abccargo.demo', password: 'nope' })).status, 401);
  assert.equal((await request(app).post('/api/auth/login').send({ email: 'customer@abccargo.demo', password: DEMO_PASSWORD, app: 'erp' })).status, 403);
  assert.equal((await request(app).get('/api/shipments')).status, 401);
  assert.equal((await as('customer').get('/api/shipments')).status, 403);
  assert.equal((await as('driver1').get('/api/finance/invoices')).status, 403);
  assert.equal((await as('warehouse').post('/api/finance/invoices/generate', { customer_id: 1 })).status, 403);
});

test('public: quote + tracking hides PII', async () => {
  const q = await request(app).post('/api/public/quote').send({ origin_city: 'Dubai', dest_city: 'Dubai', weight: 2 });
  assert.equal(q.status, 200);
  assert.ok(q.body.quotes.some((x) => x.service === 'SAME_DAY'));
  const { awb } = db.get('SELECT awb FROM shipments LIMIT 1');
  assert.ok(isValidAwb(awb));
  const t = await request(app).get(`/api/public/track/${awb}`);
  assert.equal(t.status, 200);
  for (const k of ['consignee_phone', 'consignee_address', 'shipper_phone', 'total_charge']) assert.equal(t.body[k], undefined);
  assert.equal((await request(app).get('/api/public/track/ABC123')).status, 400);
});

test('full lifecycle: customer books → auto-route → driver pickup → warehouse IN/OUT → POD with COD → cash settle → COD remit', async () => {
  const book = await as('customer').post('/api/customer/shipments', parcel({ cod_amount: 250, pickup_lat: 25.205, pickup_lng: 55.275 }));
  assert.equal(book.status, 201, JSON.stringify(book.body));
  const s = book.body.shipment;
  assert.equal(s.status, 'BOOKED');
  assert.equal(s.payment_mode, 'ACCOUNT');

  // Auto route preview, then commit for driver1 only
  const prev = await as('ops').post('/api/routing/auto-plan', { kind: 'PICKUP', driver_ids: [db.get("SELECT id FROM users WHERE email='driver1@abccargo.demo'").id] });
  assert.equal(prev.status, 200);
  assert.equal(prev.body.committed, false);
  const d1 = db.get("SELECT id FROM users WHERE email='driver1@abccargo.demo'").id;
  const man = await as('ops').post('/api/routing/manual', { driver_id: d1, kind: 'PICKUP', shipment_ids: [s.id], optimise: true });
  assert.equal(man.status, 201, JSON.stringify(man.body));

  const tasks = await as('driver1').get('/api/driver/tasks');
  assert.ok(tasks.body.pickups.some((x) => x.id === s.id));
  assert.equal((await as('driver2').post(`/api/driver/shipments/${s.id}/pickup`, {})).status, 404, 'other driver cannot act');

  // GPS ping + pickup far from pin triggers geofence exception
  assert.equal((await as('driver1').post('/api/driver/location', { points: [{ lat: 25.2, lng: 55.27 }] })).status, 200);
  const pu = await as('driver1').post(`/api/driver/shipments/${s.id}/pickup`, { lat: 25.3, lng: 55.5 });
  assert.equal(pu.status, 200, JSON.stringify(pu.body));
  assert.ok(db.get("SELECT id FROM audit_log WHERE action = 'driver.geofence' AND entity_id = ?", s.awb));

  // Warehouse IN, duplicate IN, OUT
  const inScan = await as('warehouse').post('/api/warehouse/scan', { awb: s.awb, direction: 'IN', bin: 'B-1', client_ref: 'dev1-1' });
  assert.equal(inScan.body.result, 'OK');
  const dup = await as('warehouse').post('/api/warehouse/scan', { awb: s.awb, direction: 'IN', client_ref: 'dev1-1' });
  assert.equal(dup.body.duplicate, true, 'idempotent client_ref');
  assert.equal((await as('warehouse').post('/api/warehouse/scan', { awb: s.awb, direction: 'IN' })).body.result, 'WARNING');
  const noDriver = await as('warehouse').post('/api/warehouse/scan', { awb: s.awb, direction: 'OUT', purpose: 'DELIVERY' });
  assert.equal(noDriver.body.result, 'EXCEPTION');
  const out = await as('warehouse').post('/api/warehouse/scan', { awb: s.awb, direction: 'OUT', purpose: 'DELIVERY', driver_id: d1 });
  assert.equal(out.body.result, 'OK');
  assert.equal(out.body.shipment.status, 'OUT_FOR_DELIVERY');
  assert.equal((await as('warehouse').post('/api/warehouse/scan', { awb: 'ABC999999990', direction: 'IN' })).body.result, 'EXCEPTION');

  // Delivery: wrong COD rejected, correct accepted
  assert.equal((await as('driver1').post(`/api/driver/shipments/${s.id}/deliver`, { receiver_name: 'R', signature: SIG })).status, 400);
  const del = await as('driver1').post(`/api/driver/shipments/${s.id}/deliver`, { receiver_name: 'Receiver X', signature: SIG, cod_collected: 250, cod_method: 'CASH' });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.equal(del.body.status, 'DELIVERED');

  const wallet = await as('driver1').get('/api/driver/wallet');
  assert.ok(wallet.body.cash_in_hand >= 250);

  // Settlement must match exactly
  assert.equal((await as('finance').post(`/api/finance/driver-cash/${d1}/settle`, { amount_received: 1 })).status, 400);
  const settle = await as('finance').post(`/api/finance/driver-cash/${d1}/settle`, { amount_received: wallet.body.cash_in_hand });
  assert.equal(settle.status, 201, JSON.stringify(settle.body));
  assert.equal((await as('driver1').get('/api/driver/wallet')).body.cash_in_hand, 0);

  const cid = db.get('SELECT customer_id FROM shipments WHERE id = ?', s.id).customer_id;
  const remit = await as('finance').post(`/api/finance/cod/${cid}/remit`, { reference: 'TT-1' });
  assert.equal(remit.status, 201);

  const tr = await request(app).get(`/api/public/track/${s.awb}`);
  assert.equal(tr.body.status, 'DELIVERED');
  assert.ok(!tr.body.events.some((e) => /GPS check/.test(e.note || '')), 'internal events hidden');
});

test('driver on-the-spot booking & billing (walk-in cash)', async () => {
  const q = await as('driver2').post('/api/driver/quote', { service: 'EXPRESS', origin_city: 'Dubai', dest_city: 'Ajman', weight: 6 });
  const total = q.body.quotes.find((x) => x.service === 'EXPRESS').total_charge;
  assert.equal((await as('driver2').post('/api/driver/bookings', parcel({ dest_city: 'Ajman', weight: 6 }))).status, 400, 'payment required');
  const b = await as('driver2').post('/api/driver/bookings', parcel({ dest_city: 'Ajman', weight: 6, payment: { method: 'CASH', amount: total }, lat: 25.1, lng: 55.2 }));
  assert.equal(b.status, 201, JSON.stringify(b.body));
  assert.equal(b.body.invoice.status, 'PAID');
  assert.equal(b.body.shipment.status, 'PICKED_UP');
  const inv = await as('driver2').get(`/api/driver/invoices/${b.body.invoice.id}`);
  assert.equal(inv.status, 200);
  assert.equal(inv.body.lines.length, 1);
});

test('finance: account billing run, partial payment, overpay rejected', async () => {
  const cid = db.get("SELECT id FROM customers WHERE name = 'Desert Bloom Trading LLC'").id;
  const gen = await as('finance').post('/api/finance/invoices/generate', { customer_id: cid });
  assert.equal(gen.status, 201, JSON.stringify(gen.body));
  assert.equal(gen.body.type, 'CREDIT');
  assert.ok(gen.body.lines.length > 0);
  assert.equal((await as('finance').post(`/api/finance/invoices/${gen.body.id}/payments`, { amount: gen.body.total + 1, method: 'BANK' })).status, 400);
  const p = await as('finance').post(`/api/finance/invoices/${gen.body.id}/payments`, { amount: 10, method: 'BANK', reference: 'TT' });
  assert.equal(p.body.status, 'PARTIAL');
  const mine = await as('customer').get(`/api/customer/invoices/${gen.body.id}`);
  assert.equal(mine.status, 200);
  const other = await as('shop').get(`/api/customer/invoices/${gen.body.id}`);
  assert.equal(other.status, 404, 'customer isolation');
});

test('customer prepaid booking + demo online payment + cancel rules', async () => {
  const b = await as('shop').post('/api/customer/shipments', parcel({ pay_online: true }));
  assert.equal(b.status, 201);
  assert.equal(b.body.shipment.payment_mode, 'PREPAID');
  const pay = await as('shop').post(`/api/customer/invoices/${b.body.invoice.id}/pay`, {});
  assert.equal(pay.body.status, 'PAID');
  assert.equal((await as('shop').post(`/api/customer/shipments/${b.body.shipment.id}/cancel`, {})).status, 409, 'paid cannot self-cancel');
  const b2 = await as('shop').post('/api/customer/shipments', parcel());
  assert.equal((await as('shop').post(`/api/customer/shipments/${b2.body.shipment.id}/cancel`, {})).status, 200);
});

test('CRM: lead lifecycle → convert → 360, tickets with SLA and private notes', async () => {
  const l = await as('sales').post('/api/crm/leads', { company: 'Test Co', contact_name: 'Buyer', phone: '+971500000123', est_monthly_value: 5000 });
  assert.equal(l.status, 201);
  assert.equal((await as('sales').post('/api/crm/activities', { entity: 'LEAD', entity_id: l.body.id, type: 'CALL', subject: 'Intro call', done: true })).status, 201);
  assert.equal(db.get('SELECT stage FROM leads WHERE id = ?', l.body.id).stage, 'CONTACTED');
  assert.equal((await as('sales').patch(`/api/crm/leads/${l.body.id}`, { stage: 'LOST' })).status, 409, 'lost needs reason');
  assert.equal((await as('sales').patch(`/api/crm/leads/${l.body.id}`, { stage: 'PROPOSAL' })).body.probability, 60);
  const conv = await as('sales').post(`/api/crm/leads/${l.body.id}/convert`, { type: 'ACCOUNT', credit_limit: 10000 });
  assert.equal(conv.status, 201);
  const c360 = await as('sales').get(`/api/crm/customers/${conv.body.id}/360`);
  assert.equal(c360.body.contacts.length, 1);
  assert.equal((await as('sales').put(`/api/admin/customers/${conv.body.id}`, { ...conv.body, credit_limit: 99999 })).status, 409, 'sales cannot change credit');
  const pipe = await as('sales').get('/api/crm/pipeline');
  assert.equal(pipe.body.stages.length, 7);

  const awb = db.get("SELECT awb FROM shipments WHERE customer_id = (SELECT customer_id FROM users WHERE email='customer@abccargo.demo') LIMIT 1").awb;
  const t = await as('customer').post('/api/customer/tickets', { awb, category: 'DAMAGE', subject: 'Box damaged' });
  assert.equal(t.status, 201);
  assert.equal(t.body.priority, 'HIGH');
  await as('ops').post(`/api/crm/tickets/${t.body.id}/comments`, { body: 'Internal: check CCTV', internal: true });
  await as('ops').post(`/api/crm/tickets/${t.body.id}/comments`, { body: 'We are investigating', internal: false });
  const view = await as('customer').get(`/api/customer/tickets/${t.body.id}`);
  assert.equal(view.body.comments.length, 1, 'internal note hidden from customer');
  assert.equal((await as('ops').patch(`/api/crm/tickets/${t.body.id}`, { status: 'RESOLVED' })).body.status, 'RESOLVED');
});

test('admin: deactivating a user revokes their session', async () => {
  const u = await as('admin').post('/api/admin/users', { name: 'Temp Driver', email: 'temp@abccargo.demo', role: 'DRIVER', password: 'Temp12345' });
  assert.equal(u.status, 201);
  const login = await request(app).post('/api/auth/login').send({ email: 'temp@abccargo.demo', password: 'Temp12345' });
  const t = login.body.token;
  assert.equal((await request(app).get('/api/driver/tasks').set('Authorization', `Bearer ${t}`)).status, 200);
  await as('admin').put(`/api/admin/users/${u.body.id}`, { name: 'Temp Driver', email: 'temp@abccargo.demo', role: 'DRIVER', active: false });
  assert.equal((await request(app).get('/api/driver/tasks').set('Authorization', `Bearer ${t}`)).status, 401);
});

test('reports & live map', async () => {
  const d = await as('ops').get('/api/reports/dashboard');
  assert.equal(d.status, 200);
  assert.equal(d.body.days.length, 14);
  const live = await as('ops').get('/api/routing/live');
  assert.ok(live.body.drivers.some((x) => x.online === 1));
});
