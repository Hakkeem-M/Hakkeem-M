// SQLite data layer (Node 22 built-in node:sqlite — no native build step).
// Swap for PostgreSQL in production scale-out: all SQL is ANSI-style with positional params.
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS branches (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  lat REAL, lng REAL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('ACCOUNT','CASH')),
  phone TEXT, email TEXT, address TEXT, city TEXT, trn TEXT,
  lat REAL, lng REAL,
  industry TEXT,
  account_manager_id INTEGER,
  credit_limit REAL NOT NULL DEFAULT 0,
  payment_terms_days INTEGER NOT NULL DEFAULT 30,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL COLLATE NOCASE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ADMIN','OPS','FINANCE','SALES','WAREHOUSE','DRIVER','CUSTOMER')),
  customer_id INTEGER REFERENCES customers(id),
  branch_id INTEGER REFERENCES branches(id),
  vehicle_no TEXT,
  capacity INTEGER NOT NULL DEFAULT 25,
  active INTEGER NOT NULL DEFAULT 1,
  token_version INTEGER NOT NULL DEFAULT 0,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rates (
  id INTEGER PRIMARY KEY,
  service TEXT NOT NULL,
  zone TEXT NOT NULL,
  base_weight REAL NOT NULL,
  base_price REAL NOT NULL,
  per_kg REAL NOT NULL,
  transit TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (service, zone)
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sequences (name TEXT PRIMARY KEY, value INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  number TEXT UNIQUE NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  type TEXT NOT NULL CHECK (type IN ('CASH','CREDIT')),
  status TEXT NOT NULL CHECK (status IN ('UNPAID','PARTIAL','PAID','VOID')),
  issue_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  subtotal REAL NOT NULL,
  vat REAL NOT NULL,
  total REAL NOT NULL,
  paid REAL NOT NULL DEFAULT 0,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shipments (
  id INTEGER PRIMARY KEY,
  awb TEXT UNIQUE NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  service TEXT NOT NULL,
  zone TEXT NOT NULL,
  status TEXT NOT NULL,
  payment_mode TEXT NOT NULL CHECK (payment_mode IN ('ACCOUNT','CASH','PREPAID')),
  shipper_name TEXT NOT NULL, shipper_phone TEXT NOT NULL, shipper_address TEXT NOT NULL, origin_city TEXT NOT NULL,
  pickup_lat REAL, pickup_lng REAL, dest_lat REAL, dest_lng REAL,
  pickup_window TEXT,
  route_id INTEGER, route_seq INTEGER,
  consignee_name TEXT NOT NULL, consignee_phone TEXT NOT NULL, consignee_address TEXT NOT NULL,
  dest_city TEXT NOT NULL, dest_country TEXT NOT NULL DEFAULT 'AE',
  pieces INTEGER NOT NULL DEFAULT 1,
  weight REAL NOT NULL,
  length REAL, width REAL, height REAL,
  chargeable_weight REAL NOT NULL,
  description TEXT,
  declared_value REAL NOT NULL DEFAULT 0,
  reference TEXT,
  cod_amount REAL NOT NULL DEFAULT 0,
  cod_collected REAL NOT NULL DEFAULT 0,
  cod_remittance_id INTEGER,
  freight REAL NOT NULL, fuel_surcharge REAL NOT NULL, cod_fee REAL NOT NULL,
  subtotal REAL NOT NULL, vat_rate REAL NOT NULL, vat REAL NOT NULL, total_charge REAL NOT NULL,
  invoice_id INTEGER REFERENCES invoices(id),
  driver_id INTEGER REFERENCES users(id),
  branch_id INTEGER REFERENCES branches(id),
  bin TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  pod_name TEXT, pod_signature TEXT, pod_photo TEXT,
  delivered_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_ship_status ON shipments(status);
CREATE INDEX IF NOT EXISTS ix_ship_customer ON shipments(customer_id);
CREATE INDEX IF NOT EXISTS ix_ship_driver ON shipments(driver_id, status);
CREATE INDEX IF NOT EXISTS ix_ship_created ON shipments(created_at);

CREATE TABLE IF NOT EXISTS shipment_events (
  id INTEGER PRIMARY KEY,
  shipment_id INTEGER NOT NULL REFERENCES shipments(id),
  status TEXT NOT NULL,
  location TEXT,
  note TEXT,
  public INTEGER NOT NULL DEFAULT 1,
  user_id INTEGER REFERENCES users(id),
  lat REAL, lng REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_events_ship ON shipment_events(shipment_id);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  shipment_id INTEGER REFERENCES shipments(id),
  description TEXT NOT NULL,
  amount REAL NOT NULL,
  vat_rate REAL NOT NULL,
  vat REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS cash_settlements (
  id INTEGER PRIMARY KEY,
  driver_id INTEGER NOT NULL REFERENCES users(id),
  amount REAL NOT NULL,
  received_by INTEGER NOT NULL REFERENCES users(id),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('INVOICE','COD')),
  invoice_id INTEGER REFERENCES invoices(id),
  shipment_id INTEGER REFERENCES shipments(id),
  amount REAL NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL CHECK (method IN ('CASH','CARD','BANK','ONLINE')),
  reference TEXT,
  collected_by INTEGER REFERENCES users(id),
  settlement_id INTEGER REFERENCES cash_settlements(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_pay_collector ON payments(collected_by, settlement_id);

CREATE TABLE IF NOT EXISTS cod_remittances (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  amount REAL NOT NULL,
  reference TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS warehouse_scans (
  id INTEGER PRIMARY KEY,
  client_ref TEXT UNIQUE,
  shipment_id INTEGER REFERENCES shipments(id),
  awb TEXT NOT NULL,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  direction TEXT NOT NULL CHECK (direction IN ('IN','OUT')),
  purpose TEXT,
  bin TEXT,
  result TEXT NOT NULL CHECK (result IN ('OK','WARNING','EXCEPTION')),
  message TEXT,
  user_id INTEGER REFERENCES users(id),
  scanned_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_scans_branch ON warehouse_scans(branch_id, created_at);

CREATE TABLE IF NOT EXISTS driver_locations (
  id INTEGER PRIMARY KEY,
  driver_id INTEGER NOT NULL REFERENCES users(id),
  lat REAL NOT NULL, lng REAL NOT NULL,
  accuracy REAL, speed REAL, heading REAL, battery REAL,
  recorded_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_loc_driver ON driver_locations(driver_id, id);

CREATE TABLE IF NOT EXISTS routes (
  id INTEGER PRIMARY KEY,
  driver_id INTEGER NOT NULL REFERENCES users(id),
  route_date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('PICKUP','DELIVERY','MIXED')),
  mode TEXT NOT NULL CHECK (mode IN ('AUTO','MANUAL')),
  status TEXT NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED','ACTIVE','DONE','CANCELLED')),
  stops INTEGER NOT NULL DEFAULT 0,
  distance_km REAL NOT NULL DEFAULT 0,
  duration_min REAL NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- CRM ----------
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY,
  company TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  phone TEXT, email TEXT, city TEXT,
  source TEXT NOT NULL DEFAULT 'OTHER',
  stage TEXT NOT NULL DEFAULT 'NEW' CHECK (stage IN ('NEW','CONTACTED','QUALIFIED','PROPOSAL','NEGOTIATION','WON','LOST')),
  est_monthly_shipments INTEGER NOT NULL DEFAULT 0,
  est_monthly_value REAL NOT NULL DEFAULT 0,
  probability INTEGER NOT NULL DEFAULT 10,
  expected_close TEXT,
  lost_reason TEXT,
  owner_id INTEGER REFERENCES users(id),
  customer_id INTEGER REFERENCES customers(id),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  name TEXT NOT NULL, title TEXT, phone TEXT, email TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY,
  entity TEXT NOT NULL CHECK (entity IN ('LEAD','CUSTOMER')),
  entity_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('CALL','MEETING','EMAIL','WHATSAPP','NOTE','TASK')),
  subject TEXT NOT NULL,
  notes TEXT,
  due_at TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  owner_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_act_entity ON activities(entity, entity_id);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY,
  number TEXT UNIQUE NOT NULL,
  customer_id INTEGER REFERENCES customers(id),
  shipment_id INTEGER REFERENCES shipments(id),
  category TEXT NOT NULL CHECK (category IN ('DELAY','DAMAGE','LOST','BILLING','PICKUP','COD','OTHER')),
  priority TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('LOW','MEDIUM','HIGH','URGENT')),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_PROGRESS','WAITING_CUSTOMER','RESOLVED','CLOSED')),
  channel TEXT NOT NULL DEFAULT 'PORTAL',
  subject TEXT NOT NULL,
  description TEXT,
  assigned_to INTEGER REFERENCES users(id),
  created_by INTEGER REFERENCES users(id),
  sla_due_at TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS ticket_comments (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  user_id INTEGER REFERENCES users(id),
  body TEXT NOT NULL,
  internal INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  detail TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export function openDb(file = ':memory:') {
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (file !== ':memory:') raw.exec('PRAGMA journal_mode = WAL;');
  raw.exec(SCHEMA);

  const cache = new Map();
  const prep = (sql) => {
    let s = cache.get(sql);
    if (!s) { s = raw.prepare(sql); cache.set(sql, s); }
    return s;
  };
  let depth = 0;

  const db = {
    raw,
    all: (sql, ...p) => prep(sql).all(...p).map(plain),
    get: (sql, ...p) => plain(prep(sql).get(...p)),
    run: (sql, ...p) => prep(sql).run(...p),
    exec: (sql) => raw.exec(sql),
    /** Run fn atomically; nested calls join the outer transaction. */
    tx(fn) {
      if (depth > 0) return fn();
      depth++;
      raw.exec('BEGIN IMMEDIATE');
      try {
        const out = fn();
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      } finally {
        depth--;
      }
    },
    close: () => raw.close(),
  };
  return db;
}

function plain(row) {
  return row ? { ...row } : undefined;
}

export function getSettings(db) {
  const out = {};
  for (const r of db.all('SELECT key, value FROM settings')) out[r.key] = r.value;
  return out;
}

export function nextSeq(db, name) {
  db.run('INSERT OR IGNORE INTO sequences (name, value) VALUES (?, 0)', name);
  return db.get('UPDATE sequences SET value = value + 1 WHERE name = ? RETURNING value', name).value;
}

export function audit(db, req, action, entity, entityId, detail) {
  db.run(
    'INSERT INTO audit_log (user_id, action, entity, entity_id, detail, ip) VALUES (?, ?, ?, ?, ?, ?)',
    req?.user?.id ?? null,
    action,
    entity ?? null,
    entityId == null ? null : String(entityId),
    detail == null ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail)),
    req?.ip ?? null,
  );
}
