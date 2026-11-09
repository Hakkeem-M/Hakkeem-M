// Core shipment / billing domain operations, shared by ERP, driver, warehouse and customer routes.
import { audit } from '../db.js';
import { settingsFor, packingMap } from './entity.js';
import { priceShipment, zoneFor, round2, countryRow, INTL_SERVICES, modeFor } from './pricing.js';
import { cityPoint, validPoint } from './geo.js';
import { HttpError, newAwb, newInvoiceNumber, today, addDays, badRequest } from './util.js';

export const STATUSES = [
  'BOOKED', 'PICKUP_ASSIGNED', 'PICKED_UP', 'IN_WAREHOUSE', 'IN_TRANSIT',
  // international export / import milestones
  'MANIFESTED', 'DEPARTED', 'ARRIVED', 'CUSTOMS_HOLD', 'CUSTOMS_CLEARED', 'WITH_AGENT',
  'OUT_FOR_DELIVERY', 'DELIVERED', 'DELIVERY_FAILED', 'RETURNED', 'CANCELLED',
];
export const STATUS_LABEL = {
  BOOKED: 'Booked', PICKUP_ASSIGNED: 'Pickup assigned', PICKED_UP: 'Picked up',
  IN_WAREHOUSE: 'At hub', IN_TRANSIT: 'In transit (UAE)',
  MANIFESTED: 'Export cleared & manifested', DEPARTED: 'Departed on flight', ARRIVED: 'Arrived at destination',
  CUSTOMS_HOLD: 'Held at customs', CUSTOMS_CLEARED: 'Cleared customs', WITH_AGENT: 'With delivery partner',
  OUT_FOR_DELIVERY: 'Out for delivery', DELIVERED: 'Delivered', DELIVERY_FAILED: 'Delivery attempted',
  RETURNED: 'Returned to shipper', CANCELLED: 'Cancelled',
};
export const FINAL = new Set(['DELIVERED', 'RETURNED', 'CANCELLED']);

export function addEvent(db, shipmentId, status, { location, note, userId, lat, lng, isPublic = true } = {}) {
  db.run(
    `INSERT INTO shipment_events (shipment_id, status, location, note, public, user_id, lat, lng)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    shipmentId, status, location ?? null, note ?? null, isPublic ? 1 : 0, userId ?? null, lat ?? null, lng ?? null,
  );
}

export function setStatus(db, shipmentId, status, extra = {}) {
  const fields = { ...extra, status };
  const keys = Object.keys(fields);
  db.run(
    `UPDATE shipments SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
    ...keys.map((k) => fields[k]), shipmentId,
  );
}

export function rateFor(db, service, zone, entity = 'AE') {
  return db.get('SELECT * FROM rates WHERE entity_code = ? AND service = ? AND zone = ? AND active = 1', entity, service, zone);
}

/** Price a booking for its entity (origin country). Throws 4xx on unserved destination / wrong service family. */
export function computeCharges(db, data) {
  if (!data.boxes?.length && !(Number(data.weight) > 0)) throw badRequest('Enter the weight or add box details');
  const entity = (data.entity_code || 'AE').toUpperCase();
  const settings = settingsFor(db, entity);
  const dest = (data.dest_country || entity).toUpperCase();
  const intl = dest !== entity;
  const country = countryRow(db, dest, entity);
  if (intl && !country) throw badRequest('Destination country is not served');
  const zone = zoneFor(data.origin_city, data.dest_city, dest, country?.zone, entity);
  if (intl !== INTL_SERVICES.has(data.service)) throw badRequest(intl ? 'Choose an international service' : 'Choose a domestic service');
  const charges = priceShipment({ ...data, zone }, rateFor(db, data.service, zone, entity), settings, country, packingMap(db, entity));
  return { zone, country, entity, settings, ...charges };
}

/** Customs docs are complete when every non-document export has itemised contents with HS codes and values. */
export function customsDocsOk(product, items) {
  if (product === 'DOCUMENT') return true;
  return items.length > 0 && items.every((i) => i.description && /^\d{6,10}$/.test(String(i.hs_code || '').replace(/\./g, '')) && i.qty > 0 && i.unit_value >= 0);
}

