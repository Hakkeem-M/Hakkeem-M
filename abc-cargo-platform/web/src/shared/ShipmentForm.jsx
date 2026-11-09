// Booking form shared by ERP, Driver (on-spot) and Customer apps.
// International air courier / air cargo first (commercial invoice, HS codes, DDP/DAP), UAE domestic second.
import { useEffect, useState, lazy, Suspense } from 'react';
import { Field, useForm, ErrorBox } from './ui.jsx';
import { aed, UAE_CITIES, SERVICES } from './format.js';
import { getPosition } from './devices.jsx';

const MapView = lazy(() => import('./MapView.jsx'));

export const blankItem = () => ({ description: '', hs_code: '', qty: 1, unit_value: 0, origin_country: 'AE' });
export const blankShipment = (over = {}) => ({
  service: 'INTL_EXPRESS', origin_city: 'Dubai', dest_city: '', dest_country: 'IN', pieces: 1, weight: 1,
  length: '', width: '', height: '', cod_amount: 0, declared_value: 0, description: '', reference: '',
  shipper_name: '', shipper_phone: '', shipper_address: '', consignee_name: '', consignee_phone: '', consignee_address: '',
  consignee_postcode: '', consignee_tax_id: '', consignee_email: '',
  product: 'PARCEL', incoterm: 'DAP', export_reason: 'SALE', dangerous_goods: false, items: [blankItem()],
  pickup_lat: null, pickup_lng: null, pickup_window: '', ...over,
});

const isIntlV = (v) => v.dest_country && v.dest_country !== 'AE';
const itemsValue = (items) => items.reduce((a, i) => a + (Number(i.qty) || 0) * (Number(i.unit_value) || 0), 0);

export function cleanShipment(v) {
  const out = { ...v };
  const intl = isIntlV(v);
  for (const k of ['length', 'width', 'height', 'reference', 'description', 'pickup_window', 'consignee_postcode', 'consignee_tax_id', 'consignee_email']) {
    if (out[k] === '' || out[k] == null) delete out[k];
  }
  if (out.pickup_lat == null) { delete out.pickup_lat; delete out.pickup_lng; }
  if (intl) {
    out.cod_amount = 0;
    out.items = out.product === 'DOCUMENT' ? [] : out.items.filter((i) => i.description).map((i) => ({ ...i, hs_code: i.hs_code || undefined, qty: Number(i.qty), unit_value: Number(i.unit_value) }));
    if (!out.description && out.items[0]) out.description = out.items.map((i) => i.description).join(', ').slice(0, 300);
  } else {
    for (const k of ['items', 'incoterm', 'export_reason', 'consignee_tax_id']) delete out[k];
    out.product = 'PARCEL';
  }
  return out;
}

