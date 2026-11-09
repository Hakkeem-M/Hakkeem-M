import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { audit, nextSeq } from '../db.js';
import { signToken, requireAuth, publicUser } from '../lib/auth.js';
import { HttpError, validate, zPhone, zText, conflict } from '../lib/util.js';
import { siteRegion, domainFor } from '../lib/site.js';

const r = Router();

const loginLimiter = (config) => rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.loginRateLimit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
});

const APP_ROLES = {
  erp: ['ADMIN', 'OPS', 'FINANCE', 'SALES', 'WAREHOUSE'],
  driver: ['DRIVER'],
  warehouse: ['WAREHOUSE', 'ADMIN', 'OPS'],
  customer: ['CUSTOMER'],
};

const password = z.string().min(8).max(128)
  .regex(/[A-Za-z]/, 'Must contain a letter').regex(/\d/, 'Must contain a number');

export default (config) => {
  r.post('/login', loginLimiter(config), validate(z.object({
    email: z.string().trim().email().max(160),
    password: z.string().min(1).max(128),
    app: z.enum(Object.keys(APP_ROLES)).optional(),
    region: z.string().trim().toUpperCase().regex(/^[A-Z]{2,5}$/).optional(), // AE, GB, SA, IN or GROUP
  })), (req, res) => {
    const { email, password: pw, app, region } = req.body;
    const user = req.db.get('SELECT * FROM users WHERE email = ?', email);
    // Constant-ish time: always run a bcrypt compare.
    const ok = bcrypt.compareSync(pw, user?.password_hash || '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva');
    if (!user || !ok || !user.active) {
      audit(req.db, req, 'auth.login_failed', 'user', email);
      throw new HttpError(401, 'Invalid email or password');
    }
    if (app && !APP_ROLES[app].includes(user.role)) {
      throw new HttpError(403, `This account (${user.role}) cannot sign in to the ${app} app`);
    }
    // Regional login. The site's domain decides the region (abccargo.uk → UK, …, abccargo.com → group);
    // on other hosts (dev / demo) an optional region from the client is used, else the account's own region.
    const site = siteRegion(req);
    const want = site || region || null;
    const regionName = (code) => req.db.get('SELECT name FROM entities WHERE code = ?', code)?.name || code;
    const where = (code) => (domainFor(req, code) ? ` Sign in at ${domainFor(req, code)}.` : ' Choose that region to sign in.');
    if (want === 'GROUP' && user.entity_code && site) {
      throw new HttpError(403, `This site is for group administrators. Your account belongs to ${regionName(user.entity_code)}.${where(user.entity_code)}`);
    }
    if (want && want !== 'GROUP' && user.entity_code && user.entity_code !== want) {
      throw new HttpError(403, `This account belongs to ${regionName(user.entity_code)}.${where(user.entity_code)}`);
    }
    if (want && want !== 'GROUP' && !req.db.get('SELECT 1 AS x FROM entities WHERE code = ? AND active = 1', want)) {
      throw new HttpError(400, 'Unknown region');
    }
    req.db.run("UPDATE users SET last_login_at = datetime('now') WHERE id = ?", user.id);
    req.user = user;
    audit(req.db, req, 'auth.login', 'user', user.id, { app });
    res.json({ token: signToken(user, config), user: publicUser(user), region: user.entity_code || (want && want !== 'GROUP' ? want : null) });
  });

  // Public self-registration: creates a CASH (pay-per-shipment) customer account.
  r.post('/register', loginLimiter(config), validate(z.object({
    name: zText(120),
    company: z.string().trim().max(120).optional(),
    email: z.string().trim().email().max(160),
    phone: zPhone,
    address: z.string().trim().max(300).optional(),
    city: z.string().trim().max(60).optional(),
    region: z.enum(['AE', 'GB', 'SA', 'IN']).default('AE'),
    password,
  })), (req, res) => {
    const b = req.body;
    const site = siteRegion(req);
    if (site && site !== 'GROUP') b.region = site; // regional site: customers register in that region
    if (req.db.get('SELECT id FROM users WHERE email = ?', b.email)) throw conflict('An account with this email already exists');
    const user = req.db.tx(() => {
      const code = `C${String(nextSeq(req.db, 'customer')).padStart(5, '0')}`;
      const c = req.db.run(
        `INSERT INTO customers (code, name, type, phone, email, address, city, entity_code, country) VALUES (?, ?, 'CASH', ?, ?, ?, ?, ?, ?)`,
        code, b.company || b.name, b.phone, b.email, b.address ?? null, b.city ?? null, b.region, b.region,
      );
      const u = req.db.run(
        `INSERT INTO users (name, email, phone, password_hash, role, customer_id, entity_code) VALUES (?, ?, ?, ?, 'CUSTOMER', ?, ?)`,
        b.name, b.email, b.phone, bcrypt.hashSync(b.password, 10), Number(c.lastInsertRowid), b.region,
      );
      return req.db.get('SELECT * FROM users WHERE id = ?', Number(u.lastInsertRowid));
    });
    req.user = user;
    audit(req.db, req, 'auth.register', 'user', user.id);
    res.status(201).json({ token: signToken(user, config), user: publicUser(user) });
  });

  r.get('/me', requireAuth, (req, res) => {
    const out = publicUser(req.user);
    if (req.user.customer_id) out.customer = req.db.get('SELECT id, code, name, type FROM customers WHERE id = ?', req.user.customer_id);
    if (req.user.branch_id) out.branch = req.db.get('SELECT id, code, name FROM branches WHERE id = ?', req.user.branch_id);
    out.entity = req.user.entity_code ? req.db.get('SELECT code, name, currency, vat_rate_pct, tax_label, phone_prefix FROM entities WHERE code = ?', req.user.entity_code) : null;
    out.regions = req.db.all('SELECT code, name, currency FROM entities WHERE active = 1 ORDER BY rowid');
    res.json(out);
  });

  r.post('/change-password', requireAuth, validate(z.object({
    current_password: z.string().min(1), new_password: password,
  })), (req, res) => {
    const u = req.db.get('SELECT password_hash FROM users WHERE id = ?', req.user.id);
    if (!bcrypt.compareSync(req.body.current_password, u.password_hash)) throw new HttpError(400, 'Current password is incorrect');
    // Bumping token_version signs out all other sessions.
    req.db.run('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?',
      bcrypt.hashSync(req.body.new_password, 10), req.user.id);
    audit(req.db, req, 'auth.change_password', 'user', req.user.id);
    const fresh = req.db.get('SELECT * FROM users WHERE id = ?', req.user.id);
    res.json({ token: signToken(fresh, config) });
  });

  return r;
};
