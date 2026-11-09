// SQLite data layer (Node 22 built-in node:sqlite — no native build step).
// Swap for PostgreSQL in production scale-out: all SQL is ANSI-style with positional params.
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
-- Legal entities / operating countries (UAE, UK, ...). Currency, VAT and defaults per entity.
CREATE TABLE IF NOT EXISTS entities (
  code TEXT PRIMARY KEY,               -- ISO country of origin: AE, GB
  name TEXT NOT NULL,
  currency TEXT NOT NULL,
  vat_rate_pct REAL NOT NULL,
  tax_label TEXT NOT NULL DEFAULT 'TRN',
  tax_no TEXT,
  phone_prefix TEXT NOT NULL,
  address TEXT, phone TEXT, email TEXT,
  fuel_surcharge_pct REAL NOT NULL DEFAULT 0,
  intl_fuel_surcharge_pct REAL NOT NULL DEFAULT 0,
  awb_charge REAL NOT NULL DEFAULT 0,
  gateway TEXT,                        -- default export airport
  sea_gateway TEXT,                    -- default export sea port
  active INTEGER NOT NULL DEFAULT 1
);

-- Chargeable extras per entity: packing types and booking charges.
CREATE TABLE IF NOT EXISTS price_list (
  id INTEGER PRIMARY KEY,
  entity_code TEXT NOT NULL REFERENCES entities(code),
  kind TEXT NOT NULL CHECK (kind IN ('PACKING','CHARGE')),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  amount REAL NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (entity_code, kind, code)
);

