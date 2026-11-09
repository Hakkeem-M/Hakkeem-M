// Agent inbox (omnichannel enquiries) and the pickups & deliveries board.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { seedBase, seedDemo, DEMO_PASSWORD } from '../src/seed.js';

let app;
const tok = {};
const as = (who) => {
  const h = (rq) => rq.set('Authorization', `Bearer ${tok[who]}`);
  return { get: (u) => h(request(app).get(u)), post: (u, b) => h(request(app).post(u)).send(b), put: (u, b) => h(request(app).put(u)).send(b) };
};

before(async () => {
  const db = openDb(':memory:');
  seedBase(db);
  seedDemo(db);
  app = createApp({ db, config: { jwtSecret: 'x'.repeat(40), jwtTtl: '1h', loginRateLimit: 1000, paymentsDemo: true, mapTileHosts: [], production: false } });
  for (const [who, email, region] of [['salesUK', 'sales.uk@abccargo.demo', 'GB'], ['opsUK', 'ops.uk@abccargo.demo', 'GB'],
    ['opsAE', 'ops@abccargo.demo', 'AE'], ['driverUK', 'driver.uk@abccargo.demo', 'GB'], ['whUK', 'warehouse.uk@abccargo.demo', 'GB']]) {
    const r = await request(app).post('/api/auth/login').send({ email, password: DEMO_PASSWORD, region, app: who.startsWith('driver') ? 'driver' : 'erp' });
    assert.equal(r.status, 200, `${email}: ${r.text}`);
    tok[who] = r.body.token;
  }
});

const collection = (extra = {}) => ({
  channel: 'WHATSAPP', lead_type: 'COLLECTION', customer_name: 'Test Sender UK', mobile: '+447700900555', email: 'sender@example.invalid',
  address1: '10 Test Road', city: 'London', postcode: 'E1 6AN', lat: 51.515, lng: -0.072,
  service: 'INTL_EXPRESS', dest_country: 'IN', dest_city: 'Kochi', pieces: 2, weight_kg: 12, contents: 'Clothes',
  receiver_name: 'Kochi Receiver', receiver_phone: '+919800000555', receiver_address: 'MG Road', pickup_window: '14:00-16:00',
  description: 'Customer wants two boxes collected today', ...extra,
});

test('collection enquiry is booked straight away and auto-assigned to the nearest UK driver', async () => {
  const r = await as('salesUK').post('/api/inbox', collection());
  assert.equal(r.status, 201, r.text);
  assert.match(r.body.ref, /^ENQ-GB-\d{6}$/);
  assert.equal(r.body.status, 'BOOKED');
  assert.ok(r.body.booking.awb);
  assert.ok(r.body.booking.driver, 'driver auto-assigned');
  assert.equal(r.body.shipment.status, 'PICKUP_ASSIGNED');
  assert.equal(r.body.shipment.entity_code, 'GB');
  assert.equal(r.body.shipment.currency, 'GBP');
  assert.ok(r.body.messages.some((m) => m.direction === 'IN' && /two boxes/.test(m.body)));
  assert.ok(r.body.messages.some((m) => m.direction === 'SYSTEM' && /auto-assigned/.test(m.body)));
  // Duplicate check finds the enquiry and the auto-created customer
  const d = await as('salesUK').get('/api/inbox/duplicates?mobile=%2B447700900555');
  assert.ok(d.body.enquiries.length >= 1 && d.body.customers.length === 1);
  // UAE staff cannot see a UK enquiry
  assert.equal((await as('opsAE').get(`/api/inbox/${r.body.id}`)).status, 404);
  assert.ok(!(await as('opsAE').get('/api/inbox?view=all')).body.rows.some((x) => x.id === r.body.id));
});

test('incomplete collection stays open with an actionable error; quote request becomes a direct quotation', async () => {
  const r = await as('salesUK').post('/api/inbox', collection({ mobile: '+447700900556', receiver_name: '', receiver_phone: '' }));
  assert.equal(r.status, 201);
  assert.equal(r.body.status, 'NEW');
  const b = await as('salesUK').post(`/api/inbox/${r.body.id}/book`, {});
  assert.equal(b.status, 400);
  assert.match(b.body.error, /receiver name/);
  await as('salesUK').put(`/api/inbox/${r.body.id}`, { receiver_name: 'Later Receiver', receiver_phone: '+919800000556' });
  const ok = await as('salesUK').post(`/api/inbox/${r.body.id}/book`, {});
  assert.equal(ok.status, 201, ok.text);
  assert.equal(ok.body.status, 'BOOKED');

  const q = await as('salesUK').post('/api/inbox', { channel: 'EMAIL', lead_type: 'QUOTE', customer_name: 'Price Shopper', mobile: '+447700900557', email: 'price@example.invalid', description: 'How much to Dubai?' });
  assert.equal(q.body.status, 'NEW');
  const quote = await as('salesUK').post('/api/quotations', {
    enquiry_id: q.body.id, service: 'INTL_EXPRESS', origin_city: 'London', dest_country: 'AE', dest_city: 'Dubai', weight: 5, product: 'DOCUMENT',
    shipper_name: 'Price Shopper', shipper_phone: '+447700900557', shipper_address: '1 Quote St, London',
    consignee_name: 'Dubai Friend', consignee_phone: '+971500000557', consignee_address: 'Marina, Dubai',
  });
  assert.equal(quote.status, 201, quote.text);
  const after = await as('salesUK').get(`/api/inbox/${q.body.id}`);
  assert.equal(after.body.status, 'QUOTED');
  assert.equal(after.body.quotation_number, quote.body.number);
  const conv = await as('salesUK').post(`/api/quotations/${quote.body.id}/convert`, {});
  assert.equal(conv.status, 201, conv.text);
  assert.equal((await as('salesUK').get(`/api/inbox/${q.body.id}`)).body.status, 'BOOKED');
});

