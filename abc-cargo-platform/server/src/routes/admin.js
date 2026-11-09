// Master data & administration: customers, users, branches, rate cards, settings, audit log.
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { audit, getSettings, nextSeq } from '../db.js';
import { requireRole, STAFF, publicUser } from '../lib/auth.js';
import { validate, idParam, notFound, conflict, zText, zPhone, zLat, zLng } from '../lib/util.js';

const r = Router();
const optStr = (n) => z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().trim().max(n).optional());

// ---- Customers ----
const customerInput = z.object({
  name: zText(160),
  type: z.enum(['ACCOUNT', 'CASH']),
  phone: z.preprocess((v) => (v === '' || v === null ? undefined : v), zPhone.optional()),
  email: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().trim().email().max(160).optional()),
  address: optStr(300), city: optStr(60), trn: optStr(20), industry: optStr(60),
  lat: zLat, lng: zLng,
  credit_limit: z.coerce.number().min(0).max(10_000_000).default(0),
  payment_terms_days: z.coerce.number().int().min(0).max(120).default(30),
  account_manager_id: z.preprocess((v) => (v === '' || v == null ? undefined : v), z.coerce.number().int().positive().optional()),
  active: z.union([z.boolean(), z.number()]).transform(Boolean).optional(),
});

r.get('/customers', requireRole(...STAFF), (req, res) => {
  const q = `%${String(req.query.q || '').slice(0, 60)}%`;
  res.json(req.db.all(
    `SELECT c.*, u.name AS account_manager,
            (SELECT COUNT(*) FROM shipments s WHERE s.customer_id = c.id) AS shipments,
            (SELECT ROUND(COALESCE(SUM(total - paid),0),2) FROM invoices i WHERE i.customer_id = c.id AND i.status IN ('UNPAID','PARTIAL')) AS outstanding
       FROM customers c LEFT JOIN users u ON u.id = c.account_manager_id
      WHERE (c.name LIKE ? OR c.code LIKE ? OR c.phone LIKE ? OR c.email LIKE ?) ORDER BY c.name LIMIT 500`, q, q, q, q));
});

