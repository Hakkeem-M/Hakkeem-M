// Domain-based regional login: abccargo.uk → UK, abccargo.ae → UAE, abccargogcc.com → KSA, abccargo.com → group admin.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { seedBase, seedDemo, DEMO_PASSWORD } from '../src/seed.js';

let app;
before(() => {
  const db = openDb(':memory:');
  seedBase(db);
  seedDemo(db);
  app = createApp({ db, config: { jwtSecret: 'x'.repeat(40), jwtTtl: '1h', loginRateLimit: 1000, paymentsDemo: true, mapTileHosts: [], production: false } });
});
const login = (host, email, extra = {}) => request(app).post('/api/auth/login').set('Host', host)
  .send({ email, password: DEMO_PASSWORD, app: 'erp', ...extra });

test('each domain serves its region and admits only that region’s accounts', async () => {
  for (const [host, code] of [['abccargo.uk', 'GB'], ['erp.abccargo.uk', 'GB'], ['www.abccargo.ae', 'AE'], ['abccargogcc.com', 'SA'], ['abccargo.com', 'GROUP'], ['localhost', null]]) {
    assert.equal((await request(app).get('/api/public/site').set('Host', host)).body.region, code, host);
  }
  const uk = await login('abccargo.uk', 'ops.uk@abccargo.demo');
  assert.equal(uk.status, 200, uk.text);
  assert.equal(uk.body.region, 'GB');
  const wrong = await login('abccargo.uk', 'ops@abccargo.demo');
  assert.equal(wrong.status, 403);
  assert.match(wrong.body.error, /abccargo\.ae/);
  // Region sent by an old client cannot override the domain
  assert.equal((await login('abccargo.uk', 'ops.ksa@abccargo.demo', { region: 'SA' })).status, 403);
  assert.equal((await login('abccargogcc.com', 'ops.ksa@abccargo.demo')).body.region, 'SA');
});

test('group site is for group admins; group admin on a regional site works in that region', async () => {
  const g = await login('abccargo.com', 'admin@abccargo.demo');
  assert.equal(g.status, 200, g.text);
  assert.equal(g.body.region, null, 'all regions');
  const reg = await login('abccargo.com', 'ops.uk@abccargo.demo');
  assert.equal(reg.status, 403);
  assert.match(reg.body.error, /abccargo\.uk/);
  assert.equal((await login('abccargo.ae', 'admin@abccargo.demo')).body.region, 'AE');
  // Unmapped host (dev / demo): no region needed, account region applies
  const dev = await login('localhost', 'ops.india@abccargo.demo');
  assert.equal(dev.status, 200);
  assert.equal(dev.body.region, 'IN');
});

test('customer registering on a regional site is created in that region', async () => {
  const r = await request(app).post('/api/auth/register').set('Host', 'abccargo.uk')
    .send({ name: 'Site Customer', email: 'site.customer@example.invalid', phone: '+447700900321', password: 'Passw0rd!x', region: 'AE' });
  assert.equal(r.status, 201, r.text);
  const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${r.body.token}`);
  assert.equal(me.body.entity_code, 'GB');
});
