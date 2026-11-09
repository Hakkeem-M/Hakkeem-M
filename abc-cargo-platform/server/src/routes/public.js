import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { getSettings } from '../db.js';
import { SERVICES, ZONES, UAE_CITIES, COUNTRIES, quoteAll } from '../lib/pricing.js';
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
    services: SERVICES, zones: ZONES, cities: Object.keys(UAE_CITIES), countries: COUNTRIES, statuses: STATUS_LABEL,
    currency: 'AED',
  });
});

const mask = (name) => (name ? name.split(/\s+/).map((p) => p[0] + '*'.repeat(Math.max(1, p.length - 1))).join(' ') : null);

// Public tracking — exposes no addresses, phone numbers or charges.
r.get('/track/:awb', (req, res) => {
  const awb = normalizeAwb(req.params.awb);
  if (!isValidAwb(awb)) throw badRequest('Invalid AWB number');
  const s = req.db.get(
    `SELECT id, awb, service, status, origin_city, dest_city, dest_country, pieces, chargeable_weight,
            created_at, delivered_at, pod_name, attempts FROM shipments WHERE awb = ?`, awb,
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
