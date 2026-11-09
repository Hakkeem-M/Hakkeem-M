// Rating engine — international air courier / air cargo first, UAE domestic second.
// Zones: domestic LOCAL / DOMESTIC; international Z1..Z6 from the countries table.

export const SERVICES = {
  INTL_EXPRESS: 'International Express (Air Courier)',
  INTL_ECONOMY: 'International Economy (Air)',
  AIR_CARGO: 'Air Freight Cargo',
  SAME_DAY: 'Same Day (UAE)',
  EXPRESS: 'Domestic Express (Next Day)',
  STANDARD: 'Domestic Standard',
};
export const INTL_SERVICES = new Set(['INTL_EXPRESS', 'INTL_ECONOMY', 'AIR_CARGO']);

export const ZONES = {
  Z1: 'GCC', Z2: 'Indian Subcontinent', Z3: 'Asia Pacific', Z4: 'Europe', Z5: 'Americas', Z6: 'Africa & Rest of World',
  LOCAL: 'UAE — same emirate', DOMESTIC: 'UAE — other emirate',
};

export const UAE_CITIES = {
  Dubai: 'Dubai', 'Abu Dhabi': 'Abu Dhabi', 'Al Ain': 'Abu Dhabi', Sharjah: 'Sharjah', Ajman: 'Ajman',
  'Umm Al Quwain': 'Umm Al Quwain', 'Ras Al Khaimah': 'Ras Al Khaimah', Fujairah: 'Fujairah',
};

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** @param countryZone zone of destination country (from countries table) for non-AE */
export function zoneFor(originCity, destCity, destCountry = 'AE', countryZone = 'Z6') {
  const country = (destCountry || 'AE').toUpperCase();
  if (country !== 'AE') return countryZone || 'Z6';
  const a = UAE_CITIES[originCity];
  const b = UAE_CITIES[destCity];
  if (!a || !b) return 'DOMESTIC';
  return a === b ? 'LOCAL' : 'DOMESTIC';
}
export const isIntlZone = (z) => /^Z\d$/.test(z);

export function chargeableWeight({ weight, length, width, height, divisor = 5000, pieces = 1 }) {
  const actual = Number(weight) || 0;
  const vol = length && width && height ? ((Number(length) * Number(width) * Number(height)) / divisor) * (Number(pieces) || 1) : 0;
  // Round up to the next 0.5 kg, industry standard.
  return Math.max(0.5, Math.ceil(Math.max(actual, vol) * 2) / 2);
}

/**
 * Duties & import taxes estimate (destination country), used for DDP billing and DAP guidance.
 * duty = CIF value × duty%  (only above de-minimis);  import VAT = (CIF + duty) × VAT%.
 */
export function estimateDuties({ customs_value: value = 0, freight = 0, product }, country) {
  if (!country || product === 'DOCUMENT') return { duty: 0, import_vat: 0, total: 0, applies: false };
  const v = Number(value) || 0;
  if (v <= (country.de_minimis || 0)) return { duty: 0, import_vat: 0, total: 0, applies: false };
  const cif = v + Number(freight || 0);
  const duty = round2(cif * (country.duty_pct / 100));
  const importVat = round2((cif + duty) * (country.import_vat_pct / 100));
  return { duty, import_vat: importVat, total: round2(duty + importVat), applies: true };
}

/**
 * @param p  { service, zone, weight, length, width, height, pieces, cod_amount, customs_value, incoterm, product }
 * @param rate  rates row
 * @param settings  key/value settings
 * @param country  countries row (international only)
 */
export function priceShipment(p, rate, settings, country) {
  if (!rate) {
    const err = new Error(`Service ${p.service} is not available to this destination (zone ${p.zone})`);
    err.status = 422;
    throw err;
  }
  const intl = isIntlZone(p.zone);
  const divisor = Number(rate.divisor || settings.volumetric_divisor || 5000);
  const cw = chargeableWeight({ ...p, divisor });
  const extraKg = Math.max(0, Math.ceil((cw - rate.base_weight) * 2) / 2);
  const freight = round2(Math.max(rate.min_charge || 0, rate.base_price + extraKg * rate.per_kg));
  const fuelPct = Number((intl ? settings.intl_fuel_surcharge_pct : settings.fuel_surcharge_pct) ?? settings.fuel_surcharge_pct ?? 0);
  const fuel = round2(freight * (fuelPct / 100));
  const cod = intl ? 0 : Number(p.cod_amount) || 0; // COD is domestic only
  const codFee = cod > 0 ? round2(Math.max(Number(settings.cod_fee_min || 0), cod * (Number(settings.cod_fee_pct || 0) / 100))) : 0;
  const dg = p.dangerous_goods ? round2(Number(settings.dg_surcharge || 0)) : 0;
  const duties = intl ? estimateDuties({ customs_value: p.customs_value, freight, product: p.product }, country) : null;
  const dutiesBilled = intl && p.incoterm === 'DDP' ? duties.total : 0;
  const subtotal = round2(freight + fuel + codFee + dg + dutiesBilled);
  // Export services are zero-rated for UAE VAT; duties are disbursements (no VAT).
  const vatRate = intl ? 0 : Number(settings.vat_rate_pct ?? 5);
  const vat = round2((subtotal - dutiesBilled) * (vatRate / 100));
  return {
    chargeable_weight: cw,
    freight,
    fuel_surcharge: fuel,
    cod_fee: codFee,
    dg_surcharge: dg,
    duties_estimate: dutiesBilled,
    duties_guide: duties,
    subtotal,
    vat_rate: vatRate,
    vat,
    total_charge: round2(subtotal + vat),
    transit: rate.transit,
  };
}

export function countryRow(db, code) {
  return code && code.toUpperCase() !== 'AE' ? db.get('SELECT * FROM countries WHERE code = ? AND active = 1', code.toUpperCase()) : null;
}

export function quoteAll(db, settings, p) {
  const country = countryRow(db, p.dest_country);
  if (p.dest_country && p.dest_country.toUpperCase() !== 'AE' && !country) {
    const e = new Error('We do not ship to this country yet'); e.status = 422; throw e;
  }
  const zone = zoneFor(p.origin_city, p.dest_city, p.dest_country, country?.zone);
  const rates = db.all('SELECT * FROM rates WHERE zone = ? AND active = 1', zone);
  return rates.map((rate) => ({
    service: rate.service,
    service_name: SERVICES[rate.service] || rate.service,
    zone,
    zone_name: ZONES[zone],
    ...priceShipment({ ...p, zone, service: rate.service }, rate, settings, country),
  })).sort((a, b) => a.total_charge - b.total_charge);
}
