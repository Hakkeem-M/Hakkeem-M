// Booking / quotation form shared by ERP, Driver (on-spot) and Customer apps.
// Region-aware (UAE, UK, KSA, India): cities, currency, VAT. International air / sea cargo first, domestic second.
// Supports multi-box door-to-door cargo (per-box packing & CBM), commercial invoice lines, charges, KYC and saved receivers.
import { useEffect, useMemo, useState, lazy, Suspense } from 'react';
import { Field, useForm, ErrorBox } from './ui.jsx';
import { money, SERVICES, REGIONS } from './format.js';
import { getPosition } from './devices.jsx';

const MapView = lazy(() => import('./MapView.jsx'));
const DEFAULT_DEST = { AE: 'IN', GB: 'IN', SA: 'IN', IN: 'AE' };
const ID_TYPES = [['PASSPORT', 'Passport'], ['EMIRATES_ID', 'Emirates ID'], ['CITIZEN_CARD', 'Citizen card'], ['NATIONAL_ID', 'National ID / Aadhaar / Iqama'],
  ['DRIVING_LICENCE', 'Driving licence'], ['RESIDENCE_PERMIT', 'Residence permit / BRP']];

export const blankItem = (box) => ({ description: '', hs_code: '', qty: 1, unit_value: 0, origin_country: '', box_seq: box || '' });
export const blankBox = () => ({ actual_weight: '', length: '', width: '', height: '', packing_type: 'NONE', category: '' });
export const blankShipment = (region = 'AE', over = {}) => ({
  service: 'INTL_EXPRESS', origin_city: '', dest_city: '', dest_country: DEFAULT_DEST[region] || 'IN', pieces: 1, weight: 1,
  length: '', width: '', height: '', cod_amount: 0, declared_value: 0, description: '', reference: '',
  shipper_name: '', shipper_phone: '', shipper_address: '', consignee_name: '', consignee_phone: '', consignee_address: '',
  consignee_postcode: '', consignee_tax_id: '', consignee_email: '', consignee_company: '', consignee_state: '',
  product: 'PARCEL', incoterm: 'DAP', export_reason: 'SALE', dangerous_goods: false, items: [blankItem()],
  use_boxes: false, boxes: [blankBox()], packing_type: 'NONE', handling_charge: '', other_charge: '', discount: '',
  sender_id_type: '', sender_id_no: '', sender_id_expiry: '', receiver_id_type: '', receiver_id_no: '',
  receiver_id: null, save_receiver: true, pickup_lat: null, pickup_lng: null, pickup_window: '', ...over,
});

const num = (v) => (v === '' || v == null ? undefined : Number(v));
const itemsValue = (items) => items.reduce((a, i) => a + (Number(i.qty) || 0) * (Number(i.unit_value) || 0), 0);

export function cleanShipment(v, region) {
  const intl = v.dest_country && v.dest_country !== region;
  const out = { ...v };
  delete out.use_boxes;
  for (const k of Object.keys(out)) if (out[k] === '' || out[k] === null) delete out[k];
  if (out.pickup_lat == null) { delete out.pickup_lat; delete out.pickup_lng; }
  if (v.use_boxes) {
    out.boxes = v.boxes.filter((b) => Number(b.actual_weight) > 0).map((b) => ({
      actual_weight: Number(b.actual_weight), length: num(b.length), width: num(b.width), height: num(b.height),
      packing_type: b.packing_type || undefined, category: b.category || undefined,
    }));
    delete out.weight; delete out.pieces; delete out.length; delete out.width; delete out.height; delete out.packing_type;
  } else delete out.boxes;
  for (const k of ['handling_charge', 'other_charge', 'discount', 'length', 'width', 'height']) if (out[k] !== undefined) out[k] = Number(out[k]);
  if (intl) {
    out.cod_amount = 0;
    out.items = out.product === 'DOCUMENT' ? [] : v.items.filter((i) => i.description).map((i) => ({
      description: i.description, hs_code: i.hs_code || undefined, qty: Number(i.qty), unit_value: Number(i.unit_value),
      origin_country: i.origin_country || region, box_seq: v.use_boxes && i.box_seq ? Number(i.box_seq) : undefined,
    }));
    if (!out.description && out.items[0]) out.description = out.items.map((i) => i.description).join(', ').slice(0, 300);
  } else {
    for (const k of ['items', 'incoterm', 'export_reason', 'consignee_tax_id']) delete out[k];
    out.product = 'PARCEL';
  }
  return out;
}

