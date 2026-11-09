// Booking form shared by ERP, Driver (on-spot) and Customer apps. Live quote + GPS/map pin for the pickup point.
import { useEffect, useState, lazy, Suspense } from 'react';
import { Field, useForm, ErrorBox } from './ui.jsx';
import { aed, UAE_CITIES, SERVICES } from './format.js';
import { getPosition } from './devices.jsx';

const MapView = lazy(() => import('./MapView.jsx'));

export const blankShipment = (over = {}) => ({
  service: 'EXPRESS', origin_city: 'Dubai', dest_city: 'Dubai', dest_country: 'AE', pieces: 1, weight: 1,
  length: '', width: '', height: '', cod_amount: 0, declared_value: 0, description: '', reference: '',
  shipper_name: '', shipper_phone: '', shipper_address: '', consignee_name: '', consignee_phone: '', consignee_address: '',
  pickup_lat: null, pickup_lng: null, pickup_window: '', ...over,
});

export function cleanShipment(v) {
  const out = { ...v };
  for (const k of ['length', 'width', 'height', 'reference', 'description', 'pickup_window']) if (out[k] === '' || out[k] == null) delete out[k];
  if (out.pickup_lat == null) { delete out.pickup_lat; delete out.pickup_lng; }
  return out;
}

export default function ShipmentForm({ api, quoteUrl = '/api/public/quote', initial, onSubmit, submitLabel = 'Book shipment', extra, hideShipper, busy, mobile, showMap = true }) {
  const [v, setV, bind] = useForm(blankShipment(initial));
  const [quotes, setQuotes] = useState([]);
  const [qErr, setQErr] = useState(null);
  const [err, setErr] = useState(null);
  const [pin, setPin] = useState(false);
  const [countries, setCountries] = useState({ AE: 'United Arab Emirates' });

  useEffect(() => { api.get('/api/public/meta').then((m) => setCountries(m.countries)).catch(() => {}); }, [api]);
  useEffect(() => {
    const t = setTimeout(async () => {
      if (!(v.weight > 0)) return;
      try {
        const r = await api.post(quoteUrl, {
          origin_city: v.origin_city, dest_city: v.dest_city, dest_country: v.dest_country, weight: v.weight, pieces: v.pieces || 1,
          length: v.length || undefined, width: v.width || undefined, height: v.height || undefined, cod_amount: v.cod_amount || 0,
        });
        setQuotes(r.quotes); setQErr(null);
        if (r.quotes.length && !r.quotes.find((q) => q.service === v.service)) setV((s) => ({ ...s, service: r.quotes[0].service }));
      } catch (e) { setQErr(e); setQuotes([]); }
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.origin_city, v.dest_city, v.dest_country, v.weight, v.length, v.width, v.height, v.cod_amount, v.pieces]);

  const selected = quotes.find((q) => q.service === v.service);
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
      {!hideShipper && (
        <fieldset className="card flat stack">
          <h3>Pickup from (shipper)</h3>
          <div className={cols}>
            <Field label="Name"><input {...bind('shipper_name')} required /></Field>
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
                <span className="small muted">{v.pickup_lat ? `Pinned ${v.pickup_lat.toFixed(5)}, ${v.pickup_lng.toFixed(5)}` : 'No pin — city centre will be used for routing'}</span>
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
          <Field label="Phone"><input {...bind('consignee_phone')} type="tel" required /></Field>
          <Field label="Country"><select {...bind('dest_country')}>{Object.entries(countries).map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></Field>
          <Field label="City">{v.dest_country === 'AE'
            ? <select {...bind('dest_city')}>{UAE_CITIES.map((c) => <option key={c}>{c}</option>)}</select>
            : <input {...bind('dest_city')} required />}</Field>
          <Field label="Address" span={mobile ? 1 : 2}><input {...bind('consignee_address')} required /></Field>
        </div>
      </fieldset>
      <fieldset className="card flat stack">
        <h3>Parcel</h3>
        <div className={mobile ? 'grid g2' : 'grid g4'}>
          <Field label="Pieces"><input {...bind('pieces', 'number')} min="1" required /></Field>
          <Field label="Weight (kg)"><input {...bind('weight', 'number')} min="0.1" required /></Field>
          <Field label="L × W × H (cm)">
            <div className="row nowrap" style={{ gap: 4 }}><input {...bind('length', 'number')} placeholder="L" /><input {...bind('width', 'number')} placeholder="W" /><input {...bind('height', 'number')} placeholder="H" /></div>
          </Field>
          <Field label="COD amount (AED)" hint="Cash to collect from consignee"><input {...bind('cod_amount', 'number')} min="0" /></Field>
          <Field label="Contents"><input {...bind('description')} /></Field>
          <Field label="Declared value (AED)"><input {...bind('declared_value', 'number')} min="0" /></Field>
          <Field label="Your reference"><input {...bind('reference')} /></Field>
        </div>
      </fieldset>
      <div className="card flat stack">
        <h3>Service & price</h3>
        <ErrorBox error={qErr} />
        <div className={mobile ? 'stack' : 'grid g3'}>
          {quotes.map((q) => (
            <label key={q.service} className="card flat row nowrap" style={{ cursor: 'pointer', borderColor: v.service === q.service ? 'var(--brand)' : undefined, borderWidth: v.service === q.service ? 2 : 1 }}>
              <input type="radio" name="service" checked={v.service === q.service} onChange={() => setV((s) => ({ ...s, service: q.service }))} />
              <div className="spacer"><b>{SERVICES[q.service]}</b><div className="tiny muted">{q.transit} · {q.chargeable_weight} kg chargeable</div></div>
              <b>{aed(q.total_charge)}</b>
            </label>
          ))}
        </div>
        {selected && (
          <div className="small muted">
            Freight {aed(selected.freight)} + fuel {aed(selected.fuel_surcharge)}{selected.cod_fee ? ` + COD fee ${aed(selected.cod_fee)}` : ''} + VAT {selected.vat_rate}% {aed(selected.vat)} = <b>{aed(selected.total_charge)}</b>
          </div>
        )}
      </div>
      {extra?.(v, selected)}
      <button className="btn primary lg" disabled={busy || !selected}>{busy ? 'Saving…' : submitLabel}{selected ? ` · ${aed(selected.total_charge)}` : ''}</button>
    </form>
  );
}