CREATE TABLE IF NOT EXISTS branches (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  entity_code TEXT NOT NULL DEFAULT 'AE' REFERENCES entities(code),
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  lat REAL, lng REAL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  entity_code TEXT NOT NULL DEFAULT 'AE' REFERENCES entities(code),
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('ACCOUNT','CASH')),
  whatsapp TEXT, postcode TEXT, country TEXT NOT NULL DEFAULT 'AE',
  agent_code TEXT,
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
  entity_code TEXT REFERENCES entities(code),   -- NULL = all entities (group admin)
  active INTEGER NOT NULL DEFAULT 1,
  token_version INTEGER NOT NULL DEFAULT 0,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rates (
  id INTEGER PRIMARY KEY,
  entity_code TEXT NOT NULL DEFAULT 'AE' REFERENCES entities(code),
  unit TEXT NOT NULL DEFAULT 'KG' CHECK (unit IN ('KG','CBM')),
  service TEXT NOT NULL,
  zone TEXT NOT NULL,
  base_weight REAL NOT NULL,
  base_price REAL NOT NULL,
  per_kg REAL NOT NULL,
  min_charge REAL NOT NULL DEFAULT 0,
  divisor REAL,
  transit TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (entity_code, service, zone)
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sequences (name TEXT PRIMARY KEY, value INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  number TEXT UNIQUE NOT NULL,
  entity_code TEXT NOT NULL DEFAULT 'AE',
  currency TEXT NOT NULL DEFAULT 'AED',
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
  entity_code TEXT NOT NULL DEFAULT 'AE',
  order_branch_id INTEGER, invoice_branch_id INTEGER,
  mode TEXT NOT NULL DEFAULT 'ROAD' CHECK (mode IN ('AIR','SEA','ROAD')),
  sector TEXT,
  box_count INTEGER NOT NULL DEFAULT 1,
  cbm REAL NOT NULL DEFAULT 0,
  packing_charge REAL NOT NULL DEFAULT 0,
  awb_charge REAL NOT NULL DEFAULT 0,
  handling_charge REAL NOT NULL DEFAULT 0,
  other_charge REAL NOT NULL DEFAULT 0,
  discount REAL NOT NULL DEFAULT 0,
  receiver_id INTEGER,
  quotation_id INTEGER,
  agent_code TEXT,
  sender_id_type TEXT, sender_id_no TEXT, sender_id_expiry TEXT,
  receiver_id_type TEXT, receiver_id_no TEXT,
  consignee_company TEXT, consignee_state TEXT, consignee_district TEXT,
  shipment_type TEXT NOT NULL DEFAULT 'DOMESTIC' CHECK (shipment_type IN ('DOMESTIC','INTERNATIONAL')),
  product TEXT NOT NULL DEFAULT 'PARCEL' CHECK (product IN ('DOCUMENT','PARCEL','CARGO')),
  incoterm TEXT CHECK (incoterm IN ('DAP','DDP')),
  currency TEXT NOT NULL DEFAULT 'AED',
  customs_value REAL NOT NULL DEFAULT 0,
  export_reason TEXT,
  consignee_tax_id TEXT, consignee_postcode TEXT, consignee_email TEXT,
  dangerous_goods INTEGER NOT NULL DEFAULT 0,
  duties_estimate REAL NOT NULL DEFAULT 0,
  customs_status TEXT NOT NULL DEFAULT 'NOT_REQUIRED' CHECK (customs_status IN ('NOT_REQUIRED','PENDING','DOCS_OK','SUBMITTED','HOLD','CLEARED')),
  customs_ref TEXT,
  dest_airport TEXT,
  manifest_id INTEGER,
  agent_id INTEGER,
  agent_tracking TEXT,
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

CREATE INDEX IF NOT EXISTS ix_ship_type ON shipments(shipment_type, status);
CREATE INDEX IF NOT EXISTS ix_ship_manifest ON shipments(manifest_id);

-- ---------- International ----------
CREATE TABLE IF NOT EXISTS countries (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  zone TEXT NOT NULL,
  airport TEXT,
  duty_pct REAL NOT NULL DEFAULT 5,
  import_vat_pct REAL NOT NULL DEFAULT 0,
  de_minimis REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS airports (
  code TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'AIR' CHECK (kind IN ('AIR','SEA')),
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  country TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  country TEXT NOT NULL,
  contact TEXT, email TEXT, phone TEXT,
  tracking_url TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS shipment_items (
  id INTEGER PRIMARY KEY,
  shipment_id INTEGER NOT NULL REFERENCES shipments(id),
  description TEXT NOT NULL,
  hs_code TEXT,
  qty INTEGER NOT NULL DEFAULT 1,
  unit_value REAL NOT NULL DEFAULT 0,
  weight REAL,
  origin_country TEXT NOT NULL DEFAULT 'AE',
  box_seq INTEGER
);

-- Individual boxes / packages of a booking (door-to-door cargo has many).
CREATE TABLE IF NOT EXISTS shipment_boxes (
  id INTEGER PRIMARY KEY,
  shipment_id INTEGER NOT NULL REFERENCES shipments(id),
  seq INTEGER NOT NULL,
  label TEXT NOT NULL,                 -- AWB-01, AWB-02 ... (scannable)
  actual_weight REAL NOT NULL,
  length REAL, width REAL, height REAL,
  volume_weight REAL NOT NULL DEFAULT 0,
  bill_weight REAL NOT NULL,
  cbm REAL NOT NULL DEFAULT 0,
  category TEXT,
  packing_type TEXT,
  packing_charge REAL NOT NULL DEFAULT 0,
  UNIQUE (shipment_id, seq)
);

-- Saved receivers (address book) per customer.
CREATE TABLE IF NOT EXISTS receivers (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  name TEXT NOT NULL, company TEXT,
  phone TEXT NOT NULL, whatsapp TEXT, email TEXT,
  country TEXT NOT NULL, state TEXT, district TEXT, city TEXT NOT NULL, postcode TEXT,
  address TEXT NOT NULL,
  tax_id TEXT, national_id TEXT, relation TEXT,
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_receivers_customer ON receivers(customer_id);

-- KYC / identity documents (images are sensitive: staff-only, never in public endpoints).
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('CUSTOMER','RECEIVER','SHIPMENT')),
  owner_id INTEGER NOT NULL,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('PASSPORT','EMIRATES_ID','CITIZEN_CARD','NATIONAL_ID','DRIVING_LICENCE','RESIDENCE_PERMIT','TRADE_LICENCE','OTHER')),
  doc_no TEXT,
  expiry TEXT,
  front_image TEXT, back_image TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_docs_owner ON documents(owner_type, owner_id);

-- Quotations: priced proposals that convert into bookings.
CREATE TABLE IF NOT EXISTS quotations (
  id INTEGER PRIMARY KEY,
  number TEXT UNIQUE NOT NULL,
  entity_code TEXT NOT NULL,
  currency TEXT NOT NULL,
  customer_id INTEGER REFERENCES customers(id),
  lead_id INTEGER REFERENCES leads(id),
  contact_name TEXT NOT NULL, contact_phone TEXT, contact_email TEXT,
  service TEXT NOT NULL,
  origin_city TEXT NOT NULL, dest_country TEXT NOT NULL, dest_city TEXT NOT NULL,
  payload TEXT NOT NULL,               -- full booking input (JSON)
  pricing TEXT NOT NULL,               -- priced breakdown (JSON)
  total REAL NOT NULL,
  valid_until TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SENT','ACCEPTED','REJECTED','EXPIRED','CONVERTED')),
  notes TEXT,
  shipment_id INTEGER REFERENCES shipments(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_items_ship ON shipment_items(shipment_id);
CREATE TABLE IF NOT EXISTS manifests (
  id INTEGER PRIMARY KEY,
  entity_code TEXT NOT NULL DEFAULT 'AE',
  number TEXT UNIQUE NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('AIR_COURIER','AIR_CARGO','SEA_CONSOL')),
  container_no TEXT, vessel TEXT,
  origin_airport TEXT NOT NULL,
  dest_airport TEXT NOT NULL,
  dest_country TEXT NOT NULL,
  airline TEXT, flight_no TEXT, flight_date TEXT,
  mawb_no TEXT,
  agent_id INTEGER REFERENCES agents(id),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED','DEPARTED','ARRIVED','CLEARED','DELIVERED')),
  departed_at TEXT, arrived_at TEXT,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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
  entity_code TEXT NOT NULL DEFAULT 'AE',
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
  entity_code TEXT NOT NULL DEFAULT 'AE',
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

-- Omnichannel agent inbox: every enquiry (call, WhatsApp, email, social, web, walk-in) in one place.
CREATE TABLE IF NOT EXISTS enquiries (
  id INTEGER PRIMARY KEY,
  ref TEXT UNIQUE NOT NULL,
  entity_code TEXT NOT NULL DEFAULT 'AE' REFERENCES entities(code),
  channel TEXT NOT NULL CHECK (channel IN ('PHONE','WHATSAPP','EMAIL','WEBSITE','FACEBOOK','INSTAGRAM','LINKEDIN','TIKTOK','WALKIN','REFERRAL')),
  lead_type TEXT NOT NULL DEFAULT 'GENERAL' CHECK (lead_type IN ('COLLECTION','QUOTE','GENERAL','TRACKING','COMPLAINT')),
  status TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW','QUOTED','BOOKED','LOST','CLOSED')),
  customer_name TEXT NOT NULL,
  mobile TEXT NOT NULL, whatsapp TEXT, landline TEXT, alt_phone TEXT, email TEXT,
  id_type TEXT, id_number TEXT, id_expiry TEXT,
  agent_code TEXT, country TEXT, postcode TEXT,
  address1 TEXT, address2 TEXT, address3 TEXT, city TEXT, district TEXT, region TEXT,
  lat REAL, lng REAL,
  service TEXT, dest_country TEXT, dest_city TEXT, pieces INTEGER, weight_kg REAL, contents TEXT,
  receiver_name TEXT, receiver_phone TEXT, receiver_address TEXT,
  pickup_date TEXT, pickup_window TEXT,
  description TEXT NOT NULL,
  next_action_at TEXT,
  lost_reason TEXT,
  owner_id INTEGER REFERENCES users(id),
  customer_id INTEGER REFERENCES customers(id),
  shipment_id INTEGER REFERENCES shipments(id),
  quotation_id INTEGER REFERENCES quotations(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_enq_entity_status ON enquiries(entity_code, status);
CREATE INDEX IF NOT EXISTS ix_enq_mobile ON enquiries(mobile);
CREATE TABLE IF NOT EXISTS enquiry_messages (
  id INTEGER PRIMARY KEY,
  enquiry_id INTEGER NOT NULL REFERENCES enquiries(id),
  direction TEXT NOT NULL CHECK (direction IN ('IN','OUT','NOTE','SYSTEM')),
  channel TEXT,
  body TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_enqmsg ON enquiry_messages(enquiry_id);
`;

/** Additive column migrations for databases created by earlier releases. */
const COLUMNS = [
  ['shipments', 'pickup_date', 'TEXT'],
  ['shipments', 'pickup_started_at', 'TEXT'],
  ['shipments', 'pickup_missed_reason', 'TEXT'],
  ['shipments', 'enquiry_id', 'INTEGER'],
  ['quotations', 'enquiry_id', 'INTEGER'],
];

export function openDb(file = ':memory:') {
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (file !== ':memory:') raw.exec('PRAGMA journal_mode = WAL;');
  raw.exec(SCHEMA);
  for (const [table, col, type] of COLUMNS) {
    const has = raw.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
    if (!has) raw.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }

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