r.post('/customers', requireRole('ADMIN', 'SALES', 'FINANCE', 'OPS'), validate(customerInput), (req, res) => {
  const b = req.body;
  const code = `C${String(nextSeq(req.db, 'customer')).padStart(5, '0')}`;
  const ins = req.db.run(
    `INSERT INTO customers (code, name, type, phone, email, address, city, trn, industry, lat, lng, credit_limit, payment_terms_days, account_manager_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    code, b.name, b.type, b.phone ?? null, b.email ?? null, b.address ?? null, b.city ?? null, b.trn ?? null, b.industry ?? null,
    b.lat ?? null, b.lng ?? null, b.credit_limit, b.payment_terms_days, b.account_manager_id ?? null);
  audit(req.db, req, 'customer.create', 'customer', code);
  res.status(201).json(req.db.get('SELECT * FROM customers WHERE id = ?', Number(ins.lastInsertRowid)));
});

r.put('/customers/:id', requireRole('ADMIN', 'SALES', 'FINANCE'), validate(customerInput), (req, res) => {
  const id = idParam(req);
  const c = req.db.get('SELECT * FROM customers WHERE id = ?', id);
  if (!c) throw notFound('Customer');
  const b = req.body;
  // Credit terms are a finance decision.
  const creditChanged = b.credit_limit !== c.credit_limit || b.payment_terms_days !== c.payment_terms_days || b.type !== c.type;
  if (creditChanged && !['ADMIN', 'FINANCE'].includes(req.user.role)) throw conflict('Only Finance can change account type or credit terms');
  req.db.run(
    `UPDATE customers SET name=?, type=?, phone=?, email=?, address=?, city=?, trn=?, industry=?, lat=?, lng=?, credit_limit=?,
       payment_terms_days=?, account_manager_id=?, active=? WHERE id = ?`,
    b.name, b.type, b.phone ?? null, b.email ?? null, b.address ?? null, b.city ?? null, b.trn ?? null, b.industry ?? null,
    b.lat ?? null, b.lng ?? null, b.credit_limit, b.payment_terms_days, b.account_manager_id ?? null,
    b.active === undefined ? c.active : (b.active ? 1 : 0), id);
  audit(req.db, req, 'customer.update', 'customer', c.code, creditChanged ? { credit_limit: b.credit_limit, type: b.type } : null);
  res.json(req.db.get('SELECT * FROM customers WHERE id = ?', id));
});

// ---- Users ----
const ROLES = ['ADMIN', 'OPS', 'FINANCE', 'SALES', 'WAREHOUSE', 'DRIVER', 'CUSTOMER'];
const userInput = z.object({
  name: zText(120),
  email: z.string().trim().email().max(160),
  phone: z.preprocess((v) => (v === '' || v === null ? undefined : v), zPhone.optional()),
  role: z.enum(ROLES),
  customer_id: z.preprocess((v) => (v === '' || v == null ? undefined : v), z.coerce.number().int().positive().optional()),
  branch_id: z.preprocess((v) => (v === '' || v == null ? undefined : v), z.coerce.number().int().positive().optional()),
  vehicle_no: optStr(20),
  capacity: z.coerce.number().int().min(1).max(200).default(25),
  active: z.boolean().default(true),
  password: z.preprocess((v) => (v === '' || v === null ? undefined : v),
    z.string().min(8).max(128).regex(/[A-Za-z]/).regex(/\d/, 'Password must contain a letter and a number').optional()),
});

r.get('/users', requireRole('ADMIN', 'OPS'), (req, res) => {
  const role = req.query.role && ROLES.includes(req.query.role) ? req.query.role : null;
  res.json(req.db.all(
    `SELECT u.id, u.name, u.email, u.phone, u.role, u.customer_id, u.branch_id, u.vehicle_no, u.capacity, u.active, u.last_login_at,
            b.code AS branch_code, c.name AS customer_name
       FROM users u LEFT JOIN branches b ON b.id = u.branch_id LEFT JOIN customers c ON c.id = u.customer_id
      ${role ? 'WHERE u.role = ?' : ''} ORDER BY u.role, u.name`, ...(role ? [role] : [])));
});

r.get('/staff', requireRole(...STAFF), (req, res) => {
  res.json(req.db.all("SELECT id, name, role FROM users WHERE active = 1 AND role NOT IN ('CUSTOMER','DRIVER') ORDER BY name"));
});

r.post('/users', requireRole('ADMIN'), validate(userInput), (req, res) => {
  const b = req.body;
  if (!b.password) throw conflict('Password is required for new users');
  if (b.role === 'CUSTOMER' && !b.customer_id) throw conflict('Customer users must be linked to a customer');
  if (req.db.get('SELECT id FROM users WHERE email = ?', b.email)) throw conflict('Email already in use');
  const ins = req.db.run(
    `INSERT INTO users (name, email, phone, password_hash, role, customer_id, branch_id, vehicle_no, capacity, active)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    b.name, b.email, b.phone ?? null, bcrypt.hashSync(b.password, 10), b.role, b.customer_id ?? null, b.branch_id ?? null,
    b.vehicle_no ?? null, b.capacity, b.active ? 1 : 0);
  audit(req.db, req, 'user.create', 'user', ins.lastInsertRowid, { role: b.role });
  res.status(201).json(publicUser(req.db.get('SELECT * FROM users WHERE id = ?', Number(ins.lastInsertRowid))));
});

r.put('/users/:id', requireRole('ADMIN'), validate(userInput), (req, res) => {
  const id = idParam(req);
  const u = req.db.get('SELECT * FROM users WHERE id = ?', id);
  if (!u) throw notFound('User');
  const b = req.body;
  if (id === req.user.id && (!b.active || b.role !== 'ADMIN')) throw conflict('You cannot deactivate or demote your own account');
  const other = req.db.get('SELECT id FROM users WHERE email = ? AND id != ?', b.email, id);
  if (other) throw conflict('Email already in use');
  // Role/active/password changes revoke existing sessions.
  const revoke = b.role !== u.role || (b.active ? 1 : 0) !== u.active || !!b.password;
  req.db.run(
    `UPDATE users SET name=?, email=?, phone=?, role=?, customer_id=?, branch_id=?, vehicle_no=?, capacity=?, active=?,
       password_hash = COALESCE(?, password_hash), token_version = token_version + ? WHERE id = ?`,
    b.name, b.email, b.phone ?? null, b.role, b.customer_id ?? null, b.branch_id ?? null, b.vehicle_no ?? null, b.capacity,
    b.active ? 1 : 0, b.password ? bcrypt.hashSync(b.password, 10) : null, revoke ? 1 : 0, id);
  audit(req.db, req, 'user.update', 'user', id, { role: b.role, active: b.active, password_reset: !!b.password });
  res.json(publicUser(req.db.get('SELECT * FROM users WHERE id = ?', id)));
});

