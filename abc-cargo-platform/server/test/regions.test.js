// Multi-region (UAE, UK, KSA, India): regional login, data isolation, multi-box/sea pricing, quotations, receivers, KYC.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { seedBase, seedDemo, DEMO_PASSWORD } from '../src/seed.js';

let app;
let db;
const tok = {};
const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const login = async (email, region, appName) => request(app).post('/api/auth/login').send({ email, password: DEMO_PASSWORD, region, app: appName });
const as = (who, entity) => {
  const h = (rq) => { rq.set('Authorization', `Bearer ${tok[who]}`); if (entity) rq.set('X-Entity', entity); return rq; };
  return {
    get: (u) => h(request(app).get(u)),
    post: (u, b) => h(request(app).post(u)).send(b),
    put: (u, b) => h(request(app).put(u)).send(b),
  };
};
const ukBooking = (extra = {}) => ({
  service: 'SEA_CARGO', origin_city: 'London', dest_country: 'IN', dest_city: 'Kochi', product: 'PARCEL', incoterm: 'DAP',
  shipper_name: 'UK Sender', shipper_phone: '+447700900111', shipper_address: '1 High Street, London',
  consignee_name: 'Kerala Receiver', consignee_phone: '+919800000111', consignee_address: 'House 1, MG Road', consignee_postcode: '682001',
  boxes: [
    { actual_weight: 30, length: 60, width: 50, height: 50, packing_type: 'BOX_L', category: 'Household' },
    { actual_weight: 25, length: 50, width: 50, height: 40, packing_type: 'BOX_M', category: 'Household' },
    { actual_weight: 12, length: 40, width: 30, height: 30, packing_type: 'NONE', category: 'Food' },
  ],
  items: [{ description: 'Clothing', hs_code: '620520', qty: 30, unit_value: 5, box_seq: 1 }, { description: 'Dry food', hs_code: '190590', qty: 10, unit_value: 3, box_seq: 3 }],
  handling_charge: 10, save_receiver: true,
  ...extra,
});

before(async () => {
  db = openDb(':memory:');
  seedBase(db);
  seedDemo(db);
  app = createApp({ db, config: { jwtSecret: 'x'.repeat(40), jwtTtl: '1h', loginRateLimit: 1000, paymentsDemo: true, mapTileHosts: [], production: false } });
  for (const [who, email, region] of [
    ['admin', 'admin@abccargo.demo', 'GROUP'], ['opsAE', 'ops@abccargo.demo', 'AE'], ['opsUK', 'ops.uk@abccargo.demo', 'GB'],
    ['salesUK', 'sales.uk@abccargo.demo', 'GB'], ['whUK', 'warehouse.uk@abccargo.demo', 'GB'], ['opsIN', 'ops.india@abccargo.demo', 'IN'],
    ['opsSA', 'ops.ksa@abccargo.demo', 'SA'], ['custUK', 'customer.uk@abccargo.demo', 'GB'],
  ]) {
    const r = await login(email, region);
    assert.equal(r.status, 200, `${who}: ${JSON.stringify(r.body)}`);
    tok[who] = r.body.token;
  }
});

test('regional login: own region only; group admin any region', async () => {
  const wrong = await login('ops.uk@abccargo.demo', 'AE');
  assert.equal(wrong.status, 403);
  assert.match(wrong.body.error, /UK/);
  assert.equal((await login('admin@abccargo.demo', 'IN')).status, 200);
  const me = await as('opsUK').get('/api/auth/me');
  assert.equal(me.body.entity.currency, 'GBP');
  assert.equal(me.body.regions.length, 4);
});