test('incoming PABX / WhatsApp threads into the open enquiry; callback, lost and stats', async () => {
  const a = await as('salesUK').post('/api/inbox/incoming', { channel: 'PHONE', from: '+447700900600', name: 'Caller One', body: 'Calling about a parcel to Lagos' });
  assert.equal(a.status, 201, a.text);
  const b = await as('salesUK').post('/api/inbox/incoming', { channel: 'PHONE', from: '+447700900600', body: 'Called again' });
  assert.equal(b.body.id, a.body.id, 'same open enquiry');
  assert.equal(b.body.messages.filter((m) => m.direction === 'IN').length, 2);
  assert.equal((await as('salesUK').post('/api/inbox/incoming', { channel: 'EMAIL', from: 'not-an-email', body: 'x' })).status, 400);
  const cb = await as('salesUK').post(`/api/inbox/${a.body.id}/callback`, { at: '2099-01-01T10:00' });
  assert.equal(cb.body.next_action_at, '2099-01-01 10:00');
  assert.equal(cb.body.overdue, 0);
  const reply = await as('salesUK').post(`/api/inbox/${a.body.id}/messages`, { body: 'We will call you back tomorrow' });
  assert.ok(reply.body.messages.some((m) => m.direction === 'OUT' && m.channel === 'PHONE'));
  const lost = await as('salesUK').post(`/api/inbox/${a.body.id}/lost`, { reason: 'Price too high' });
  assert.equal(lost.body.status, 'LOST');
  const st = await as('salesUK').get('/api/inbox/stats');
  assert.ok(st.body.booked >= 2 && st.body.lost >= 1 && st.body.win_rate > 0);
  assert.equal((await as('whUK').get('/api/inbox')).status, 403, 'warehouse has no inbox access');
});

test('pickups board: start, missed back to pool, reassign, collected, postpone and cancel', async () => {
  const mk = async (m) => (await as('salesUK').post('/api/inbox', collection({ mobile: m }))).body.shipment;
  const s1 = await mk('+447700900701');
  let board = (await as('opsUK').get('/api/pickups')).body;
  assert.ok(board.scheduled.some((x) => x.id === s1.id));
  const st = await as('opsUK').post(`/api/pickups/${s1.id}/start`, {});
  assert.equal(st.status, 200, st.text);
  board = (await as('opsUK').get('/api/pickups')).body;
  assert.ok(board.en_route.some((x) => x.id === s1.id));
  assert.equal((await as('opsUK').post(`/api/pickups/${s1.id}/start`, {})).status, 409);
  const miss = await as('opsUK').post(`/api/pickups/${s1.id}/missed`, { reason: 'Customer not available' });
  assert.equal(miss.body.status, 'BOOKED');
  assert.equal(miss.body.driver_id, null);
  board = (await as('opsUK').get('/api/pickups')).body;
  assert.ok(board.missed.some((x) => x.id === s1.id));
  const re = await as('opsUK').post(`/api/pickups/${s1.id}/assign`, {});
  assert.equal(re.body.status, 'PICKUP_ASSIGNED', re.text);
  const col = await as('opsUK').post(`/api/pickups/${s1.id}/collected`, {});
  assert.equal(col.body.status, 'PICKED_UP');
  board = (await as('opsUK').get('/api/pickups')).body;
  assert.ok(board.completed.some((x) => x.id === s1.id));

  const s2 = await mk('+447700900702');
  const pp = await as('opsUK').post(`/api/pickups/${s2.id}/postpone`, { date: '2099-02-01', window: '09:00-11:00' });
  assert.equal(pp.body.pickup_date, '2099-02-01');
  assert.ok(!(await as('opsUK').get('/api/pickups')).body.scheduled.some((x) => x.id === s2.id), 'postponed out of today');
  const cn = await as('opsUK').post(`/api/pickups/${s2.id}/cancel`, { reason: 'Customer cancelled' });
  assert.equal(cn.body.status, 'CANCELLED');
  assert.equal((await as('opsAE').get('/api/pickups')).body.scheduled.some((x) => x.id === s1.id), false);

  // Driver app: start then can't collect
  const s3 = await mk('+447700900703');
  const drv = (await as('driverUK').get('/api/driver/tasks')).body;
  const mine = JSON.stringify(drv).includes(s3.awb);
  if (mine) {
    assert.equal((await as('driverUK').post(`/api/driver/shipments/${s3.id}/start`, {})).status, 200);
    const m = await as('driverUK').post(`/api/driver/shipments/${s3.id}/pickup-missed`, { reason: 'Goods not ready' });
    assert.equal(m.status, 200, m.text);
  }
});
