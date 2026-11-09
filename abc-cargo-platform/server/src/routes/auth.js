import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { audit, nextSeq } from '../db.js';
import { signToken, requireAuth, publicUser } from '../lib/auth.js';
import { HttpError, validate, zPhone, zText, conflict } from '../lib/util.js';

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
  })), (req, res) => {
    const { email, password: pw, app } = req.body;
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
    req.db.run("UPDATE users SET last_login_at = datetime('now') WHERE id = ?", user.id);
    req.user = user;
    audit(req.db, req, 'auth.login', 'user', user.id, { app });
    res.json({ token: signToken(user, config), user: publicUser(user) });
  });

  // Public self-registration: creates a CASH (pay-per-shipment) customer account.
  r.post('/register', loginLimiter(config), validate(z.object({
    name: zText(120),
    company: z.string().trim().max(120).optional(),
    email: z.string().trim().email().max(160),
    phone: zPhone,
    address: z.string().trim().max(300).optional(),
    city: z.string().trim().max(60).optional(),
    password,
  })), (req, res) => {
    const b = req.body;
    if (req.db.get('SELECT id FROM users WHERE email = ?', b.email)) throw conflict('An account with this email already exists');
    const user = req.db.tx(() => {
      const code = `C${String(nextSeq(req.db, 'customer')).padStart(5, '0')}`;
      const c = req.db.run(
        `INSERT INTO customers (code, name, type, phone, email, address, city) VALUES (?, ?, 'CASH', ?, ?, ?, ?)`,
        code, b.company || b.name, b.phone, b.email, b.address ?? null, b.city ?? null,
      );
      const u = req.db.run(
        `INSERT INTO users (name, email, phone, password_hash, role, customer_id) VALUES (?, ?, ?, ?, 'CUSTOMER', ?)`,
        b.name, b.email, b.phone, bcrypt.hashSync(b.password, 10), Number(c.lastInsertRowid),
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