// ---- Branches ----
r.get('/branches', requireRole(...STAFF), (req, res) => res.json(req.db.all('SELECT * FROM branches ORDER BY id')));
r.post('/branches', requireRole('ADMIN'), validate(z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,12}$/), name: zText(80), city: zText(60), lat: zLat, lng: zLng,
})), (req, res) => {
  if (req.db.get('SELECT id FROM branches WHERE code = ?', req.body.code)) throw conflict('Branch code exists');
  const b = req.body;
  const ins = req.db.run('INSERT INTO branches (code, name, city, lat, lng) VALUES (?,?,?,?,?)', b.code, b.name, b.city, b.lat ?? null, b.lng ?? null);
  audit(req.db, req, 'branch.create', 'branch', b.code);
  res.status(201).json(req.db.get('SELECT * FROM branches WHERE id = ?', Number(ins.lastInsertRowid)));
});

// ---- Rates ----
r.get('/rates', requireRole(...STAFF), (req, res) => res.json(req.db.all('SELECT * FROM rates ORDER BY service, zone')));
r.put('/rates/:id', requireRole('ADMIN', 'FINANCE'), validate(z.object({
  base_weight: z.coerce.number().min(0.5).max(100),
  base_price: z.coerce.number().min(0).max(100000),
  per_kg: z.coerce.number().min(0).max(10000),
  transit: optStr(40),
  active: z.boolean().default(true),
})), (req, res) => {
  const id = idParam(req);
  const old = req.db.get('SELECT * FROM rates WHERE id = ?', id);
  if (!old) throw notFound('Rate');
  const b = req.body;
  req.db.run('UPDATE rates SET base_weight=?, base_price=?, per_kg=?, transit=?, active=? WHERE id = ?',
    b.base_weight, b.base_price, b.per_kg, b.transit ?? old.transit, b.active ? 1 : 0, id);
  audit(req.db, req, 'rate.update', 'rate', `${old.service}/${old.zone}`, { from: { base: old.base_price, per_kg: old.per_kg }, to: { base: b.base_price, per_kg: b.per_kg } });
  res.json(req.db.get('SELECT * FROM rates WHERE id = ?', id));
});

// ---- Settings ----
const SETTING_KEYS = ['company_name', 'company_trn', 'company_phone', 'company_email', 'company_address',
  'vat_rate_pct', 'fuel_surcharge_pct', 'cod_fee_pct', 'cod_fee_min', 'volumetric_divisor'];
r.get('/settings', requireRole(...STAFF), (req, res) => res.json(getSettings(req.db)));
r.put('/settings', requireRole('ADMIN'), validate(z.record(z.string(), z.union([z.string(), z.number()]))), (req, res) => {
  const numeric = new Set(['vat_rate_pct', 'fuel_surcharge_pct', 'cod_fee_pct', 'cod_fee_min', 'volumetric_divisor']);
  req.db.tx(() => {
    for (const [k, v] of Object.entries(req.body)) {
      if (!SETTING_KEYS.includes(k)) continue;
      if (numeric.has(k) && !(Number(v) >= 0 && Number(v) <= 100000)) throw conflict(`Invalid value for ${k}`);
      req.db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, String(v).slice(0, 300));
    }
    audit(req.db, req, 'settings.update', 'settings', null, req.body);
  });
  res.json(getSettings(req.db));
});

// ---- Audit ----
r.get('/audit', requireRole('ADMIN'), (req, res) => {
  const limit = Math.min(1000, Number(req.query.limit) || 200);
  res.json(req.db.all(
    `SELECT a.*, u.name AS user_name, u.role AS user_role FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
      ${req.query.action ? 'WHERE a.action LIKE ?' : ''} ORDER BY a.id DESC LIMIT ?`,
    ...(req.query.action ? [`${req.query.action}%`, limit] : [limit])));
});

export default r;
