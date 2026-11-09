// Dispatch & Routing: live GPS fleet map, AUTO route planner (preview → commit) and MANUAL route builder.
import { useMemo, useState, lazy, Suspense } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../ctx.js';
import { useLoad, useAction, Spinner, ErrorBox, Badge, Field, Empty } from '../../shared/ui.jsx';
import { ago, UAE_CITIES, dt } from '../../shared/format.js';
import { ROUTE_COLORS, esc } from '../../shared/MapView.jsx';

const MapView = lazy(() => import('../../shared/MapView.jsx'));

export default function Dispatch() {
  const live = useLoad(() => api.get('/api/routing/live'), [], { interval: 20000 });
  const routes = useLoad(() => api.get('/api/routing/routes'), []);
  const [tab, setTab] = useState('auto');
  const [plan, setPlan] = useState(null);
  const [opts, setOpts] = useState({ kind: 'PICKUP', city: '', driver_ids: [], include_assigned: false, max_route_km: 250 });
  const [manual, setManual] = useState({ driver_id: '', ids: [] });
  const [run, busy] = useAction();

  const drivers = live.data?.drivers || [];
  const stops = live.data?.stops || [];
  const colorOf = useMemo(() => Object.fromEntries(drivers.map((d, i) => [d.id, ROUTE_COLORS[i % ROUTE_COLORS.length]])), [drivers]);
  const reloadAll = () => { live.reload(true); routes.reload(true); };

  const doPlan = (commit) => run(async () => {
    const body = { ...opts, commit, city: opts.city || undefined, driver_ids: opts.driver_ids.length ? opts.driver_ids : undefined };
    const r = await api.post('/api/routing/auto-plan', body);
    setPlan(r);
    if (commit) reloadAll();
    return r;
  }, commit ? 'Routes committed — drivers notified on their run sheet' : null);

  const doManual = (optimise) => run(async () => {
    const r = await api.post('/api/routing/manual', { driver_id: Number(manual.driver_id), kind: opts.kind, shipment_ids: manual.ids, optimise });
    setManual({ driver_id: manual.driver_id, ids: [] });
    reloadAll();
    return r;
  }, optimise ? 'Route optimised & assigned' : 'Route assigned in your order');

  const unassign = (id) => run(() => api.post('/api/routing/unassign', { shipment_ids: [id] }), 'Stop returned to pool').then(reloadAll);

  // ----- map layers -----
  const markers = [];
  const lines = [];
  for (const d of drivers) {
    if (d.lat) markers.push({ kind: 'driver', lat: d.lat, lng: d.lng, color: colorOf[d.id], dim: !d.online, title: d.name,
      popup: `<b>${esc(d.name)}</b><br>${esc(d.vehicle_no || '')}<br>${d.online ? 'Online' : 'Offline'} · ${esc(ago(d.recorded_at))}<br>${d.pickups} pickups · ${d.deliveries} deliveries` });
  }
  if (plan && !plan.committed) {
    plan.routes.forEach((rt) => {
      const c = colorOf[rt.driver_id];
      lines.push({ color: c, dashed: true, points: [[rt.start.lat, rt.start.lng], ...rt.stops.map((s) => [s.lat, s.lng])] });
      rt.stops.forEach((s) => markers.push({ kind: 'pickup', lat: s.lat, lng: s.lng, color: c, label: s.seq, popup: `<b>${esc(s.awb)}</b><br>${esc(s.name)}<br>${esc(s.address)}` }));
    });
  } else {
    const byDriver = {};
    for (const s of stops) {
      const isPick = s.status !== 'OUT_FOR_DELIVERY';
      const lat = isPick ? s.pickup_lat : s.dest_lat;
      const lng = isPick ? s.pickup_lng : s.dest_lng;
      const c = s.driver_id ? colorOf[s.driver_id] : '#64748b';
      const selected = manual.ids.includes(s.id);
      markers.push({ kind: isPick ? 'pickup' : 'drop', lat, lng, color: selected ? '#f97316' : c, label: selected ? manual.ids.indexOf(s.id) + 1 : (s.route_seq || (isPick ? 'P' : 'D')),
        popup: `<b>${esc(s.awb)}</b> · ${esc(s.status)}<br>${esc(isPick ? s.shipper_name : s.consignee_name)}<br>${esc(isPick ? s.shipper_address : s.consignee_address)}`,
        onClick: () => tab === 'manual' && s.status === 'BOOKED' && setManual((m) => ({ ...m, ids: m.ids.includes(s.id) ? m.ids.filter((x) => x !== s.id) : [...m.ids, s.id] })) });
      if (s.driver_id && lat) (byDriver[s.driver_id] ||= []).push([lat, lng]);
    }
    for (const d of drivers) if (byDriver[d.id] && d.lat) lines.push({ color: colorOf[d.id], points: [[d.lat, d.lng], ...byDriver[d.id]] });
  }

  const open = stops.filter((s) => s.status === 'BOOKED');
  return (
    <>
      <div className="page-head">
        <h1>Dispatch & routing</h1>
        <div className="row small muted">{drivers.filter((d) => d.online).length}/{drivers.length} drivers online · {open.length} open pickups · live GPS every 20 s</div>
      </div>
      <ErrorBox error={live.error} />
      <div className="grid dispatch-grid">
        <div className="stack">
          <Suspense fallback={<div className="map" />}><MapView markers={markers} lines={lines} height={560} fitKey={plan ? `plan-${plan.routes.length}-${plan.committed}` : `live-${stops.length}`} /></Suspense>
          <div className="row small muted"><span>🚚 driver (faded = offline)</span><span>📍 numbered = route sequence</span><span>Grey = unassigned</span>{tab === 'manual' && <b>Manual mode: click open pickups on the map to add stops in order</b>}</div>
        </div>
        <div className="stack">
          <div className="tabs"><button className={tab === 'auto' ? 'on' : ''} onClick={() => setTab('auto')}>⚡ Auto routing</button>
            <button className={tab === 'manual' ? 'on' : ''} onClick={() => { setTab('manual'); setPlan(null); }}>✋ Manual routing</button>
            <button className={tab === 'fleet' ? 'on' : ''} onClick={() => setTab('fleet')}>🚚 Fleet</button></div>

          {tab !== 'fleet' && (
            <div className="grid g2">
              <Field label="Job type"><select value={opts.kind} onChange={(e) => { setOpts({ ...opts, kind: e.target.value }); setPlan(null); }}>
                <option value="PICKUP">Pickups (collect from customer)</option><option value="DELIVERY">Deliveries (from warehouse)</option></select></Field>
              <Field label="City / zone"><select value={opts.city} onChange={(e) => setOpts({ ...opts, city: e.target.value })}><option value="">All cities</option>{UAE_CITIES.map((c) => <option key={c}>{c}</option>)}</select></Field>
            </div>
          )}

          {tab === 'auto' && (
            <div className="card stack">
              <div className="small muted">Assigns open jobs to the nearest drivers by live GPS (or depot), respecting each driver's stop capacity, then optimises the visit order (cheapest-insertion + 2-opt).</div>
              <Field label="Drivers (none selected = all active)">
                <div className="row" style={{ gap: 6 }}>{drivers.map((d) => (
                  <label key={d.id} className="badge" style={{ cursor: 'pointer', borderColor: colorOf[d.id] }}>
                    <input type="checkbox" checked={opts.driver_ids.includes(d.id)} onChange={(e) => setOpts({ ...opts, driver_ids: e.target.checked ? [...opts.driver_ids, d.id] : opts.driver_ids.filter((x) => x !== d.id) })} />
                    <span className="dot" style={{ background: colorOf[d.id] }} />{d.name}</label>))}</div>
              </Field>
              <div className="grid g2">
                <Field label="Max km per route"><input type="number" value={opts.max_route_km} onChange={(e) => setOpts({ ...opts, max_route_km: Number(e.target.value) })} /></Field>
                <label className="row small" style={{ alignSelf: 'end' }}><input type="checkbox" checked={opts.include_assigned} onChange={(e) => setOpts({ ...opts, include_assigned: e.target.checked })} /> Re-plan already assigned pickups</label>
              </div>
              <div className="row"><button className="btn" disabled={busy} onClick={() => doPlan(false)}>Preview plan</button>
                <button className="btn primary" disabled={busy || !plan || plan.committed} onClick={() => doPlan(true)}>✓ Commit & dispatch</button>
                {plan && <button className="btn ghost" onClick={() => setPlan(null)}>Clear</button>}</div>
              {plan && (
                <div className="stack">
                  {plan.committed && <div className="alert ok">Committed {plan.routes.length} routes.</div>}
                  {plan.routes.map((rt) => (
                    <div key={rt.driver_id} className="card flat route-card" style={{ borderLeftColor: colorOf[rt.driver_id] }}>
                      <div className="row between"><b>{rt.driver_name}</b><span className="small">{rt.stops.length} stops · {rt.distance_km} km · ~{Math.floor(rt.duration_min / 60)}h {rt.duration_min % 60}m</span></div>
                      {rt.stops.map((s) => <div key={s.id} className="stop-row small"><b>{s.seq}.</b> <span className="mono">{s.awb}</span> <span className="spacer">{s.name} · {s.city}{s.window && ` · ${s.window}`}</span>{s.locked && <span className="badge">kept</span>}</div>)}
                    </div>
                  ))}
                  {plan.unassigned.length > 0 && <div className="alert warn small">{plan.unassigned.length} not routed: {plan.unassigned.map((u) => `${u.awb} (${u.reason})`).join(', ')}</div>}
                  {!plan.routes.length && <Empty>No open {opts.kind.toLowerCase()} jobs for this selection.</Empty>}
                </div>
              )}
            </div>
          )}

          {tab === 'manual' && (
            <div className="card stack">
              <Field label="Driver"><select value={manual.driver_id} onChange={(e) => setManual({ ...manual, driver_id: e.target.value })}>
                <option value="">Select driver…</option>{drivers.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.pickups + d.deliveries} on run · cap {d.capacity}</option>)}</select></Field>
              <div className="small muted">Tick jobs below (or click pins on the map) in the order the driver should visit. Use ▲▼ to re-order, or let the system optimise.</div>
              <div style={{ maxHeight: 260, overflowY: 'auto' }}>
                {(opts.kind === 'PICKUP' ? open : []).filter((s) => !opts.city || s.origin_city === opts.city).map((s) => (
                  <label key={s.id} className="stop-row small" style={{ cursor: 'pointer' }}>
                    <input type="checkbox" checked={manual.ids.includes(s.id)} onChange={() => setManual((m) => ({ ...m, ids: m.ids.includes(s.id) ? m.ids.filter((x) => x !== s.id) : [...m.ids, s.id] }))} />
                    <span className="mono">{s.awb}</span><span className="spacer">{s.shipper_name} · {s.origin_city}</span>{s.pickup_window && <span className="tiny">{s.pickup_window}</span>}
                  </label>))}
                {opts.kind === 'DELIVERY' && <div className="small muted">For deliveries, assign from the Warehouse page or use Auto routing (parcels must be scanned IN first).</div>}
              </div>
              {manual.ids.length > 0 && (
                <div className="card flat"><b className="small">Stop order</b>
                  {manual.ids.map((id, i) => {
                    const s = stops.find((x) => x.id === id);
                    const mv = (d) => setManual((m) => { const a = [...m.ids]; [a[i], a[i + d]] = [a[i + d], a[i]]; return { ...m, ids: a }; });
                    return <div key={id} className="stop-row small"><b>{i + 1}.</b><span className="mono spacer">{s?.awb}</span>
                      <button className="btn sm" disabled={i === 0} onClick={() => mv(-1)} aria-label="Move up">▲</button>
                      <button className="btn sm" disabled={i === manual.ids.length - 1} onClick={() => mv(1)} aria-label="Move down">▼</button></div>;
                  })}</div>
              )}
              <div className="row"><button className="btn" disabled={busy || !manual.driver_id || !manual.ids.length} onClick={() => doManual(false)}>Assign in this order</button>
                <button className="btn primary" disabled={busy || !manual.driver_id || !manual.ids.length} onClick={() => doManual(true)}>⚡ Optimise & assign</button></div>
            </div>
          )}

          {tab === 'fleet' && (
            <div className="stack">
              {drivers.map((d) => {
                const mine = stops.filter((s) => s.driver_id === d.id);
                return (
                  <div key={d.id} className="card flat route-card" style={{ borderLeftColor: colorOf[d.id] }}>
                    <div className="row between"><b>{d.name}</b><Badge tone={d.online ? 'ok' : 'muted'}>{d.online ? 'Online' : 'Offline'}</Badge></div>
                    <div className="small muted">{d.vehicle_no} · last GPS {ago(d.recorded_at)}{d.speed ? ` · ${Math.round(d.speed * 3.6)} km/h` : ''}{d.battery ? ` · 🔋${Math.round(d.battery * 100)}%` : ''}</div>
                    {mine.map((s) => <div key={s.id} className="stop-row small"><b>{s.route_seq || '–'}.</b><Link to={`/shipments/${s.id}`} className="mono">{s.awb}</Link>
                      <span className="spacer">{s.status === 'OUT_FOR_DELIVERY' ? `↓ ${s.consignee_name}` : `↑ ${s.shipper_name}`}</span>
                      {s.status === 'PICKUP_ASSIGNED' && <button className="btn sm ghost" onClick={() => unassign(s.id)} title="Return to pool">✕</button>}</div>)}
                    {!mine.length && <div className="small muted">No active stops</div>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
      <div className="card">
        <h3>Today's routes</h3>
        {routes.loading ? <Spinner /> : routes.data?.length ? (
          <table><thead><tr><th>#</th><th>Driver</th><th>Type</th><th>Mode</th><th className="num">Stops</th><th className="num">Remaining</th><th className="num">Km</th><th className="num">Est. min</th><th>Created</th></tr></thead>
            <tbody>{routes.data.map((r) => <tr key={r.id}><td>{r.id}</td><td>{r.driver_name}</td><td>{r.kind}</td><td><Badge tone={r.mode === 'AUTO' ? 'info' : 'accent'}>{r.mode}</Badge></td>
              <td className="num">{r.stops}</td><td className="num">{r.remaining}</td><td className="num">{r.distance_km}</td><td className="num">{r.duration_min}</td><td className="small">{dt(r.created_at)} · {r.created_by_name}</td></tr>)}</tbody></table>
        ) : <Empty>No routes planned today.</Empty>}
      </div>
    </>
  );
}
