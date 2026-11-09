import { z } from 'zod';
import { SERVICES, COUNTRIES } from './pricing.js';
import { zPhone, zText, zMoney, optNum, zLat, zLng } from './util.js';

const service = z.enum(Object.keys(SERVICES));
const country = z.string().trim().toUpperCase().refine((c) => c in COUNTRIES, 'Unsupported country');
const dim = optNum(z.coerce.number().positive().max(300));

export const parcelFields = {
  service,
  origin_city: zText(60),
  dest_city: zText(60),
  dest_country: country.default('AE'),
  pieces: z.coerce.number().int().min(1).max(999).default(1),
  weight: z.coerce.number().positive().max(5000),
  length: dim, width: dim, height: dim,
  cod_amount: zMoney.default(0),
};

export const shipmentInput = z.object({
  ...parcelFields,
  customer_id: z.coerce.number().int().positive().optional(),
  shipper_name: zText(120), shipper_phone: zPhone, shipper_address: zText(300),
  consignee_name: zText(120), consignee_phone: zPhone, consignee_address: zText(300),
  description: z.string().trim().max(300).optional(),
  declared_value: zMoney.default(0),
  reference: z.string().trim().max(60).optional(),
  pickup_lat: zLat, pickup_lng: zLng, dest_lat: zLat, dest_lng: zLng,
  pickup_window: z.string().trim().max(40).optional(),
});

export const quoteInput = z.object({
  ...parcelFields,
  service: service.optional(),
});