test('data isolation between regions', async () => {
  const uk = await as('opsUK').get('/api/shipments?limit=200');
  assert.ok(uk.body.rows.length > 0);
  assert.ok(uk.body.rows.every((s) => s.entity_code === 'GB' && s.currency === 'GBP'));
  const aeShip = db.get("SELECT id, awb FROM shipments WHERE entity_code = 'AE' LIMIT 1");
  assert.equal((await as('opsUK').get(`/api/shipments/${aeShip.id}`)).status, 404, 'cannot open another region');
  assert.equal((await as('opsUK').get(`/api/shipments/awb/${aeShip.awb}`)).status, 404);
  const allAdmin = await as('admin').get('/api/shipments?limit=200');
  assert.ok(new Set(allAdmin.body.rows.map((s) => s.entity_code)).size >= 3, 'group admin sees all regions');
  const adminIN = await as('admin', 'IN').get('/api/shipments?limit=200');
  assert.ok(adminIN.body.rows.every((s) => s.entity_code === 'IN'), 'X-Entity narrows group admin');
  // customers, invoices, users, dashboard
  assert.ok((await as('opsUK').get('/api/admin/customers')).body.every((c) => c.entity_code === 'GB'));
  const users = await as('opsUK').get('/api/admin/users');
  assert.ok(users.body.every((u) => u.entity_code === 'GB'));
  const dash = await as('opsUK').get('/api/reports/dashboard');
  assert.equal(dash.status, 200);
  assert.equal(dash.body.currency, 'GBP');
  assert.equal(dash.body.regions.length, 1);
  const groupDash = await as('admin').get('/api/reports/dashboard');
  assert.equal(groupDash.body.regions.length, 4);
  // UK warehouse cannot scan AE parcel
  const ukBranch = db.get("SELECT id FROM branches WHERE code = 'LON-HO'").id;
  const scan = await as('whUK').post('/api/warehouse/scan', { awb: aeShip.awb, direction: 'IN', branch_id: ukBranch });
  assert.equal(scan.body.result, 'EXCEPTION');
});

