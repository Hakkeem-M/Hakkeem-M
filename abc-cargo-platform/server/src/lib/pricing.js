// Rating engine — multi-entity (UAE, UK, ...): international air courier / air cargo / sea cargo first,
// domestic second. Zones: same-country = LOCAL / DOMESTIC; abroad = Z1..Z6 from the countries table.

export const SERVICES = {
  INTL_EXPRESS: 'International Express (Air Courier)',
  INTL_ECONOMY: 'International Economy (Air)',
  AIR_CARGO: 'Air Freight Cargo',
  SEA_CARGO: 'Sea Cargo door-to-door (per CBM)',
  SAME_DAY: 'Same Day',
  EXPRESS: 'Domestic Express (Next Day)',
  STANDARD: 'Domestic Standard',
};
export const INTL_SERVICES = new Set(['INTL_EXPRESS', 'INTL_ECONOMY', 'AIR_CARGO', 'SEA_CARGO']);
export const modeFor = (service) => (service === 'SEA_CARGO' ? 'SEA' : INTL_SERVICES.has(service) ? 'AIR' : 'ROAD');

export const ZONES = {
  Z1: 'GCC / Middle East', Z2: 'Indian Subcontinent', Z3: 'Asia Pacific', Z4: 'Europe', Z5: 'Americas', Z6: 'Africa & Rest of World',
  LOCAL: 'Same city / emirate', DOMESTIC: 'Domestic',
};

// Cities by entity. UAE uses emirate grouping for LOCAL vs DOMESTIC.
export const CITIES = {
  AE: {
    Dubai: 'Dubai', 'Abu Dhabi': 'Abu Dhabi', 'Al Ain': 'Abu Dhabi', Sharjah: 'Sharjah', Ajman: 'Ajman',
    'Umm Al Quwain': 'Umm Al Quwain', 'Ras Al Khaimah': 'Ras Al Khaimah', Fujairah: 'Fujairah',
  },
  GB: {
    London: 'London', Croydon: 'London', Ilford: 'London', Southall: 'London', Wembley: 'London',
    Birmingham: 'Birmingham', Manchester: 'Manchester', Leicester: 'Leicester', Leeds: 'Leeds', Bradford: 'Leeds',
    Glasgow: 'Glasgow', Edinburgh: 'Edinburgh', Cardiff: 'Cardiff', Bristol: 'Bristol', Liverpool: 'Liverpool',
  },
  SA: {
    Riyadh: 'Riyadh', Jeddah: 'Makkah', Makkah: 'Makkah', Taif: 'Makkah', Madinah: 'Madinah',
    Dammam: 'Eastern', Khobar: 'Eastern', Jubail: 'Eastern', 'Al Ahsa': 'Eastern', Buraidah: 'Qassim', Abha: 'Asir', Tabuk: 'Tabuk',
  },
  IN: {
    Mumbai: 'Maharashtra', Pune: 'Maharashtra', Delhi: 'Delhi', Bengaluru: 'Karnataka', Chennai: 'Tamil Nadu',
    Hyderabad: 'Telangana', Kolkata: 'West Bengal', Kochi: 'Kerala', Kozhikode: 'Kerala', Thiruvananthapuram: 'Kerala',
    Thrissur: 'Kerala', Malappuram: 'Kerala', Kannur: 'Kerala', Ahmedabad: 'Gujarat', Lucknow: 'Uttar Pradesh',
  },
};
export const UAE_CITIES = CITIES.AE;

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;

