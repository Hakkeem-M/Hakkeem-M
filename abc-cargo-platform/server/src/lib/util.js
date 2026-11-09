import { z } from 'zod';
import { nextSeq } from '../db.js';

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
export const notFound = (what = 'Resource') => new HttpError(404, `${what} not found`);
export const badRequest = (msg, details) => new HttpError(400, msg, details);
export const conflict = (msg) => new HttpError(409, msg);

/** Express middleware: validate req.body (or query) with a zod schema. */
export const validate = (schema, source = 'body') => (req, _res, next) => {
  const parsed = schema.safeParse(req[source] ?? {});
  if (!parsed.success) {
    return next(new HttpError(400, 'Validation failed', parsed.error.flatten()));
  }
  if (source === 'body') req.body = parsed.data;
  else req.valid = parsed.data;
  next();
};

export const idParam = (req) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest('Invalid id');
  return id;
};

// AWB: "ABC" + 8-digit serial + mod-7 check digit (IATA-style), e.g. ABC100000013
export function newAwb(db) {
  const serial = 10000000 + nextSeq(db, 'awb');
  return `ABC${serial}${serial % 7}`;
}
export function isValidAwb(awb) {
  const m = /^ABC(\d{8})(\d)$/.exec(String(awb || '').trim().toUpperCase());
  return !!m && Number(m[1]) % 7 === Number(m[2]);
}
export const normalizeAwb = (awb) => String(awb || '').trim().toUpperCase();

export function newInvoiceNumber(db) {
  const year = new Date().getUTCFullYear();
  return `INV-${year}-${String(nextSeq(db, `inv-${year}`)).padStart(6, '0')}`;
}

export const today = () => new Date().toISOString().slice(0, 10);
export const addDays = (d, n) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

// Common field schemas
export const zPhone = z.string().trim().min(7).max(20).regex(/^[+\d][\d\s-]+$/, 'Invalid phone');
export const zText = (max = 200) => z.string().trim().min(1).max(max);
/** Optional number: '' / null / undefined -> undefined (z.coerce alone would turn null into 0). */
export const optNum = (schema) => z.preprocess((v) => (v === '' || v == null ? undefined : v), schema.optional());
export const zLat = optNum(z.coerce.number().min(-90).max(90));
export const zLng = optNum(z.coerce.number().min(-180).max(180));
export const zMoney = z.coerce.number().min(0).max(1_000_000);
export const zDataImage = (maxBytes) =>
  z.string().max(Math.ceil(maxBytes * 1.37) + 50)
    .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/, 'Must be a base64 PNG/JPEG/WebP data URL');

export function paginate(q) {
  const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
  const page = Math.max(1, Number(q.page) || 1);
  return { limit, offset: (page - 1) * limit, page };
}
