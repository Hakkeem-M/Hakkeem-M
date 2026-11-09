import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { getSettings } from '../db.js';
import { SERVICES, ZONES, UAE_CITIES, quoteAll } from '../lib/pricing.js';
import { STATUS_LABEL } from '../lib/shipments.js';
import { validate, notFound, normalizeAwb, isValidAwb, badRequest } from '../lib/util.js';
import { quoteInput } from '../lib/schemas.js';

const r = Router();
const limiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false });
r.use(limiter);

r.get('/meta', (req, res) => {
  const s = getSettings(req.db);
  res.json({
    company: { name: s.company_name, trn: s.company_trn, phone: s.company_phone, email: s.company_email, address: s.company_address },
    services: SERVICES, zones: ZONES, cities: Object.keys(UAE_CITIES), statuses: STATUS_LABEL,
    countries: Object.fromEntries([['AE', 'United Arab Emirates'], ...req.db.all('SELECT code, name FROM countries WHERE active = 1 ORDER BY name').map((c) => [c.code, c.name])]),
    country_list: req.db.all('SELECT code, name, zone, airport FROM countries WHERE active = 1 ORDER BY name'),
    currency: 'AED',
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
  const quotes = quoteAll(req.db, getSettings(req.db), req.body);
  res.json({ quotes: req.body.service ? quotes.filter((q) => q.service === req.body.service) : quotes });
});

r.get('/branches', (req, res) => {
  res.json(req.db.all('SELECT id, code, name, city FROM branches WHERE active = 1 ORDER BY id'));
});

export default r;