export default function ShipmentForm({ api, quoteUrl = '/api/public/quote', initial, onSubmit, submitLabel = 'Book shipment', extra, hideShipper, busy, mobile, showMap = true }) {
  const [v, setV, bind] = useForm(blankShipment(initial));
  const [quotes, setQuotes] = useState([]);
  const [qErr, setQErr] = useState(null);
  const [err, setErr] = useState(null);
  const [pin, setPin] = useState(false);
  const [countries, setCountries] = useState([]);
  const intl = isIntlV(v);
  const customsValue = intl && v.product !== 'DOCUMENT' ? itemsValue(v.items) : 0;

  useEffect(() => { api.get('/api/public/meta').then((m) => setCountries(m.country_list || [])).catch(() => {}); }, [api]);
  useEffect(() => {
    const t = setTimeout(async () => {
      if (!(v.weight > 0) || (!intl && !v.dest_city)) return;
      try {
        const r = await api.post(quoteUrl, {
          origin_city: v.origin_city, dest_city: v.dest_city || 'City', dest_country: v.dest_country, weight: v.weight, pieces: v.pieces || 1,
          length: v.length || undefined, width: v.width || undefined, height: v.height || undefined, cod_amount: intl ? 0 : (v.cod_amount || 0),
          product: intl ? v.product : 'PARCEL', incoterm: intl ? v.incoterm : undefined, customs_value: customsValue, dangerous_goods: !!v.dangerous_goods,
        });
        setQuotes(r.quotes); setQErr(null);
        if (r.quotes.length && !r.quotes.find((q) => q.service === v.service)) setV((s) => ({ ...s, service: r.quotes[0].service }));
      } catch (e) { setQErr(e); setQuotes([]); }
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.origin_city, v.dest_city, v.dest_country, v.weight, v.length, v.width, v.height, v.cod_amount, v.pieces, v.product, v.incoterm, customsValue, v.dangerous_goods]);

  const selected = quotes.find((q) => q.service === v.service);
  const setMode = (international) => setV((s) => ({ ...s, dest_country: international ? (s.dest_country !== 'AE' ? s.dest_country : 'IN') : 'AE', dest_city: international ? '' : 'Dubai', service: international ? 'INTL_EXPRESS' : 'EXPRESS' }));
  const setItem = (i, k, val) => setV((s) => ({ ...s, items: s.items.map((it, j) => (j === i ? { ...it, [k]: val } : it)) }));
  const useGps = async () => {
    const p = await getPosition();
    if (p) setV((s) => ({ ...s, pickup_lat: +p.lat.toFixed(6), pickup_lng: +p.lng.toFixed(6) }));
    else setErr(new Error('Location unavailable — allow location access or drop a pin on the map'));
  };
  const submit = async (e) => {
    e.preventDefault();
    setErr(null);
    try { await onSubmit(cleanShipment(v), selected); } catch (x) { setErr(x); }
  };
  const cols = mobile ? 'grid' : 'grid g3';

  return (
    <form className="stack" onSubmit={submit}>
      <ErrorBox error={err} />
      <div className="seg" role="tablist" aria-label="Shipment type">
        <button type="button" className={intl ? 'on' : ''} onClick={() => setMode(true)}>✈️ International (air)</button>
        <button type="button" className={!intl ? 'on' : ''} onClick={() => setMode(false)}>🚚 UAE domestic</button>
      </div>
      {!hideShipper && (
        <fieldset className="card flat stack">
          <h3>Pickup from (shipper, UAE)</h3>
          <div className={cols}>
            <Field label="Name / company"><input {...bind('shipper_name')} required /></Field>
            <Field label="Phone"><input {...bind('shipper_phone')} type="tel" required /></Field>
            <Field label="City"><select {...bind('origin_city')}>{UAE_CITIES.map((c) => <option key={c}>{c}</option>)}</select></Field>
            <Field label="Address" span={mobile ? 1 : 2}><input {...bind('shipper_address')} required /></Field>
            <Field label="Pickup window"><input {...bind('pickup_window')} placeholder="e.g. 10:00–13:00" /></Field>
          </div>
          {showMap && (
            <div className="stack" style={{ gap: 6 }}>
              <div className="row">
                <button type="button" className="btn sm" onClick={useGps}>📍 Use my GPS location</button>
                <button type="button" className="btn sm" onClick={() => setPin((x) => !x)}>{pin ? 'Hide map' : '🗺️ Pin on map'}</button>
                <span className="small muted">{v.pickup_lat ? `Pinned ${v.pickup_lat.toFixed(5)}, ${v.pickup_lng.toFixed(5)}` : 'No pin — city centre used for pickup routing'}</span>
              </div>
              {pin && (
                <Suspense fallback={<div className="map" style={{ height: 260 }} />}>
                  <MapView height={260} fitKey="pin" markers={v.pickup_lat ? [{ lat: v.pickup_lat, lng: v.pickup_lng, kind: 'pickup', label: 'P' }] : []}
                    pick={(lat, lng) => setV((s) => ({ ...s, pickup_lat: +lat.toFixed(6), pickup_lng: +lng.toFixed(6) }))} />
                  <span className="tiny muted">Tap the map to set the exact pickup point.</span>
                </Suspense>
              )}
            </div>
          )}
        </fieldset>
      )}
      <fieldset className="card flat stack">
        <h3>Deliver to (consignee)</h3>
        <div className={cols}>
          <Field label="Name"><input {...bind('consignee_name')} required /></Field>
          <Field label="Phone (with country code)"><input {...bind('consignee_phone')} type="tel" required /></Field>
          {intl
            ? <Field label="Country"><select {...bind('dest_country')}>{countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></Field>
            : <Field label="Emirate / city"><select {...bind('dest_city')}>{UAE_CITIES.map((c) => <option key={c}>{c}</option>)}</select></Field>}
          {intl && <Field label="City"><input {...bind('dest_city')} required /></Field>}
          <Field label="Address" span={mobile || !intl ? 1 : 2}><input {...bind('consignee_address')} required /></Field>
          {intl && <Field label="Postcode / ZIP"><input {...bind('consignee_postcode')} /></Field>}
          {intl && <Field label="Consignee email" hint="For customs & delivery notices"><input {...bind('consignee_email')} type="email" /></Field>}
          {intl && <Field label="Consignee tax / ID no." hint="Required by IN, BR, CN, etc."><input {...bind('consignee_tax_id')} /></Field>}
        </div>
      </fieldset>
      <fieldset className="card flat stack">
        <h3>{intl ? 'Shipment & customs' : 'Parcel'}</h3>
        {intl && (
          <div className={mobile ? 'grid g2' : 'grid g4'}>
            <Field label="Contents type"><select {...bind('product')}><option value="PARCEL">Parcel (goods)</option><option value="DOCUMENT">Documents</option><option value="CARGO">Air cargo (heavy / palletised)</option></select></Field>
            <Field label="Duties & taxes" hint="DDP: shipper pays · DAP: receiver pays"><select {...bind('incoterm')}><option value="DAP">DAP — receiver pays duties</option><option value="DDP">DDP — I pay duties</option></select></Field>
            {v.product !== 'DOCUMENT' && <Field label="Export reason"><select {...bind('export_reason')}>{['SALE', 'GIFT', 'SAMPLE', 'RETURN', 'PERSONAL', 'REPAIR'].map((x) => <option key={x}>{x}</option>)}</select></Field>}
            <label className="row small" style={{ alignSelf: 'end' }}><input type="checkbox" checked={!!v.dangerous_goods} onChange={(e) => setV({ ...v, dangerous_goods: e.target.checked })} /> Contains dangerous goods (batteries, perfume, liquids)</label>
          </div>
        )}
        <div className={mobile ? 'grid g2' : 'grid g4'}>
          <Field label="Pieces"><input {...bind('pieces', 'number')} min="1" required /></Field>
          <Field label="Total weight (kg)"><input {...bind('weight', 'number')} min="0.1" required /></Field>
          <Field label="L × W × H per piece (cm)" hint={intl ? 'Volumetric weight applies' : undefined}>
            <div className="row nowrap" style={{ gap: 4 }}><input {...bind('length', 'number')} placeholder="L" /><input {...bind('width', 'number')} placeholder="W" /><input {...bind('height', 'number')} placeholder="H" /></div>
          </Field>
          {!intl && <Field label="COD amount (AED)" hint="Cash to collect from consignee"><input {...bind('cod_amount', 'number')} min="0" /></Field>}
          {!intl && <Field label="Contents"><input {...bind('description')} /></Field>}
          <Field label="Your reference"><input {...bind('reference')} /></Field>
        </div>
        {intl && v.product !== 'DOCUMENT' && (
          <div className="stack" style={{ gap: 6 }}>
            <div className="row between"><b className="small">Commercial invoice (itemised contents)</b><span className="small">Customs value <b>{aed(customsValue)}</b></span></div>
            {v.items.map((it, i) => (
              <div key={i} className={mobile ? 'grid g2' : 'grid'} style={mobile ? undefined : { gridTemplateColumns: '2fr 1fr 70px 110px 80px 36px', alignItems: 'end' }}>
                <Field label={i === 0 ? 'Description' : ''}><input value={it.description} onChange={(e) => setItem(i, 'description', e.target.value)} placeholder="e.g. Cotton T-shirts" required /></Field>
                <Field label={i === 0 ? 'HS code' : ''}><input value={it.hs_code} onChange={(e) => setItem(i, 'hs_code', e.target.value)} placeholder="6–10 digits" inputMode="numeric" /></Field>
                <Field label={i === 0 ? 'Qty' : ''}><input type="number" value={it.qty} min="1" onChange={(e) => setItem(i, 'qty', e.target.value)} /></Field>
                <Field label={i === 0 ? 'Unit value (AED)' : ''}><input type="number" step="any" value={it.unit_value} min="0" onChange={(e) => setItem(i, 'unit_value', e.target.value)} /></Field>
                <Field label={i === 0 ? 'Origin' : ''}><input value={it.origin_country} maxLength={2} onChange={(e) => setItem(i, 'origin_country', e.target.value.toUpperCase())} /></Field>
                <button type="button" className="btn sm ghost" aria-label="Remove line" disabled={v.items.length === 1} onClick={() => setV((s) => ({ ...s, items: s.items.filter((_, j) => j !== i) }))}>✕</button>
              </div>
            ))}
            <div className="row"><button type="button" className="btn sm" onClick={() => setV((s) => ({ ...s, items: [...s.items, blankItem()] }))}>+ Add line</button>
              <span className="tiny muted">HS codes speed up customs. Missing codes put the shipment on “docs pending” until completed.</span></div>
          </div>
        )}
      </fieldset>
      <div className="card flat stack">
        <h3>Service & price</h3>
        <ErrorBox error={qErr} />
        <div className={mobile ? 'stack' : 'grid g3'}>
          {quotes.map((q) => (
            <label key={q.service} className="card flat row nowrap" style={{ cursor: 'pointer', borderColor: v.service === q.service ? 'var(--brand)' : undefined, borderWidth: v.service === q.service ? 2 : 1 }}>
              <input type="radio" name="service" checked={v.service === q.service} onChange={() => setV((s) => ({ ...s, service: q.service }))} />
              <div className="spacer"><b>{SERVICES[q.service]}</b><div className="tiny muted">{q.transit} · {q.chargeable_weight} kg chargeable{q.zone_name ? ` · ${q.zone_name}` : ''}</div></div>
              <b>{aed(q.total_charge)}</b>
            </label>
          ))}
        </div>
        {selected && (
          <div className="small muted">
            Freight {aed(selected.freight)} + fuel {aed(selected.fuel_surcharge)}{selected.cod_fee ? ` + COD fee ${aed(selected.cod_fee)}` : ''}
            {selected.dg_surcharge ? ` + DG ${aed(selected.dg_surcharge)}` : ''}{selected.duties_estimate ? ` + DDP duties & taxes ${aed(selected.duties_estimate)}` : ''}
            {' '}+ VAT {selected.vat_rate}%{selected.vat_rate === 0 ? ' (export zero-rated)' : ` ${aed(selected.vat)}`} = <b>{aed(selected.total_charge)}</b>
            {intl && v.incoterm === 'DAP' && selected.duties_guide?.applies && <div className="alert info small" style={{ marginTop: 6 }}>Receiver will pay est. import duty {aed(selected.duties_guide.duty)} + import tax {aed(selected.duties_guide.import_vat)} on arrival.</div>}
          </div>
        )}
      </div>
      {extra?.(v, selected)}
      <button className="btn primary lg" disabled={busy || !selected}>{busy ? 'Saving…' : submitLabel}{selected ? ` · ${aed(selected.total_charge)}` : ''}</button>
    </form>
  );
}
