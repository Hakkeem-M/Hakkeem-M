import { z } from 'zod';
import { SERVICES } from './pricing.js';
import { zPhone, zText, zMoney, optNum, zLat, zLng } from './util.js';

const service = z.enum(Object.keys(SERVICES));
const country = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'ISO country code');
const dim = optNum(z.coerce.number().positive().max(400));
const optStr = (n) => z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().trim().max(n).optional());

const box = z.object({
  actual_weight: z.coerce.number().positive().max(5000),
  length: dim, width: dim, height: dim,
  category: optStr(40),
  packing_type: optStr(30),
});

export const parcelFields = {
  service,
  boxes: z.array(box).max(200).optional(),
  handling_charge: zMoney.optional(),
  other_charge: zMoney.optional(),
  discount: zMoney.optional(),
  packing_type: optStr(30),
  origin_city: zText(60),
  dest_city: zText(80),
  dest_country: country.default('AE'),
  pieces: z.coerce.number().int().min(1).max(9999).default(1),
  weight: optNum(z.coerce.number().positive().max(50000)), // optional when boxes[] are given
  length: dim, width: dim, height: dim,
  cod_amount: zMoney.default(0),
  product: z.enum(['DOCUMENT', 'PARCEL', 'CARGO']).default('PARCEL'),
  incoterm: z.enum(['DAP', 'DDP']).optional(),
  customs_value: zMoney.optional(),
  dangerous_goods: z.boolean().default(false),
};

// Commercial invoice line (international).
export const itemInput = z.object({
  description: zText(200),
  hs_code: z.preprocess((v) => (v === '' || v == null ? undefined : String(v).replace(/[.\s]/g, '')),
    z.string().regex(/^\d{6,10}$/, 'HS code must be 6–10 digits').optional()),
  qty: z.coerce.number().int().min(1).max(100000),
  unit_value: z.coerce.number().min(0).max(10_000_000),
  weight: optNum(z.coerce.number().positive().max(50000)),
  origin_country: country.default('AE'),
  box_seq: optNum(z.coerce.number().int().min(1).max(200)),
});

export const shipmentInput = z.object({
  ...parcelFields,
  customer_id: z.coerce.number().int().positive().optional(),
  shipper_name: zText(120), shipper_phone: zPhone, shipper_address: zText(300),
  consignee_name: zText(120), consignee_phone: zPhone, consignee_address: zText(300),
  consignee_postcode: optStr(20), consignee_tax_id: optStr(40),
  consignee_email: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().trim().email().max(160).optional()),
  description: z.string().trim().max(300).optional(),
  declared_value: zMoney.default(0),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default('AED'),
  export_reason: z.enum(['SALE', 'GIFT', 'SAMPLE', 'RETURN', 'PERSONAL', 'REPAIR']).optional(),
  items: z.array(itemInput).max(100).optional(),
  reference: z.string().trim().max(60).optional(),
  pickup_lat: zLat, pickup_lng: zLng, dest_lat: zLat, dest_lng: zLng,
  pickup_window: z.string().trim().max(40).optional(),
  // UK-style door-to-door booking fields
  order_branch_id: optNum(z.coerce.number().int().positive()),
  invoice_branch_id: optNum(z.coerce.number().int().positive()),
  sector: optStr(40),
  agent_code: optStr(20),
  sender_id_type: optStr(30), sender_id_no: optStr(40), sender_id_expiry: optStr(10),
  receiver_id_type: optStr(30), receiver_id_no: optStr(40),
  consignee_company: optStr(120), consignee_state: optStr(60), consignee_district: optStr(60),
  receiver_id: optNum(z.coerce.number().int().positive()),
  receiver_relation: optStr(40),
  save_receiver: z.boolean().optional(),
  quotation_id: optNum(z.coerce.number().int().positive()),
});

export const quoteInput = z.object({
  ...parcelFields,
  service: service.optional(),
  entity: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/).optional(), // origin region (AE, GB, SA, IN)
});
