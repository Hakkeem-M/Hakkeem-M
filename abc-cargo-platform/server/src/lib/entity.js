// Multi-entity support (UAE, UK, ...): settings overlay, price lists and request scoping.
import { getSettings } from '../db.js';
import { HttpError } from './util.js';

export const DEFAULT_ENTITY = 'AE';

export function entityRow(db, code) {
  return db.get('SELECT * FROM entities WHERE code = ? AND active = 1', code);
}

/** Global settings overlaid with the entity's currency, VAT, surcharges and company details. */
export function settingsFor(db, code = DEFAULT_ENTITY) {
  const s = getSettings(db);
  const e = entityRow(db, code);
  if (!e) throw new HttpError(400, `Unknown entity ${code}`);
  return {
    ...s,
    entity_code: e.code,
    currency: e.currency,
    vat_rate_pct: e.vat_rate_pct,
    fuel_surcharge_pct: e.fuel_surcharge_pct,
    intl_fuel_surcharge_pct: e.intl_fuel_surcharge_pct,
    awb_charge: e.awb_charge,
    company_name: e.name,
    company_trn: e.tax_no,
    tax_label: e.tax_label,
    company_phone: e.phone ?? s.company_phone,
    company_email: e.email ?? s.company_email,
    company_address: e.address ?? s.company_address,
  };
}

export function packingMap(db, code = DEFAULT_ENTITY) {
  const out = {};
  for (const r of db.all("SELECT code, amount FROM price_list WHERE entity_code = ? AND kind = 'PACKING' AND active = 1", code)) out[r.code] = r.amount;
  return out;
}

/**
 * Resolves req.entity for staff: users bound to an entity always use it; group-level users (entity_code NULL)
 * may pick one with the X-Entity header (or ?entity=), otherwise they see all entities (req.entity = null).
 */
export function resolveEntity(req, _res, next) {
  const u = req.user;
  if (!u) return next();
  if (u.entity_code) { req.entity = u.entity_code; return next(); }
  const want = String(req.headers['x-entity'] || req.query.entity || '').toUpperCase();
  if (want && want !== 'ALL') {
    if (!entityRow(req.db, want)) return next(new HttpError(400, `Unknown entity ${want}`));
    req.entity = want;
  } else req.entity = null;
  next();
}

/** Entity to create records under: explicit body value (group users), else the request entity, else default. */
export function entityForWrite(req, explicit) {
  if (req.user?.entity_code) return req.user.entity_code;
  return (explicit || req.entity || DEFAULT_ENTITY).toUpperCase();
}

/** SQL helper: returns ['AND alias.entity_code = ?', [code]] or ['', []]. */
export function entityFilter(req, alias = 's') {
  return req.entity ? [` AND ${alias}.entity_code = ?`, [req.entity]] : ['', []];
}

/** 404 unless the row belongs to the caller's region (group users with no region selected see all). */
export function inEntity(req, row, what = 'Record') {
  if (!row) throw new HttpError(404, `${what} not found`);
  if (req.entity && row.entity_code && row.entity_code !== req.entity) throw new HttpError(404, `${what} not found`);
  return row;
}

const SCOPED = {
  shipments: (e) => `(SELECT * FROM shipments WHERE entity_code = '${e}')`,
  invoices: (e) => `(SELECT * FROM invoices WHERE entity_code = '${e}')`,
  tickets: (e) => `(SELECT * FROM tickets WHERE entity_code = '${e}')`,
  leads: (e) => `(SELECT * FROM leads WHERE entity_code = '${e}')`,
  manifests: (e) => `(SELECT * FROM manifests WHERE entity_code = '${e}')`,
  customers: (e) => `(SELECT * FROM customers WHERE entity_code = '${e}')`,
  users: (e) => `(SELECT * FROM users WHERE entity_code = '${e}')`,
  driver_locations: (e) => `(SELECT * FROM driver_locations WHERE driver_id IN (SELECT id FROM users WHERE entity_code = '${e}'))`,
  payments: (e) => `(SELECT * FROM payments WHERE COALESCE((SELECT entity_code FROM invoices WHERE id = payments.invoice_id),
                       (SELECT entity_code FROM shipments WHERE id = payments.shipment_id)) = '${e}')`,
};
/**
 * Read-only db view limited to req.entity for reporting queries: rewrites FROM/JOIN of scoped tables into
 * region-filtered subqueries. Entity codes are validated against the entities table and reduced to A-Z.
 */
export function scopedDb(req) {
  if (!req.entity) return req.db;
  const e = req.entity.replace(/[^A-Z]/g, '');
  // Keep an existing lowercase alias (FROM shipments s) or alias the subquery with the table name.
  const fix = (sql) => sql.replace(/\b(FROM|JOIN)\s+(shipments|invoices|tickets|leads|manifests|customers|users|payments|driver_locations)\b(?:\s+(?:AS\s+)?([a-z][a-z0-9_]*)\b)?/g,
    (_m, kw, t, alias) => `${kw} ${SCOPED[t](e)} AS ${alias || t}`);
  return { get: (sql, ...a) => req.db.get(fix(sql), ...a), all: (sql, ...a) => req.db.all(fix(sql), ...a) };
}