test('UK multi-box sea cargo booking: boxes, CBM, packing, GBP, zero-rated export', async () => {
  const cust = db.get("SELECT id FROM customers WHERE entity_code = 'GB' AND type = 'ACCOUNT' LIMIT 1").id;
  const r = await as('opsUK').post('/api/shipments', ukBooking({ customer_id: cust }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const s = r.body;
  assert.equal(s.currency, 'GBP');
  assert.equal(s.mode, 'SEA');
  assert.equal(s.box_count, 3);
  assert.equal(s.boxes.length, 3);
  assert.ok(s.boxes[0].label.endsWith('-01'));
  assert.equal(s.weight, 67);
  assert.equal(s.cbm, 0.286);
  assert.ok(s.packing_charge > 0);
  assert.equal(s.handling_charge, 10);
  assert.equal(s.vat, 0);
  assert.equal(s.items.find((i) => i.box_seq === 3).description, 'Dry food');
  assert.ok(s.receiver_id, 'receiver saved');
  // AE customer cannot be booked by UK ops
  const aeCust = db.get("SELECT id FROM customers WHERE entity_code = 'AE' LIMIT 1").id;
  assert.equal((await as('opsUK').post('/api/shipments', ukBooking({ customer_id: aeCust }))).status, 404);
});

test('domestic VAT per region: UK 20%, India GST 18%, KSA 15%', async () => {
  const q = async (entity, origin, dest) => (await request(app).post('/api/public/quote').send({ entity, origin_city: origin, dest_city: dest, dest_country: entity, weight: 3 })).body.quotes;
  const uk = await q('GB', 'London', 'Manchester');
  assert.ok(uk.length && uk.every((x) => x.vat_rate === 20 && x.currency === 'GBP'));
  const ind = await q('IN', 'Kochi', 'Mumbai');
  assert.ok(ind.every((x) => x.vat_rate === 18 && x.currency === 'INR'));
  const ksa = await q('SA', 'Riyadh', 'Jeddah');
  assert.ok(ksa.every((x) => x.vat_rate === 15 && x.currency === 'SAR'));
  const intl = (await request(app).post('/api/public/quote').send({ entity: 'IN', origin_city: 'Kochi', dest_city: 'Dubai', dest_country: 'AE', weight: 3 })).body.quotes;
  assert.ok(intl.some((x) => x.service === 'SEA_CARGO') && intl.every((x) => x.vat_rate === 0));
});

test('quotation → accept → convert creates customer + booking (UK)', async () => {
  const q = await as('salesUK').post('/api/quotations', { ...ukBooking(), contact_name: 'New UK Prospect', contact_phone: '+447700900555' });
  assert.equal(q.status, 201, JSON.stringify(q.body));
  assert.match(q.body.number, /^QT-GB-/);
  assert.equal(q.body.currency, 'GBP');
  assert.ok(q.body.total > 0);
  assert.equal((await as('opsAE').get(`/api/quotations/${q.body.id}`)).status, 404, 'other region cannot see quote');
  await as('salesUK').post(`/api/quotations/${q.body.id}/status`, { status: 'ACCEPTED' });
  const conv = await as('salesUK').post(`/api/quotations/${q.body.id}/convert`, {});
  assert.equal(conv.status, 201, JSON.stringify(conv.body));
  assert.equal(conv.body.quotation.status, 'CONVERTED');
  assert.equal(conv.body.shipment.quotation_id, q.body.id);
  assert.equal(conv.body.shipment.box_count, 3);
  assert.equal(db.get('SELECT entity_code FROM customers WHERE id = ?', conv.body.shipment.customer_id).entity_code, 'GB');
  assert.equal((await as('salesUK').post(`/api/quotations/${q.body.id}/convert`, {})).status, 409);
});

test('saved receivers: staff + customer app; KYC documents restricted and audited', async () => {
  const cust = db.get("SELECT c.id FROM customers c JOIN users u ON u.customer_id = c.id WHERE u.email = 'customer.uk@abccargo.demo'").id;
  const staffList = await as('opsUK').get(`/api/quotations/customers/${cust}/receivers`);
  assert.equal(staffList.status, 200);
  assert.ok(staffList.body.length >= 1);
  const add = await as('custUK').post('/api/customer/receivers', { name: 'Aunt (demo)', phone: '+919800000222', country: 'IN', city: 'Kozhikode', address: 'Beach Road' });
  assert.equal(add.status, 201);
  assert.ok((await as('custUK').get('/api/customer/receivers')).body.some((r) => r.name === 'Aunt (demo)'));
  assert.equal((await as('opsAE').get(`/api/quotations/customers/${cust}/receivers`)).status, 404);

  const doc = await as('opsUK').post('/api/quotations/documents', { owner_type: 'CUSTOMER', owner_id: cust, doc_type: 'PASSPORT', doc_no: 'X1234567', expiry: '2030-01-01', front_image: IMG });
  assert.equal(doc.status, 201, JSON.stringify(doc.body));
  const list = await as('opsUK').get(`/api/quotations/documents?owner_type=CUSTOMER&owner_id=${cust}`);
  assert.equal(list.body[0].has_front, 1);
  assert.equal(list.body[0].front_image, undefined, 'list never returns images');
  assert.equal((await as('whUK').get(`/api/quotations/documents/${doc.body.id}/front`)).status, 403, 'warehouse cannot view ID images');
  const view = await as('opsUK').get(`/api/quotations/documents/${doc.body.id}/front`);
  assert.equal(view.body.image, IMG);
  assert.ok(db.get("SELECT id FROM audit_log WHERE action = 'kyc.view'"));
  assert.equal((await as('opsAE').get(`/api/quotations/documents/${doc.body.id}/front`)).status, 404);
  assert.equal((await as('opsUK').post('/api/quotations/documents', { owner_type: 'CUSTOMER', owner_id: cust, doc_type: 'PASSPORT', expiry: '2020-01-01' })).status, 400, 'expired ID rejected');
});

test('sea consolidation manifest: sea only, same region, sails with vessel', async () => {
  const s = db.get("SELECT * FROM shipments WHERE entity_code = 'GB' AND mode = 'SEA' AND dest_country = 'IN' ORDER BY id DESC LIMIT 1");
  db.run("UPDATE shipments SET status = 'IN_WAREHOUSE', branch_id = (SELECT id FROM branches WHERE code = 'LON-HO') WHERE id = ?", s.id);
  const m = await as('opsUK').post('/api/intl/manifests', { mode: 'SEA_CONSOL', dest_airport: 'INCOK', vessel: 'Demo Vessel', flight_no: 'V001', container_no: 'MSKU1234567', mawb_no: 'BL-DEMO-0001' });
  assert.equal(m.status, 201, JSON.stringify(m.body));
  assert.equal(m.body.origin_airport, 'GBFXT');
  assert.equal(m.body.entity_code, 'GB');
  const air = db.get("SELECT awb FROM shipments WHERE entity_code = 'GB' AND mode = 'AIR' LIMIT 1");
  db.run("UPDATE shipments SET status = 'IN_WAREHOUSE' WHERE awb = ?", air.awb);
  assert.equal((await as('opsUK').post(`/api/intl/manifests/${m.body.id}/add`, { awb: air.awb })).status, 409, 'air not on sea manifest');
  const add = await as('opsUK').post(`/api/intl/manifests/${m.body.id}/add`, { awb: s.awb });
  assert.equal(add.status, 200, JSON.stringify(add.body));
  assert.equal((await as('opsUK').post(`/api/intl/manifests/${m.body.id}/close`)).status, 200);
  const dep = await as('opsUK').post(`/api/intl/manifests/${m.body.id}/depart`, {});
  assert.equal(dep.body.status, 'DEPARTED');
  const ev = db.get("SELECT note FROM shipment_events WHERE shipment_id = ? AND status = 'DEPARTED'", s.id);
  assert.match(ev.note, /Sailed from GBFXT on Demo Vessel/);
  assert.equal((await as('opsAE').get(`/api/intl/manifests/${m.body.id}`)).status, 404);
});