/** Upsert a saved receiver from booking data. Returns receiver id. */
export function saveReceiver(db, customerId, d) {
  const existing = d.receiver_id
    ? db.get('SELECT id FROM receivers WHERE id = ? AND customer_id = ?', d.receiver_id, customerId)
    : db.get('SELECT id FROM receivers WHERE customer_id = ? AND phone = ? AND lower(name) = lower(?)', customerId, d.consignee_phone, d.consignee_name);
  const vals = [d.consignee_name, d.consignee_company ?? null, d.consignee_phone, d.consignee_email ?? null,
    (d.dest_country || 'AE').toUpperCase(), d.consignee_state ?? null, d.consignee_district ?? null, d.dest_city,
    d.consignee_postcode ?? null, d.consignee_address, d.consignee_tax_id ?? null, d.receiver_id_no ?? null, d.receiver_relation ?? null];
  if (existing) {
    db.run(`UPDATE receivers SET name=?, company=?, phone=?, email=?, country=?, state=?, district=?, city=?, postcode=?, address=?,
              tax_id=?, national_id=?, relation=COALESCE(?, relation), use_count = use_count + 1, last_used_at = datetime('now') WHERE id = ?`,
    ...vals, existing.id);
    return existing.id;
  }
  return Number(db.run(`INSERT INTO receivers (name, company, phone, email, country, state, district, city, postcode, address, tax_id, national_id, relation,
                          customer_id, use_count, last_used_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,datetime('now'))`, ...vals, customerId).lastInsertRowid);
}

/**
 * Create a shipment with AWB, pricing, boxes, items and the first tracking event.
 * @returns the created shipment row
 */