/** @param origin entity/origin country (AE, GB) */
export function zoneFor(originCity, destCity, destCountry = 'AE', countryZone = 'Z6', origin = 'AE') {
  const country = (destCountry || origin).toUpperCase();
  if (country !== origin) return countryZone || 'Z6';
  const map = CITIES[origin] || {};
  const a = map[originCity];
  const b = map[destCity];
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

/** Per-box measurements: volume weight, bill weight and CBM. */
export function measureBoxes(boxes, divisor) {
  const out = boxes.map((b, i) => {
    const dims = b.length && b.width && b.height;
    const cm3 = dims ? Number(b.length) * Number(b.width) * Number(b.height) : 0;
    const volumeWeight = round2(cm3 / divisor);
    return {
      seq: i + 1,
      actual_weight: Number(b.actual_weight),
      length: b.length ?? null, width: b.width ?? null, height: b.height ?? null,
      volume_weight: volumeWeight,
      bill_weight: Math.max(0.5, Math.ceil(Math.max(Number(b.actual_weight), volumeWeight) * 2) / 2),
      cbm: round3(cm3 / 1_000_000),
      category: b.category ?? null,
      packing_type: b.packing_type ?? null,
      packing_charge: 0,
    };
  });
  return {
    boxes: out,
    weight: round2(out.reduce((a, b) => a + b.actual_weight, 0)),
    bill_weight: out.reduce((a, b) => a + b.bill_weight, 0),
    cbm: round3(out.reduce((a, b) => a + b.cbm, 0)),
  };
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
 * @param p        { service, zone, weight, length, width, height, pieces, boxes?, cod_amount, customs_value, incoterm, product,
 *                   handling_charge, other_charge, discount, dangerous_goods }
 * @param rate     rates row (unit KG or CBM)
 * @param settings merged global + entity settings (see settingsFor)
 * @param country  destination countries row (international only)
 * @param packing  map packing_type -> charge for this entity
 */
export function priceShipment(p, rate, settings, country, packing = {}) {
  if (!rate) {
    const err = new Error(`Service ${p.service} is not available to this destination (zone ${p.zone})`);
    err.status = 422;
    throw err;
  }
  const intl = isIntlZone(p.zone);
  const divisor = Number(rate.divisor || settings.volumetric_divisor || 5000);
  let cw;
  let cbm = 0;
  let boxes = null;
  if (p.boxes?.length) {
    const m = measureBoxes(p.boxes, divisor);
    boxes = m.boxes.map((b) => ({ ...b, packing_charge: round2(packing[b.packing_type] || 0) }));
    cw = m.bill_weight;
    cbm = m.cbm;
  } else {
    cw = chargeableWeight({ ...p, divisor });
    if (p.length && p.width && p.height) cbm = round3((p.length * p.width * p.height * (p.pieces || 1)) / 1_000_000);
  }

  let freight;
  let chargeableUnits;
  if (rate.unit === 'CBM') {
    // Sea cargo: billed per CBM; 1 CBM ≈ 1,000 kg weight-or-measure rule; minimum base volume.
    chargeableUnits = Math.max(rate.base_weight, Math.ceil(Math.max(cbm, cw / 1000) * 100) / 100);
    freight = round2(Math.max(rate.min_charge || 0, rate.base_price + Math.max(0, chargeableUnits - rate.base_weight) * rate.per_kg));
  } else {
    chargeableUnits = cw;
    const extraKg = Math.max(0, Math.ceil((cw - rate.base_weight) * 2) / 2);
    freight = round2(Math.max(rate.min_charge || 0, rate.base_price + extraKg * rate.per_kg));
  }

  const fuelPct = Number(intl ? settings.intl_fuel_surcharge_pct : settings.fuel_surcharge_pct) || 0;
  const fuel = rate.unit === 'CBM' ? 0 : round2(freight * (fuelPct / 100));
  const cod = intl ? 0 : Number(p.cod_amount) || 0; // COD is domestic only
  const codFee = cod > 0 ? round2(Math.max(Number(settings.cod_fee_min || 0), cod * (Number(settings.cod_fee_pct || 0) / 100))) : 0;
  const dg = p.dangerous_goods ? round2(Number(settings.dg_surcharge || 0)) : 0;
  const packingCharge = boxes ? round2(boxes.reduce((a, b) => a + b.packing_charge, 0)) : round2(packing[p.packing_type] || 0);
  const awb = intl ? round2(Number(settings.awb_charge || 0)) : 0;
  const handling = round2(Number(p.handling_charge) || 0);
  const other = round2(Number(p.other_charge) || 0);
  const discount = round2(Number(p.discount) || 0);
  const duties = intl ? estimateDuties({ customs_value: p.customs_value, freight, product: p.product }, country) : null;
  const dutiesBilled = intl && p.incoterm === 'DDP' ? duties.total : 0;
  const taxable = round2(freight + fuel + codFee + dg + packingCharge + awb + handling + other - discount);
  if (taxable < 0) { const e = new Error('Discount exceeds charges'); e.status = 422; throw e; }
  const subtotal = round2(taxable + dutiesBilled);
  // Exports are zero-rated for VAT in both UAE and UK; duties are disbursements (no VAT).
  const vatRate = intl ? 0 : Number(settings.vat_rate_pct ?? 5);
  const vat = round2(taxable * (vatRate / 100));
  return {
    chargeable_weight: cw,
    chargeable_units: chargeableUnits,
    unit: rate.unit || 'KG',
    cbm,
    boxes,
    freight,
    fuel_surcharge: fuel,
    cod_fee: codFee,
    dg_surcharge: dg,
    packing_charge: packingCharge,
    awb_charge: awb,
    handling_charge: handling,
    other_charge: other,
    discount,
    duties_estimate: dutiesBilled,
    duties_guide: duties,
    subtotal,
    vat_rate: vatRate,
    vat,
    total_charge: round2(subtotal + vat),
    transit: rate.transit,
    currency: settings.currency,
  };
}

export function countryRow(db, code, origin = 'AE') {
  const c = (code || origin).toUpperCase();
  return c !== origin ? db.get('SELECT * FROM countries WHERE code = ? AND active = 1', c) : null;
}

export function quoteAll(db, settings, p, packing = {}) {
  if (!p.boxes?.length && !(Number(p.weight) > 0)) { const e = new Error('Enter the weight or add box details'); e.status = 400; throw e; }
  const origin = settings.entity_code || 'AE';
  const destCountry = (p.dest_country || origin).toUpperCase();
  const country = countryRow(db, destCountry, origin);
  if (destCountry !== origin && !country) {
    const e = new Error('We do not ship to this country yet'); e.status = 422; throw e;
  }
  const zone = zoneFor(p.origin_city, p.dest_city, destCountry, country?.zone, origin);
  const rates = db.all('SELECT * FROM rates WHERE entity_code = ? AND zone = ? AND active = 1', origin, zone);
  return rates.map((rate) => ({
    service: rate.service,
    service_name: SERVICES[rate.service] || rate.service,
    mode: modeFor(rate.service),
    zone,
    zone_name: ZONES[zone],
    ...priceShipment({ ...p, zone, service: rate.service }, rate, settings, country, packing),
  })).sort((a, b) => a.total_charge - b.total_charge);
}
