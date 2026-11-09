// Rating engine: zones, chargeable (volumetric) weight, surcharges, UAE VAT.

export const SERVICES = {
  SAME_DAY: 'Same Day',
  EXPRESS: 'Express (Next Day)',
  STANDARD: 'Standard (2-3 Days)',
};

export const ZONES = {
  LOCAL: 'Same emirate',
  DOMESTIC: 'Other UAE emirate',
  GCC: 'GCC countries',
  INTL: 'International',
};

// City -> emirate (UAE). Used to decide LOCAL vs DOMESTIC zone.
export const UAE_CITIES = {
  Dubai: 'Dubai',
  'Abu Dhabi': 'Abu Dhabi',
  'Al Ain': 'Abu Dhabi',
  Sharjah: 'Sharjah',
  Ajman: 'Ajman',
  'Umm Al Quwain': 'Umm Al Quwain',
  'Ras Al Khaimah': 'Ras Al Khaimah',
  Fujairah: 'Fujairah',
};

export const COUNTRIES = {
  AE: 'United Arab Emirates',
  SA: 'Saudi Arabia', OM: 'Oman', QA: 'Qatar', KW: 'Kuwait', BH: 'Bahrain',
  IN: 'India', PK: 'Pakistan', PH: 'Philippines', GB: 'United Kingdom', US: 'United States', EG: 'Egypt',
};
const GCC = new Set(['SA', 'OM', 'QA', 'KW', 'BH']);

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export function zoneFor(originCity, destCity, destCountry = 'AE') {
  const country = (destCountry || 'AE').toUpperCase();
  if (country !== 'AE') return GCC.has(country) ? 'GCC' : 'INTL';
  const a = UAE_CITIES[originCity];
  const b = UAE_CITIES[destCity];
  if (!a || !b) return 'DOMESTIC';
  return a === b ? 'LOCAL' : 'DOMESTIC';
}

export function chargeableWeight({ weight, length, width, height, divisor = 5000 }) {
  const actual = Number(weight) || 0;
  const vol = length && width && height ? (Number(length) * Number(width) * Number(height)) / divisor : 0;
  // Round up to the next 0.5 kg, industry standard.
  return Math.max(0.5, Math.ceil(Math.max(actual, vol) * 2) / 2);
}

/**
 * @param {object} p  { service, zone, weight, length, width, height, cod_amount }
 * @param {object} rate  row from rates table
 * @param {object} settings  key/value settings
 */
export function priceShipment(p, rate, settings) {
  if (!rate) {
    const err = new Error(`Service ${p.service} is not available for zone ${p.zone}`);
    err.status = 422;
    throw err;
  }
  const divisor = Number(settings.volumetric_divisor || 5000);
  const cw = chargeableWeight({ ...p, divisor });
  const extraKg = Math.max(0, Math.ceil(cw - rate.base_weight));
  const freight = round2(rate.base_price + extraKg * rate.per_kg);
  const fuel = round2(freight * (Number(settings.fuel_surcharge_pct || 0) / 100));
  const cod = Number(p.cod_amount) || 0;
  const codFee = cod > 0
    ? round2(Math.max(Number(settings.cod_fee_min || 0), cod * (Number(settings.cod_fee_pct || 0) / 100)))
    : 0;
  const subtotal = round2(freight + fuel + codFee);
  // Export services (GCC / international) are zero-rated for UAE VAT.
  const vatRate = p.zone === 'GCC' || p.zone === 'INTL' ? 0 : Number(settings.vat_rate_pct ?? 5);
  const vat = round2(subtotal * (vatRate / 100));
  return {
    chargeable_weight: cw,
    freight,
    fuel_surcharge: fuel,
    cod_fee: codFee,
    subtotal,
    vat_rate: vatRate,
    vat,
    total_charge: round2(subtotal + vat),
    transit: rate.transit,
  };
}

export function quoteAll(db, settings, p) {
  const zone = zoneFor(p.origin_city, p.dest_city, p.dest_country);
  const rates = db.all('SELECT * FROM rates WHERE zone = ? AND active = 1', zone);
  return rates.map((rate) => ({
    service: rate.service,
    service_name: SERVICES[rate.service] || rate.service,
    zone,
    ...priceShipment({ ...p, zone, service: rate.service }, rate, settings),
  })).sort((a, b) => a.total_charge - b.total_charge);
}