/**
 * Props: api, region ('AE'|'GB'|'SA'|'IN'), quoteUrl, initial, onSubmit(body, quote), submitLabel, extra(v, quote),
 * hideShipper, busy, mobile, showMap, staff (charges/KYC/boxes default on), receiversUrl (saved receivers list), header (node)
 */
export default function ShipmentForm({ api, region = 'AE', quoteUrl = '/api/public/quote', initial, onSubmit, submitLabel = 'Book shipment',
  extra, hideShipper, busy, mobile, showMap = true, staff = false, receiversUrl, header }) {
  const [meta, setMeta] = useState(null);
  const [v, setV, bind] = useForm(blankShipment(region, { use_boxes: staff, ...initial }));
  const [quotes, setQuotes] = useState([]);
  const [qErr, setQErr] = useState(null);
  const [err, setErr] = useState(null);
  const [pin, setPin] = useState(false);
  const [receivers, setReceivers] = useState([]);
  const intl = v.dest_country && v.dest_country !== region;
  const customsValue = intl && v.product !== 'DOCUMENT' ? itemsValue(v.items) : 0;
  const currency = meta?.currency || REGIONS[region]?.currency;
  const cities = meta?.cities || [];

  useEffect(() => {
    api.get(`/api/public/meta?entity=${region}`).then((m) => {
      setMeta(m);
      setV((s) => ({ ...s, origin_city: s.origin_city || m.cities[0] || '', dest_city: s.dest_country === region ? (s.dest_city || m.cities[0]) : s.dest_city }));
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, region]);
  useEffect(() => {
    if (!receiversUrl) return;
    api.get(receiversUrl).then(setReceivers).catch(() => setReceivers([]));
  }, [api, receiversUrl]);

  const boxTotals = useMemo(() => {
    const div = v.service === 'AIR_CARGO' ? 6000 : 5000;
    return v.boxes.reduce((a, b) => {
      const w = Number(b.actual_weight) || 0;
      const cm3 = (Number(b.length) || 0) * (Number(b.width) || 0) * (Number(b.height) || 0);
      return { weight: a.weight + w, bill: a.bill + Math.max(w, cm3 / div), cbm: a.cbm + cm3 / 1e6 };
    }, { weight: 0, bill: 0, cbm: 0 });
  }, [v.boxes, v.service]);

  const quoteBody = () => {
    const c = cleanShipment(v, region);
    return {
      entity: region, origin_city: c.origin_city || 'City', dest_city: c.dest_city || 'City', dest_country: c.dest_country,
      weight: c.weight, pieces: c.pieces, length: c.length, width: c.width, height: c.height, boxes: c.boxes,
      cod_amount: intl ? 0 : Number(v.cod_amount) || 0, product: intl ? v.product : 'PARCEL', incoterm: intl ? v.incoterm : undefined,
      customs_value: customsValue, dangerous_goods: !!v.dangerous_goods, packing_type: c.packing_type,
      handling_charge: c.handling_charge, other_charge: c.other_charge, discount: c.discount,
    };
  };
  const quoteKey = JSON.stringify(quoteBody());
  useEffect(() => {
    const t = setTimeout(async () => {
      const b = JSON.parse(quoteKey);
      if (!(b.weight > 0) && !b.boxes?.length) { setQuotes([]); return; }
      try {
        const r = await api.post(quoteUrl, b);
        setQuotes(r.quotes); setQErr(null);
        if (r.quotes.length && !r.quotes.find((q) => q.service === v.service)) setV((s) => ({ ...s, service: r.quotes[0].service }));
      } catch (e) { setQErr(e); setQuotes([]); }
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quoteKey, quoteUrl]);

  const selected = quotes.find((q) => q.service === v.service);
  const setMode = (international) => setV((s) => ({
    ...s, dest_country: international ? (s.dest_country !== region ? s.dest_country : DEFAULT_DEST[region]) : region,
    dest_city: international ? '' : (cities[0] || ''), service: international ? 'INTL_EXPRESS' : 'EXPRESS',
  }));
  const setItem = (i, k, val) => setV((s) => ({ ...s, items: s.items.map((it, j) => (j === i ? { ...it, [k]: val } : it)) }));
  const setBox = (i, k, val) => setV((s) => ({ ...s, boxes: s.boxes.map((b, j) => (j === i ? { ...b, [k]: val } : b)) }));
  const pickReceiver = (id) => {
    const r = receivers.find((x) => String(x.id) === id);
    if (!r) { setV((s) => ({ ...s, receiver_id: null })); return; }
    setV((s) => ({
      ...s, receiver_id: r.id, consignee_name: r.name, consignee_phone: r.phone, consignee_email: r.email || '', consignee_company: r.company || '',
      dest_country: r.country, dest_city: r.city, consignee_address: r.address, consignee_postcode: r.postcode || '', consignee_state: r.state || '',
      consignee_tax_id: r.tax_id || '', receiver_id_no: r.national_id || '',
    }));
  };
  const useGps = async () => {
    const p = await getPosition();
    if (p) setV((s) => ({ ...s, pickup_lat: +p.lat.toFixed(6), pickup_lng: +p.lng.toFixed(6) }));
    else setErr(new Error('Location unavailable — allow location access or drop a pin on the map'));
  };
  const submit = async (e) => {
    e.preventDefault();
    setErr(null);
    try { await onSubmit(cleanShipment(v, region), selected); } catch (x) { setErr(x); }
  };
  const cols = mobile ? 'grid' : 'grid g3';
  const regionName = REGIONS[region]?.name || region;
  const unit = selected?.unit === 'CBM' ? 'CBM' : 'kg';

  return (
    <form className="stack" onSubmit={submit}>
      {header}
      <ErrorBox error={err} />
      <div className="seg" role="tablist" aria-label="Shipment type">
        <button type="button" className={intl ? 'on' : ''} onClick={() => setMode(true)}>✈️🚢 International</button>
        <button type="button" className={!intl ? 'on' : ''} onClick={() => setMode(false)}>🚚 {regionName} domestic</button>
      </div>
      {!hideShipper && (
        <fieldset className="card flat stack">
          <h3>Sender (collection in {regionName})</h3>
          <div className={cols}>
            <Field label="Name / company"><input {...bind('shipper_name')} required /></Field>
            <Field label="Mobile"><input {...bind('shipper_phone')} type="tel" required placeholder={meta?.entities?.find((x) => x.code === region)?.phone_prefix} /></Field>
            <Field label="City"><select {...bind('origin_city')}>{cities.map((c) => <option key={c}>{c}</option>)}</select></Field>
            <Field label="Address" span={mobile ? 1 : 2}><input {...bind('shipper_address')} required /></Field>
            <Field label="Collection window"><input {...bind('pickup_window')} placeholder="e.g. 10:00–13:00" /></Field>
          </div>
          {staff && (
            <div className={mobile ? 'grid g2' : 'grid g3'}>
              <Field label="Sender ID type"><select {...bind('sender_id_type')}><option value="">—</option>{ID_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
              <Field label="ID number"><input {...bind('sender_id_no')} /></Field>
              <Field label="ID expiry"><input type="date" {...bind('sender_id_expiry')} /></Field>
            </div>
          )}
          {showMap && (
            <div className="stack" style={{ gap: 6 }}>
              <div className="row">
                <button type="button" className="btn sm" onClick={useGps}>📍 Use my GPS location</button>
                <button type="button" className="btn sm" onClick={() => setPin((x) => !x)}>{pin ? 'Hide map' : '🗺️ Pin on map'}</button>
                <span className="small muted">{v.pickup_lat ? `Pinned ${v.pickup_lat.toFixed(5)}, ${v.pickup_lng.toFixed(5)}` : 'No pin — city centre used for collection routing'}</span>
              </div>
              {pin && (
                <Suspense fallback={<div className="map" style={{ height: 260 }} />}>
                  <MapView height={260} fitKey="pin" markers={v.pickup_lat ? [{ lat: v.pickup_lat, lng: v.pickup_lng, kind: 'pickup', label: 'P' }] : []}
                    pick={(lat, lng) => setV((s) => ({ ...s, pickup_lat: +lat.toFixed(6), pickup_lng: +lng.toFixed(6) }))} />
                </Suspense>
              )}
            </div>
          )}
        </fieldset>
      )}
      <fieldset className="card flat stack">
        <div className="row between"><h3 style={{ margin: 0 }}>Receiver</h3>
          {receivers.length > 0 && (
            <select value={v.receiver_id || ''} onChange={(e) => pickReceiver(e.target.value)} style={{ width: mobile ? '100%' : 320 }} aria-label="Saved receivers">
              <option value="">📒 Choose saved receiver…</option>
              {receivers.map((r) => <option key={r.id} value={r.id}>{r.name} · {r.city}, {r.country}</option>)}
            </select>
          )}</div>
        <div className={cols}>
          <Field label="Name"><input {...bind('consignee_name')} required /></Field>
          <Field label="Mobile (with country code)"><input {...bind('consignee_phone')} type="tel" required /></Field>
          {intl
            ? <Field label="Country"><select {...bind('dest_country')}>{(meta?.country_list || []).map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></Field>
            : <Field label="City"><select {...bind('dest_city')}>{cities.map((c) => <option key={c}>{c}</option>)}</select></Field>}
          {intl && <Field label="City"><input {...bind('dest_city')} required /></Field>}
          <Field label="Address" span={mobile || !intl ? 1 : 2}><input {...bind('consignee_address')} required /></Field>
          <Field label="Postcode / PIN / ZIP"><input {...bind('consignee_postcode')} /></Field>
          {intl && <Field label="State / region"><input {...bind('consignee_state')} /></Field>}
          {intl && <Field label="Email"><input {...bind('consignee_email')} type="email" /></Field>}
          {intl && <Field label="Tax ID / VAT / GST no." hint="Needed for IN, BR, CN imports"><input {...bind('consignee_tax_id')} /></Field>}
          {staff && <Field label="Receiver national ID"><input {...bind('receiver_id_no')} /></Field>}
          {staff && <Field label="Company"><input {...bind('consignee_company')} /></Field>}
        </div>
        {receiversUrl && <label className="row small"><input type="checkbox" checked={!!v.save_receiver} onChange={(e) => setV({ ...v, save_receiver: e.target.checked })} /> Save to receiver address book</label>}
      </fieldset>
      <fieldset className="card flat stack">
        <div className="row between"><h3 style={{ margin: 0 }}>{intl ? 'Cargo & customs' : 'Parcel'}</h3>
          <label className="row small"><input type="checkbox" checked={v.use_boxes} onChange={(e) => setV({ ...v, use_boxes: e.target.checked })} /> Multiple boxes (box details)</label></div>
        {intl && (
          <div className={mobile ? 'grid g2' : 'grid g4'}>
            <Field label="Contents type"><select {...bind('product')}><option value="PARCEL">Parcel / personal effects</option><option value="DOCUMENT">Documents</option><option value="CARGO">Commercial cargo</option></select></Field>
            <Field label="Duties & taxes" hint="DDP: sender pays · DAP: receiver pays"><select {...bind('incoterm')}><option value="DAP">DAP — receiver pays duties</option><option value="DDP">DDP — sender pays duties</option></select></Field>
            {v.product !== 'DOCUMENT' && <Field label="Export reason"><select {...bind('export_reason')}>{['SALE', 'GIFT', 'PERSONAL', 'SAMPLE', 'RETURN', 'REPAIR'].map((x) => <option key={x}>{x}</option>)}</select></Field>}
            <label className="row small" style={{ alignSelf: 'end' }}><input type="checkbox" checked={!!v.dangerous_goods} onChange={(e) => setV({ ...v, dangerous_goods: e.target.checked })} /> Dangerous goods (batteries, perfume, liquids)</label>
          </div>
        )}
        {v.use_boxes ? (
          <div className="stack" style={{ gap: 6 }}>
            {v.boxes.map((b, i) => (
              <div key={i} className={mobile ? 'grid g2' : 'grid'} style={mobile ? undefined : { gridTemplateColumns: '40px 1fr 70px 70px 70px 1.4fr 1fr 36px', alignItems: 'end' }}>
                {!mobile && <b className="small" style={{ alignSelf: 'center' }}>#{i + 1}</b>}
                <Field label={i === 0 || mobile ? 'Actual kg' : ''}><input type="number" step="any" min="0.1" value={b.actual_weight} onChange={(e) => setBox(i, 'actual_weight', e.target.value)} required /></Field>
                <Field label={i === 0 || mobile ? 'L cm' : ''}><input type="number" value={b.length} onChange={(e) => setBox(i, 'length', e.target.value)} /></Field>
                <Field label={i === 0 || mobile ? 'W cm' : ''}><input type="number" value={b.width} onChange={(e) => setBox(i, 'width', e.target.value)} /></Field>
                <Field label={i === 0 || mobile ? 'H cm' : ''}><input type="number" value={b.height} onChange={(e) => setBox(i, 'height', e.target.value)} /></Field>
                <Field label={i === 0 || mobile ? 'Packing' : ''}><select value={b.packing_type} onChange={(e) => setBox(i, 'packing_type', e.target.value)}>
                  {(meta?.packing_types || []).map((p) => <option key={p.code} value={p.code}>{p.name}{p.amount ? ` (${money(p.amount, currency)})` : ''}</option>)}</select></Field>
                <Field label={i === 0 || mobile ? 'Category' : ''}><input value={b.category} onChange={(e) => setBox(i, 'category', e.target.value)} placeholder="Household, food…" /></Field>
                <button type="button" className="btn sm ghost" aria-label={`Remove box ${i + 1}`} disabled={v.boxes.length === 1} onClick={() => setV((s) => ({ ...s, boxes: s.boxes.filter((_, j) => j !== i) }))}>✕</button>
              </div>
            ))}
            <div className="row between"><button type="button" className="btn sm" onClick={() => setV((s) => ({ ...s, boxes: [...s.boxes, blankBox()] }))}>+ Add box</button>
              <span className="small">{v.boxes.length} boxes · {boxTotals.weight.toFixed(1)} kg actual · ~{boxTotals.bill.toFixed(1)} kg bill · {boxTotals.cbm.toFixed(3)} CBM</span></div>
          </div>
        ) : (
          <div className={mobile ? 'grid g2' : 'grid g4'}>
            <Field label="Pieces"><input {...bind('pieces', 'number')} min="1" required /></Field>
            <Field label="Total weight (kg)"><input {...bind('weight', 'number')} min="0.1" required /></Field>
            <Field label="L × W × H per piece (cm)">
              <div className="row nowrap" style={{ gap: 4 }}><input {...bind('length', 'number')} placeholder="L" /><input {...bind('width', 'number')} placeholder="W" /><input {...bind('height', 'number')} placeholder="H" /></div>
            </Field>
            <Field label="Packing"><select {...bind('packing_type')}>{(meta?.packing_types || []).map((p) => <option key={p.code} value={p.code}>{p.name}{p.amount ? ` (${money(p.amount, currency)})` : ''}</option>)}</select></Field>
          </div>
        )}
        <div className={mobile ? 'grid g2' : 'grid g4'}>
          {!intl && <Field label={`COD amount (${currency})`} hint="Cash to collect from receiver"><input {...bind('cod_amount', 'number')} min="0" /></Field>}
          {!intl && <Field label="Contents"><input {...bind('description')} /></Field>}
          <Field label="Your reference"><input {...bind('reference')} /></Field>
          {staff && <Field label={`Handling charge (${currency})`}><input {...bind('handling_charge', 'number')} min="0" /></Field>}
          {staff && <Field label={`Other charge (${currency})`}><input {...bind('other_charge', 'number')} min="0" /></Field>}
          {staff && <Field label={`Discount (${currency})`}><input {...bind('discount', 'number')} min="0" /></Field>}
        </div>
        {intl && v.product !== 'DOCUMENT' && (
          <div className="stack" style={{ gap: 6 }}>
            <div className="row between"><b className="small">Item details / commercial invoice</b><span className="small">Customs value <b>{money(customsValue, currency)}</b></span></div>
            {v.items.map((it, i) => (
              <div key={i} className={mobile ? 'grid g2' : 'grid'} style={mobile ? undefined : { gridTemplateColumns: `${v.use_boxes ? '70px ' : ''}2fr 1fr 70px 110px 70px 36px`, alignItems: 'end' }}>
                {v.use_boxes && <Field label={i === 0 || mobile ? 'Box' : ''}><select value={it.box_seq} onChange={(e) => setItem(i, 'box_seq', e.target.value)}><option value="">—</option>{v.boxes.map((_, j) => <option key={j} value={j + 1}>#{j + 1}</option>)}</select></Field>}
                <Field label={i === 0 || mobile ? 'Description' : ''}><input value={it.description} onChange={(e) => setItem(i, 'description', e.target.value)} placeholder="e.g. Cotton shirts" required /></Field>
                <Field label={i === 0 || mobile ? 'HS code' : ''}><input value={it.hs_code} onChange={(e) => setItem(i, 'hs_code', e.target.value)} placeholder="6–10 digits" inputMode="numeric" /></Field>
                <Field label={i === 0 || mobile ? 'Qty' : ''}><input type="number" value={it.qty} min="1" onChange={(e) => setItem(i, 'qty', e.target.value)} /></Field>
                <Field label={i === 0 || mobile ? `Unit value (${currency})` : ''}><input type="number" step="any" value={it.unit_value} min="0" onChange={(e) => setItem(i, 'unit_value', e.target.value)} /></Field>
                <Field label={i === 0 || mobile ? 'Origin' : ''}><input value={it.origin_country} maxLength={2} placeholder={region} onChange={(e) => setItem(i, 'origin_country', e.target.value.toUpperCase())} /></Field>
                <button type="button" className="btn sm ghost" aria-label="Remove line" disabled={v.items.length === 1} onClick={() => setV((s) => ({ ...s, items: s.items.filter((_, j) => j !== i) }))}>✕</button>
              </div>
            ))}
            <div className="row"><button type="button" className="btn sm" onClick={() => setV((s) => ({ ...s, items: [...s.items, blankItem()] }))}>+ Add item</button>
              <span className="tiny muted">HS codes speed up customs. Missing codes keep the shipment on “docs pending”.</span></div>
          </div>
        )}
      </fieldset>
      <div className="card flat stack">
        <h3>Service & price ({currency})</h3>
        <ErrorBox error={qErr} />
        <div className={mobile ? 'stack' : 'grid g3'}>
          {quotes.map((q) => (
            <label key={q.service} className="card flat row nowrap" style={{ cursor: 'pointer', borderColor: v.service === q.service ? 'var(--brand)' : undefined, borderWidth: v.service === q.service ? 2 : 1 }}>
              <input type="radio" name="service" checked={v.service === q.service} onChange={() => setV((s) => ({ ...s, service: q.service }))} />
              <div className="spacer"><b>{q.mode === 'SEA' ? '🚢' : q.mode === 'AIR' ? '✈️' : '🚚'} {SERVICES[q.service] || q.service}</b>
                <div className="tiny muted">{q.transit} · {q.unit === 'CBM' ? `${q.chargeable_units} CBM` : `${q.chargeable_weight} kg`} chargeable{q.zone_name ? ` · ${q.zone_name}` : ''}</div></div>
              <b>{money(q.total_charge, q.currency)}</b>
            </label>
          ))}
        </div>
        {selected && (
          <div className="small muted">
            Freight {money(selected.freight, currency)}{selected.fuel_surcharge ? ` + fuel ${money(selected.fuel_surcharge, currency)}` : ''}
            {selected.packing_charge ? ` + packing ${money(selected.packing_charge, currency)}` : ''}{selected.awb_charge ? ` + AWB/doc ${money(selected.awb_charge, currency)}` : ''}
            {selected.handling_charge ? ` + handling ${money(selected.handling_charge, currency)}` : ''}{selected.other_charge ? ` + other ${money(selected.other_charge, currency)}` : ''}
            {selected.cod_fee ? ` + COD fee ${money(selected.cod_fee, currency)}` : ''}{selected.dg_surcharge ? ` + DG ${money(selected.dg_surcharge, currency)}` : ''}
            {selected.discount ? ` − discount ${money(selected.discount, currency)}` : ''}{selected.duties_estimate ? ` + DDP duties ${money(selected.duties_estimate, currency)}` : ''}
            {' '}+ {selected.vat_rate === 0 ? 'VAT 0% (export zero-rated)' : `VAT/GST ${selected.vat_rate}% ${money(selected.vat, currency)}`} = <b>{money(selected.total_charge, currency)}</b>
            {intl && v.incoterm === 'DAP' && selected.duties_guide?.applies && <div className="alert info small" style={{ marginTop: 6 }}>Receiver pays est. import duty {money(selected.duties_guide.duty, currency)} + import tax {money(selected.duties_guide.import_vat, currency)} on arrival.</div>}
          </div>
        )}
      </div>
      {extra?.(v, selected)}
      <button className="btn primary lg" disabled={busy || !selected}>{busy ? 'Saving…' : submitLabel}{selected ? ` · ${money(selected.total_charge, currency)}` : ''}</button>
      <span className="tiny muted">{unit === 'CBM' ? 'Sea cargo is billed per CBM (minimum 1 CBM, 1 CBM = 1,000 kg).' : ''}</span>
    </form>
  );
}
