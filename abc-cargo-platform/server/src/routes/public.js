import { Router } from 'express';
import { siteRegion } from '../lib/site.js';
import rateLimit from 'express-rate-limit';
import { SERVICES, ZONES, CITIES, quoteAll } from '../lib/pricing.js';
import { settingsFor, packingMap, entityRow, DEFAULT_ENTITY } from '../lib/entity.js';
import { STATUS_LABEL } from '../lib/shipments.js';
import { validate, notFound, normalizeAwb, isValidAwb, badRequest } from '../lib/util.js';
import { quoteInput } from '../lib/schemas.js';

const r = Router();
const limiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false });
r.use(limiter);

// Public metadata for one region (?entity=AE|GB|SA|IN). Region list is always included for the login / region picker.
// Which region this site (domain) serves: AE, GB, SA, IN, GROUP, or null on other hosts.
r.get('/site', (req, res) => res.json({ region: siteRegion(req) }));

r.get('/meta', (req, res) => {
  const code = String(req.query.entity || DEFAULT_ENTITY).toUpperCase();
  const e = entityRow(req.db, code) ? code : DEFAULT_ENTITY;
  const s = settingsFor(req.db, e);
  res.json({
    entity: e,
    entities: req.db.all('SELECT code, name, currency, vat_rate_pct, tax_label, phone_prefix FROM entities WHERE active = 1 ORDER BY rowid'),
    company: { name: s.company_name, trn: s.company_trn, tax_label: s.tax_label, phone: s.company_phone, email: s.company_email, address: s.company_address },
    services: SERVICES, zones: ZONES, cities: Object.keys(CITIES[e] || {}), statuses: STATUS_LABEL,
    countries: Object.fromEntries(req.db.all('SELECT code, name FROM countries WHERE active = 1 ORDER BY name').map((c) => [c.code, c.name])),
    country_list: req.db.all('SELECT code, name, zone, airport FROM countries WHERE active = 1 AND code != ? ORDER BY name', e),
    packing_types: req.db.all("SELECT code, name, amount FROM price_list WHERE entity_code = ? AND kind = 'PACKING' AND active = 1 ORDER BY amount", e),
    currency: s.currency,
  });
});

const mask = (name) => (name ? name.split(/\s+/).map((p) => p[0] + '*'.repeat(Math.max(1, p.length - 1))).join(' ') : null);

// Public tracking — exposes no addresses, phone numbers or charges.
r.get('/track/:awb', (req, res) => {
  const awb = normalizeAwb(req.params.awb);
  if (!isValidAwb(awb)) throw badRequest('Invalid AWB number');
  const s = req.db.get(
    `SELECT s.id, s.awb, s.service, s.status, s.origin_city, s.dest_city, s.dest_country, s.pieces, s.chargeable_weight,
            s.created_at, s.delivered_at, s.pod_name, s.attempts, s.shipment_type, s.product, s.customs_status, s.agent_tracking,
            co.name AS dest_country_name, m.flight_no, m.flight_date, m.dest_airport, a.name AS agent_name, a.tracking_url
       FROM shipments s LEFT JOIN countries co ON co.code = s.dest_country LEFT JOIN manifests m ON m.id = s.manifest_id
       LEFT JOIN agents a ON a.id = s.agent_id WHERE s.awb = ?`, awb,
  );
  if (!s) throw notFound('Shipment');
  const events = req.db.all(
    'SELECT status, location, note, created_at FROM shipment_events WHERE shipment_id = ? AND public = 1 ORDER BY id DESC', s.id,
  );
  delete s.id;
  res.json({ ...s, pod_name: mask(s.pod_name), status_label: STATUS_LABEL[s.status], events });
});

r.post('/quote', validate(quoteInput), (req, res) => {
  const e = req.body.entity && entityRow(req.db, req.body.entity) ? req.body.entity : DEFAULT_ENTITY;
  const quotes = quoteAll(req.db, settingsFor(req.db, e), req.body, packingMap(req.db, e));
  res.json({ quotes: req.body.service ? quotes.filter((q) => q.service === req.body.service) : quotes });
});

r.get('/branches', (req, res) => {
  res.json(req.db.all('SELECT id, code, name, city FROM branches WHERE active = 1 ORDER BY id'));
});

export default r;