export function createShipment(db, req, data, { status = 'BOOKED', paymentMode, driverId = null, location } = {}) {
  return db.tx(() => {
    const customer = db.get('SELECT * FROM customers WHERE id = ? AND active = 1', data.customer_id);
    if (!customer) throw badRequest('Customer not found or inactive');
    const mode = paymentMode || (customer.type === 'ACCOUNT' ? 'ACCOUNT' : 'CASH');
    if (mode === 'ACCOUNT' && customer.type !== 'ACCOUNT') throw badRequest('Customer has no credit account');
    const entity = customer.entity_code;
    const dest = (data.dest_country || entity).toUpperCase();
    const intl = dest !== entity;
    const items = intl ? (data.items || []) : [];
    if (intl && data.product !== 'DOCUMENT' && !items.length) throw badRequest('International parcels need itemised contents (commercial invoice)');
    if (data.boxes?.length && items.some((i) => i.box_seq && i.box_seq > data.boxes.length)) throw badRequest('Item refers to a box that does not exist');
    const customsValue = intl
      ? round2(items.length ? items.reduce((a, i) => a + i.qty * i.unit_value, 0) : (data.customs_value ?? data.declared_value ?? 0))
      : 0;
    data = {
      ...data, entity_code: entity, dest_country: dest, customs_value: customsValue,
      incoterm: intl ? (data.incoterm || 'DAP') : null, product: data.product || 'PARCEL',
    };
    if (data.boxes?.length) {
      data.pieces = data.boxes.length;
      data.weight = round2(data.boxes.reduce((a, b) => a + Number(b.actual_weight), 0));
    }
    const c = computeCharges(db, data);
    const awb = newAwb(db);
    const branch = (id) => (id ? db.get('SELECT id FROM branches WHERE id = ? AND entity_code = ?', id, entity)?.id ?? null : null);
    // GPS pin from the app/map when provided, otherwise city centroid (flagged for dispatcher to refine).
    const pick = validPoint({ lat: data.pickup_lat, lng: data.pickup_lng })
      ? { lat: data.pickup_lat, lng: data.pickup_lng } : cityPoint(data.origin_city);
    const drop = validPoint({ lat: data.dest_lat, lng: data.dest_lng })
      ? { lat: data.dest_lat, lng: data.dest_lng } : cityPoint(data.dest_city);
    const gateway = intl ? (modeFor(data.service) === 'SEA' ? null : c.country?.airport ?? null) : null;
    const r = db.run(
      `INSERT INTO shipments (awb, customer_id, service, zone, status, payment_mode,
        shipper_name, shipper_phone, shipper_address, origin_city,
        consignee_name, consignee_phone, consignee_address, dest_city, dest_country,
        pieces, weight, length, width, height, chargeable_weight, description, declared_value, reference,
        cod_amount, freight, fuel_surcharge, cod_fee, subtotal, vat_rate, vat, total_charge,
        driver_id, created_by, pickup_lat, pickup_lng, dest_lat, dest_lng, pickup_window,
        shipment_type, product, incoterm, currency, customs_value, export_reason, consignee_tax_id, consignee_postcode,
        consignee_email, dangerous_goods, duties_estimate, customs_status, dest_airport,
        entity_code, order_branch_id, invoice_branch_id, mode, sector, box_count, cbm, packing_charge, awb_charge,
        handling_charge, other_charge, discount, quotation_id, agent_code,
        sender_id_type, sender_id_no, sender_id_expiry, receiver_id_type, receiver_id_no,
        consignee_company, consignee_state, consignee_district)
       VALUES (?,?,?,?,?,?, ?,?,?,?, ?,?,?,?,?, ?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?, ?,?, ?,?,?,?,?, ?,?,?,?,?,?,?,?, ?,?,?,?,?,
               ?,?,?,?,?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?, ?,?,?)`,
      awb, customer.id, data.service, c.zone, status, mode,
      data.shipper_name, data.shipper_phone, data.shipper_address, data.origin_city,
      data.consignee_name, data.consignee_phone, data.consignee_address, data.dest_city, dest,
      data.pieces ?? 1, data.weight, data.length ?? null, data.width ?? null, data.height ?? null, c.chargeable_weight,
      data.description ?? null, data.declared_value ?? 0, data.reference ?? null,
      data.cod_amount ?? 0, c.freight, c.fuel_surcharge, c.cod_fee, c.subtotal, c.vat_rate, c.vat, c.total_charge,
      driverId, req.user?.id ?? null, pick?.lat ?? null, pick?.lng ?? null, drop?.lat ?? null, drop?.lng ?? null,
      data.pickup_window ?? null,
      intl ? 'INTERNATIONAL' : 'DOMESTIC', data.product, data.incoterm, c.currency, customsValue,
      intl ? (data.export_reason || 'SALE') : null, data.consignee_tax_id ?? null, data.consignee_postcode ?? null,
      data.consignee_email ?? null, data.dangerous_goods ? 1 : 0, c.duties_estimate,
      intl ? (customsDocsOk(data.product, items) ? 'DOCS_OK' : 'PENDING') : 'NOT_REQUIRED', gateway,
      entity, branch(data.order_branch_id), branch(data.invoice_branch_id), modeFor(data.service), data.sector ?? null,
      c.boxes?.length || data.pieces || 1, c.cbm || 0, c.packing_charge, c.awb_charge,
      c.handling_charge, c.other_charge, c.discount, data.quotation_id ?? null, data.agent_code ?? customer.agent_code ?? null,
      data.sender_id_type ?? null, data.sender_id_no ?? null, data.sender_id_expiry ?? null, data.receiver_id_type ?? null, data.receiver_id_no ?? null,
      data.consignee_company ?? null, data.consignee_state ?? null, data.consignee_district ?? null,
    );
    const id = Number(r.lastInsertRowid);
    for (const b of c.boxes || []) {
      db.run(`INSERT INTO shipment_boxes (shipment_id, seq, label, actual_weight, length, width, height, volume_weight, bill_weight, cbm,
                category, packing_type, packing_charge) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, b.seq, `${awb}-${String(b.seq).padStart(2, '0')}`, b.actual_weight, b.length, b.width, b.height, b.volume_weight,
      b.bill_weight, b.cbm, b.category, b.packing_type, b.packing_charge);
    }
    for (const it of items) {
      db.run('INSERT INTO shipment_items (shipment_id, description, hs_code, qty, unit_value, weight, origin_country, box_seq) VALUES (?,?,?,?,?,?,?,?)',
        id, it.description, it.hs_code ?? null, it.qty, it.unit_value, it.weight ?? null, (it.origin_country || entity).toUpperCase(), it.box_seq ?? null);
    }
    if (data.save_receiver !== false && (data.receiver_id || data.save_receiver)) {
      db.run('UPDATE shipments SET receiver_id = ? WHERE id = ?', saveReceiver(db, customer.id, data), id);
    }
    addEvent(db, id, 'BOOKED', { location: data.origin_city, note: 'Shipment booked', userId: req.user?.id });
    if (status !== 'BOOKED') addEvent(db, id, status, { location: location || data.origin_city, userId: req.user?.id });
    audit(db, req, 'shipment.create', 'shipment', awb, { service: data.service, total: c.total_charge, currency: c.currency });
    return db.get('SELECT * FROM shipments WHERE id = ?', id);
  });
}

/** Re-price a shipment (e.g. driver re-weighed at pickup). Only allowed before invoicing. */
export function repriceShipment(db, shipment, changes) {
  if (shipment.invoice_id) throw new HttpError(409, 'Shipment already invoiced; cannot re-price');
  const merged = { ...shipment, ...changes, dangerous_goods: !!(changes.dangerous_goods ?? shipment.dangerous_goods) };
  const boxes = db.all('SELECT * FROM shipment_boxes WHERE shipment_id = ? ORDER BY seq', shipment.id);
  if (boxes.length && !changes.weight) merged.boxes = boxes;
  const c = computeCharges(db, merged);
  db.run(
    `UPDATE shipments SET pieces = ?, weight = ?, length = ?, width = ?, height = ?, chargeable_weight = ?, cbm = ?,
      freight = ?, fuel_surcharge = ?, cod_fee = ?, packing_charge = ?, awb_charge = ?, subtotal = ?, vat_rate = ?, vat = ?, total_charge = ?,
      duties_estimate = ?, updated_at = datetime('now')
     WHERE id = ?`,
    merged.pieces, merged.weight, merged.length ?? null, merged.width ?? null, merged.height ?? null, c.chargeable_weight, c.cbm || 0,
    c.freight, c.fuel_surcharge, c.cod_fee, c.packing_charge, c.awb_charge, c.subtotal, c.vat_rate, c.vat, c.total_charge,
    c.duties_estimate, shipment.id,
  );
  return db.get('SELECT * FROM shipments WHERE id = ?', shipment.id);
}

/** Build an invoice for one or more shipments (all must belong to the same customer). */
export function createInvoice(db, req, customerId, shipments, { type, notes } = {}) {
  return db.tx(() => {
    if (!shipments.length) throw badRequest('No billable shipments');
    const customer = db.get('SELECT * FROM customers WHERE id = ?', customerId);
    if (!customer) throw badRequest('Customer not found');
    for (const s of shipments) {
      if (s.customer_id !== customerId) throw badRequest(`Shipment ${s.awb} belongs to another customer`);
      if (s.currency !== shipments[0].currency) throw badRequest('Shipments in different currencies cannot share an invoice');
      if (s.invoice_id) throw new HttpError(409, `Shipment ${s.awb} is already invoiced`);
    }
    const subtotal = round2(shipments.reduce((a, s) => a + s.subtotal, 0));
    const vat = round2(shipments.reduce((a, s) => a + s.vat, 0));
    const total = round2(subtotal + vat);
    const invType = type || (customer.type === 'ACCOUNT' ? 'CREDIT' : 'CASH');
    const issue = today();
    const due = invType === 'CREDIT' ? addDays(issue, customer.payment_terms_days) : issue;
    const number = newInvoiceNumber(db);
    const r = db.run(
      `INSERT INTO invoices (number, customer_id, type, status, issue_date, due_date, subtotal, vat, total, notes, created_by, entity_code, currency)
       VALUES (?, ?, ?, 'UNPAID', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      number, customerId, invType, issue, due, subtotal, vat, total, notes ?? null, req.user?.id ?? null, customer.entity_code, shipments[0].currency,
    );
    const invoiceId = Number(r.lastInsertRowid);
    for (const s of shipments) {
      const qty = s.mode === 'SEA' ? `${s.cbm} CBM` : `${s.chargeable_weight} kg`;
      const desc = `${s.awb} · ${s.service} · ${s.origin_city} → ${s.dest_city} · ${s.box_count > 1 ? `${s.box_count} boxes · ` : ''}${qty}` +
        (s.packing_charge ? ` (incl. packing ${s.packing_charge.toFixed(2)})` : '') +
        (s.cod_fee ? ` (incl. COD fee ${s.cod_fee.toFixed(2)})` : '') +
        (s.duties_estimate ? ` (incl. DDP duties & taxes ${s.duties_estimate.toFixed(2)})` : '') +
        (s.shipment_type === 'INTERNATIONAL' ? ' · export, zero-rated' : '');
      db.run(
        'INSERT INTO invoice_lines (invoice_id, shipment_id, description, amount, vat_rate, vat) VALUES (?, ?, ?, ?, ?, ?)',
        invoiceId, s.id, desc, s.subtotal, s.vat_rate, s.vat,
      );
      db.run('UPDATE shipments SET invoice_id = ? WHERE id = ?', invoiceId, s.id);
    }
    audit(db, req, 'invoice.create', 'invoice', number, { total, shipments: shipments.length });
    return db.get('SELECT * FROM invoices WHERE id = ?', invoiceId);
  });
}

export function recordInvoicePayment(db, req, invoiceId, { amount, method, reference }) {
  return db.tx(() => {
    const inv = db.get('SELECT * FROM invoices WHERE id = ?', invoiceId);
    if (!inv) throw new HttpError(404, 'Invoice not found');
    if (inv.status === 'VOID') throw new HttpError(409, 'Invoice is void');
    const balance = round2(inv.total - inv.paid);
    const amt = round2(amount);
    if (amt <= 0) throw badRequest('Amount must be positive');
    if (amt > balance + 0.001) throw badRequest(`Amount exceeds balance due (${balance.toFixed(2)})`);
    db.run(
      `INSERT INTO payments (kind, invoice_id, amount, method, reference, collected_by) VALUES ('INVOICE', ?, ?, ?, ?, ?)`,
      invoiceId, amt, method, reference ?? null, req.user?.id ?? null,
    );
    const paid = round2(inv.paid + amt);
    const status = paid >= inv.total - 0.001 ? 'PAID' : 'PARTIAL';
    db.run('UPDATE invoices SET paid = ?, status = ? WHERE id = ?', paid, status, invoiceId);
    audit(db, req, 'payment.record', 'invoice', inv.number, { amount: amt, method });
    return db.get('SELECT * FROM invoices WHERE id = ?', invoiceId);
  });
}

export function shipmentDetail(db, id) {
  const s = db.get(
    `SELECT s.*, c.name AS customer_name, c.code AS customer_code, u.name AS driver_name, u.phone AS driver_phone,
            b.name AS branch_name, i.number AS invoice_number, i.status AS invoice_status
       FROM shipments s
       JOIN customers c ON c.id = s.customer_id
       LEFT JOIN users u ON u.id = s.driver_id
       LEFT JOIN branches b ON b.id = s.branch_id
       LEFT JOIN invoices i ON i.id = s.invoice_id
      WHERE s.id = ?`, id,
  );
  if (!s) return null;
  s.events = db.all(
    `SELECT e.*, u.name AS user_name FROM shipment_events e LEFT JOIN users u ON u.id = e.user_id
      WHERE shipment_id = ? ORDER BY e.id`, id,
  );
  s.items = db.all('SELECT * FROM shipment_items WHERE shipment_id = ? ORDER BY id', id);
  s.boxes = db.all('SELECT * FROM shipment_boxes WHERE shipment_id = ? ORDER BY seq', id);
  s.documents = db.all('SELECT id, doc_type, doc_no, expiry, (front_image IS NOT NULL) AS has_front, (back_image IS NOT NULL) AS has_back, created_at FROM documents WHERE owner_type = ? AND owner_id = ?', 'SHIPMENT', id);
  s.manifest = s.manifest_id ? db.get('SELECT id, number, mode, status, airline, flight_no, flight_date, mawb_no, dest_airport FROM manifests WHERE id = ?', s.manifest_id) : null;
  s.agent = s.agent_id ? db.get('SELECT id, name, country, tracking_url FROM agents WHERE id = ?', s.agent_id) : null;
  s.scans = db.all(
    `SELECT w.*, b.code AS branch_code FROM warehouse_scans w JOIN branches b ON b.id = w.branch_id
      WHERE shipment_id = ? ORDER BY w.id`, id,
  );
  s.payments = db.all('SELECT * FROM payments WHERE shipment_id = ? OR (invoice_id IS NOT NULL AND invoice_id = ?) ORDER BY id', id, s.invoice_id ?? -1);
  return s;
}
