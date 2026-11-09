// Driver mobile app (PWA): route-ordered run sheet, Google Maps navigation, pickup with on-spot billing,
// POD (signature + photo) with COD, failed attempts, walk-in bookings, wallet, live GPS tracking.
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, Routes, Route, NavLink, useNavigate, useParams, Link } from 'react-router-dom';
import '../shared/styles.css';
import { createApi } from '../shared/api.js';
import { SessionProvider, useSession, LoginForm } from '../shared/session.jsx';
import { ToastProvider, useLoad, useAction, Spinner, ErrorBox, Badge, Field, Empty, Modal, useForm } from '../shared/ui.jsx';
import { aed, dt, mapsLink, telLink, waLink, SERVICES } from '../shared/format.js';
import { SignaturePad, PhotoInput, getPosition, useGpsTracker, registerSW, CameraScanner } from '../shared/devices.jsx';
import { InvoiceDoc } from '../shared/docs.jsx';
import ShipmentForm from '../shared/ShipmentForm.jsx';

const api = createApi('driver');
registerSW();

function Top({ title, back }) {
  const nav = useNavigate();
  return (
    <header className="m-top">
      {back && <button className="btn sm" onClick={() => nav(-1)} aria-label="Back">‹</button>}
      <h1 className="spacer">{title}</h1>
      <GpsDot />
    </header>
  );
}

let gpsState = { status: 'off' };
function GpsDot() {
  const s = gpsState;
  const label = { on: 'GPS live', denied: 'GPS blocked', unsupported: 'No GPS', off: 'GPS off' }[s.status];
  return <span className="badge" style={{ background: s.status === 'on' ? 'var(--ok)' : 'rgba(255,255,255,.2)', color: '#fff', borderColor: 'transparent' }}>● {label}</span>;
}

function Nav() {
  return (
    <nav className="m-nav">
      <NavLink to="/" end><span className="ic">🗺️</span>Run sheet</NavLink>
      <NavLink to="/scan"><span className="ic">📷</span>Scan</NavLink>
      <NavLink to="/book"><span className="ic">➕</span>New booking</NavLink>
      <NavLink to="/wallet"><span className="ic">💵</span>Wallet</NavLink>
    </nav>
  );
}

function RunSheet() {
  const { user, logout } = useSession();
  const [tab, setTab] = useState('pickups');
  const t = useLoad(() => api.get('/api/driver/tasks'), [], { interval: 30000 });
  const list = t.data?.[tab] || [];
  return (
    <>
      <Top title={`Hi, ${user.name.split(' ')[0]}`} />
      <div className="m-body">
        <ErrorBox error={t.error} />
        {t.data && (
          <div className="grid g3" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            <div className="card kpi"><span className="l">Pickups</span><span className="v">{t.data.pickups.length}</span></div>
            <div className="card kpi"><span className="l">To deliver</span><span className="v">{t.data.deliveries.length}</span></div>
            <div className="card kpi"><span className="l">Done today</span><span className="v">{t.data.stats.delivered_today}</span></div>
          </div>
        )}
        <div className="seg"><button className={tab === 'pickups' ? 'on' : ''} onClick={() => setTab('pickups')}>↑ Pickups</button><button className={tab === 'deliveries' ? 'on' : ''} onClick={() => setTab('deliveries')}>↓ Deliveries</button></div>
        {t.loading && !t.data ? <Spinner /> : list.length ? list.map((s, i) => {
          const pick = tab === 'pickups';
          return (
            <Link key={s.id} to={`/task/${s.id}`} className="card task" style={{ color: 'inherit', textDecoration: 'none' }}>
              <div className="seq">{s.route_seq || i + 1}</div>
              <div className="spacer" style={{ minWidth: 0 }}>
                <div className="row between nowrap"><b>{pick ? s.shipper_name : s.consignee_name}</b>{s.cod_amount > 0 && !pick && <Badge tone="warn">COD {aed(s.cod_amount)}</Badge>}</div>
                <div className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{pick ? `${s.shipper_address}, ${s.origin_city}` : `${s.consignee_address}, ${s.dest_city}`}</div>
                <div className="row tiny muted"><span className="mono">{s.awb}</span><span>{s.pieces} pcs · {s.chargeable_weight} kg</span>
                  {pick && s.payment_mode === 'CASH' && <Badge tone="accent">Collect {aed(s.total_charge)}</Badge>}{pick && s.pickup_window && <span>⏰ {s.pickup_window}</span>}{s.attempts > 0 && <Badge tone="bad">Attempt {s.attempts + 1}</Badge>}</div>
              </div>
            </Link>
          );
        }) : <Empty>No {tab} assigned. Pull to refresh or check with dispatch.</Empty>}
        {list.length > 1 && (
          <a className="btn block" target="_blank" rel="noreferrer"
            href={`https://www.google.com/maps/dir/?api=1&waypoints=${list.slice(0, -1).map((s) => (tab === 'pickups' ? `${s.pickup_lat},${s.pickup_lng}` : `${s.dest_lat},${s.dest_lng}`)).join('|')}&destination=${tab === 'pickups' ? `${list.at(-1).pickup_lat},${list.at(-1).pickup_lng}` : `${list.at(-1).dest_lat},${list.at(-1).dest_lng}`}`}>
            🧭 Navigate full route ({list.length} stops)</a>
        )}
        <button className="btn ghost block small" onClick={logout}>Sign out</button>
      </div>
    </>
  );
}

function Task() {
  const { id } = useParams();
  const nav = useNavigate();
  const d = useLoad(() => api.get(`/api/driver/tasks/${id}`), [id]);
  const [mode, setMode] = useState(null);
  if (d.loading && !d.data) return <><Top title="Task" back /><Spinner /></>;
  if (d.error) return <><Top title="Task" back /><div className="m-body"><ErrorBox error={d.error} /></div></>;
  const s = d.data;
  const pick = s.status === 'PICKUP_ASSIGNED';
  const who = pick ? { name: s.shipper_name, phone: s.shipper_phone, addr: `${s.shipper_address}, ${s.origin_city}`, lat: s.pickup_lat, lng: s.pickup_lng }
    : { name: s.consignee_name, phone: s.consignee_phone, addr: `${s.consignee_address}, ${s.dest_city}`, lat: s.dest_lat, lng: s.dest_lng };
  const done = () => nav('/', { replace: true });
  return (
    <>
      <Top title={pick ? 'Pickup' : 'Delivery'} back />
      <div className="m-body">
        <div className="card stack">
          <div className="row between"><span className="mono"><b>{s.awb}</b></span><Badge s={s.status} /></div>
          <div><div className="big-number" style={{ fontSize: '1.3rem' }}>{who.name}</div><div className="muted">{who.addr}</div></div>
          <div className="grid g3" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            <a className="btn" href={mapsLink(who.lat, who.lng, who.addr)} target="_blank" rel="noreferrer">🧭 Navigate</a>
            <a className="btn" href={telLink(who.phone)}>📞 Call</a>
            <a className="btn" href={waLink(who.phone, `Hello, this is your ABC Cargo courier for shipment ${s.awb}. I am on my way.`)} target="_blank" rel="noreferrer">💬 WhatsApp</a>
          </div>
          <div className="small">{SERVICES[s.service]} · {s.pieces} pcs · {s.chargeable_weight} kg · {s.description || 'Parcel'}{s.pickup_window && pick && ` · window ${s.pickup_window}`}</div>
          {pick && s.payment_mode === 'CASH' && !s.invoice_id && <div className="alert warn"><b>Collect {aed(s.total_charge)}</b> from shipper at pickup (cash or card).</div>}
          {!pick && s.cod_amount > 0 && <div className="alert warn"><b>COD: collect {aed(s.cod_amount)}</b> from consignee before handing over.</div>}
        </div>
        {pick && <button className="btn primary lg block" onClick={() => setMode('pickup')}>✓ Confirm pickup</button>}
        {!pick && s.status === 'OUT_FOR_DELIVERY' && (
          <>
            <button className="btn ok lg block" onClick={() => setMode('deliver')}>✓ Deliver (POD)</button>
            <button className="btn danger block" onClick={() => setMode('fail')}>✕ Could not deliver</button>
          </>
        )}
      </div>
      {mode === 'pickup' && <PickupModal s={s} onClose={() => setMode(null)} onDone={done} />}
      {mode === 'deliver' && <DeliverModal s={s} onClose={() => setMode(null)} onDone={done} />}
      {mode === 'fail' && <FailModal s={s} onClose={() => setMode(null)} onDone={done} />}
    </>
  );
}

function PickupModal({ s, onClose, onDone }) {
  const [v, , bind] = useForm({ pieces: s.pieces, weight: s.weight, method: 'CASH', reference: '', note: '' });
  const [run, busy] = useAction();
  const [receipt, setReceipt] = useState(null);
  const meta = useLoad(() => api.get('/api/public/meta'), []);
  const collect = s.payment_mode === 'CASH' && !s.invoice_id;
  const reweighed = Number(v.weight) !== s.weight || Number(v.pieces) !== s.pieces;
  const submit = async () => {
    const pos = await getPosition();
    const body = { pieces: Number(v.pieces), weight: Number(v.weight), note: v.note || undefined, ...(pos || {}) };
    if (collect) {
      // Re-price first if weight changed so the collected amount matches the invoice.
      const amount = reweighed
        ? (await api.post('/api/driver/quote', { service: s.service, origin_city: s.origin_city, dest_city: s.dest_city, dest_country: s.dest_country, weight: body.weight, pieces: body.pieces, cod_amount: s.cod_amount }))
          .quotes.find((q) => q.service === s.service).total_charge
        : s.total_charge;
      if (!confirm(`Collect ${aed(amount)} by ${v.method}?`)) return;
      body.payment = { method: v.method, amount, reference: v.reference || undefined };
    }
    const r = await run(() => api.post(`/api/driver/shipments/${s.id}/pickup`, body), 'Pickup confirmed');
    if (r.invoice) setReceipt(await api.get(`/api/driver/invoices/${r.invoice.id}`)); else onDone();
  };
  if (receipt) return <ReceiptModal inv={receipt} company={meta.data?.company} onClose={onDone} />;
  return (
    <Modal title={`Pickup ${s.awb}`} onClose={onClose} footer={<button className="btn primary lg block" disabled={busy} onClick={submit}>{collect ? 'Collect payment & confirm' : 'Confirm pickup'}</button>}>
      <div className="grid g2">
        <Field label="Pieces"><input {...bind('pieces', 'number')} /></Field>
        <Field label="Weight (kg)" hint={reweighed ? 'Charges will be recalculated' : 'Re-weigh if different'}><input {...bind('weight', 'number')} /></Field>
      </div>
      {collect && (
        <div className="grid g2" style={{ marginTop: 10 }}>
          <Field label="Payment method"><select {...bind('method')}><option value="CASH">Cash</option><option value="CARD">Card (POS)</option></select></Field>
          {v.method === 'CARD' && <Field label="POS approval code"><input {...bind('reference')} /></Field>}
        </div>
      )}
      <Field label="Note"><input {...bind('note')} placeholder="Optional" /></Field>
      <div className="tiny muted" style={{ marginTop: 8 }}>Your GPS position is recorded with the pickup.</div>
    </Modal>
  );
}

function ReceiptModal({ inv, company, onClose }) {
  const share = async () => {
    const text = `${company?.name || 'ABC Cargo'} receipt ${inv.number}: ${aed(inv.total)} paid. Thank you!`;
    if (navigator.share) navigator.share({ title: inv.number, text }).catch(() => {});
    else window.open(waLink(inv.customer_phone || '', text), '_blank');
  };
  return (
    <Modal title="Receipt" onClose={onClose} footer={<><button className="btn" onClick={share}>Share</button><button className="btn" onClick={() => window.print()}>Print</button><button className="btn primary" onClick={onClose}>Done</button></>}>
      <InvoiceDoc inv={inv} company={company} receipt />
    </Modal>
  );
}

function DeliverModal({ s, onClose, onDone }) {
  const [name, setName] = useState(s.consignee_name);
  const [sig, setSig] = useState(null);
  const [photo, setPhoto] = useState(null);
  const [codOk, setCodOk] = useState(false);
  const [method, setMethod] = useState('CASH');
  const [run, busy] = useAction();
  const submit = async () => {
    const pos = await getPosition();
    await run(() => api.post(`/api/driver/shipments/${s.id}/deliver`, {
      receiver_name: name, signature: sig, photo: photo || undefined, ...(pos || {}),
      ...(s.cod_amount > 0 ? { cod_collected: s.cod_amount, cod_method: method } : {}),
    }), 'Delivered ✓');
    onDone();
  };
  return (
    <Modal title={`Proof of delivery · ${s.awb}`} onClose={onClose}
      footer={<button className="btn ok lg block" disabled={busy || !sig || name.trim().length < 2 || (s.cod_amount > 0 && !codOk)} onClick={submit}>Complete delivery</button>}>
      <div className="stack">
        {s.cod_amount > 0 && (
          <div className="card flat stack">
            <b>COD {aed(s.cod_amount)}</b>
            <div className="seg"><button className={method === 'CASH' ? 'on' : ''} onClick={() => setMethod('CASH')}>Cash</button><button className={method === 'CARD' ? 'on' : ''} onClick={() => setMethod('CARD')}>Card</button></div>
            <label className="row"><input type="checkbox" checked={codOk} onChange={(e) => setCodOk(e.target.checked)} /> I have collected {aed(s.cod_amount)} by {method.toLowerCase()}</label>
          </div>
        )}
        <Field label="Received by"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <SignaturePad onChange={setSig} />
        <PhotoInput onChange={setPhoto} label="Photo of parcel at door (optional)" />
      </div>
    </Modal>
  );
}

function FailModal({ s, onClose, onDone }) {
  const reasons = useLoad(() => api.get('/api/driver/fail-reasons'), []);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [run, busy] = useAction();
  const submit = async () => {
    const pos = await getPosition();
    await run(() => api.post(`/api/driver/shipments/${s.id}/fail`, { reason, note: note || undefined, ...(pos || {}) }), 'Attempt recorded');
    onDone();
  };
  return (
    <Modal title="Delivery attempt failed" onClose={onClose} footer={<button className="btn danger lg block" disabled={busy || !reason} onClick={submit}>Record attempt</button>}>
      <div className="stack">{reasons.data?.map((r) => <label key={r} className="card flat row nowrap" style={{ cursor: 'pointer' }}><input type="radio" name="r" checked={reason === r} onChange={() => setReason(r)} /> {r}</label>)}
        <Field label="Note"><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <div className="tiny muted">Return the parcel to the warehouse at end of shift — it will be IN-scanned and re-routed.</div></div>
    </Modal>
  );
}

function Book() {
  const nav = useNavigate();
  const meta = useLoad(() => api.get('/api/public/meta'), []);
  const [q, setQ] = useState('');
  const custs = useLoad(() => api.get(`/api/driver/customers?q=${encodeURIComponent(q)}`), [q]);
  const [cust, setCust] = useState(null);
  const [method, setMethod] = useState('CASH');
  const [ref, setRef] = useState('');
  const [run, busy] = useAction();
  const [receipt, setReceipt] = useState(null);
  if (receipt) return <><Top title="Receipt" /><div className="m-body"><ReceiptModal inv={receipt} company={meta.data?.company} onClose={() => nav('/')} /></div></>;
  const isCash = !cust || cust.type === 'CASH';
  return (
    <>
      <Top title="New booking & bill" />
      <div className="m-body">
        <div className="card stack">
          <Field label="Customer"><input placeholder="Search account customer… (blank = walk-in cash)" value={q} onChange={(e) => setQ(e.target.value)} /></Field>
          <div className="row" style={{ gap: 6 }}>
            <button className={`btn sm ${!cust ? 'primary' : ''}`} onClick={() => setCust(null)}>Walk-in (cash)</button>
            {q && custs.data?.filter((c) => c.code !== 'WALKIN').slice(0, 6).map((c) => <button key={c.id} className={`btn sm ${cust?.id === c.id ? 'primary' : ''}`} onClick={() => setCust(c)}>{c.name} · {c.type}</button>)}
          </div>
        </div>
        <ShipmentForm api={api} quoteUrl="/api/driver/quote" mobile busy={busy} key={cust?.id || 'walkin'} showMap={false}
          initial={cust ? { shipper_name: cust.name, shipper_phone: cust.phone || '', shipper_address: cust.address || '', origin_city: cust.city || 'Dubai' } : {}}
          submitLabel={isCash ? 'Collect & book' : 'Book on account'}
          extra={() => isCash && (
            <div className="card flat stack"><b>Payment at pickup</b>
              <div className="seg"><button type="button" className={method === 'CASH' ? 'on' : ''} onClick={() => setMethod('CASH')}>💵 Cash</button><button type="button" className={method === 'CARD' ? 'on' : ''} onClick={() => setMethod('CARD')}>💳 Card</button></div>
              {method === 'CARD' && <Field label="POS approval code"><input value={ref} onChange={(e) => setRef(e.target.value)} /></Field>}</div>
          )}
          onSubmit={async (body, quote) => {
            const pos = await getPosition();
            const r = await run(() => api.post('/api/driver/bookings', { ...body, customer_id: cust?.id, ...(pos || {}),
              ...(isCash ? { payment: { method, amount: quote.total_charge, reference: ref || undefined } } : {}) }), 'Booked & billed');
            if (r.invoice) setReceipt(await api.get(`/api/driver/invoices/${r.invoice.id}`)); else nav('/');
          }} />
      </div>
    </>
  );
}

function Scan() {
  const nav = useNavigate();
  const [err, setErr] = useState(null);
  const [manual, setManual] = useState('');
  const open = async (awb) => {
    try { const s = await api.get(`/api/driver/lookup/${encodeURIComponent(awb)}`); nav(`/task/${s.id}`); } catch (e) { setErr(e); }
  };
  return (
    <>
      <Top title="Scan parcel" />
      <div className="m-body">
        <CameraScanner onScan={open} />
        <ErrorBox error={err} />
        <form className="row nowrap" onSubmit={(e) => { e.preventDefault(); open(manual); }}><input value={manual} onChange={(e) => setManual(e.target.value.toUpperCase())} placeholder="Type AWB" /><button className="btn primary">Open</button></form>
        <div className="tiny muted">Scan the AWB label to open the matching task on your run sheet.</div>
      </div>
    </>
  );
}

function Wallet() {
  const w = useLoad(() => api.get('/api/driver/wallet'), []);
  return (
    <>
      <Top title="My wallet" />
      <div className="m-body">
        {w.loading ? <Spinner /> : w.data && (
          <>
            <div className="card center"><div className="muted small">Cash in hand (hand over to finance)</div><div className="big-number">{aed(w.data.cash_in_hand)}</div>
              <div className="small muted">COD {aed(w.data.cod_cash)} · Freight {aed(w.data.freight_cash)} · Card {aed(w.data.card_total)}</div></div>
            <div className="card"><h3>Unsettled collections</h3>
              {w.data.collections.length ? <table><tbody>{w.data.collections.map((p) => <tr key={p.id}><td><span className="mono small">{p.awb || p.invoice_number}</span><div className="tiny muted">{p.kind} · {p.method} · {dt(p.created_at)}</div></td><td className="num">{aed(p.amount)}</td></tr>)}</tbody></table> : <Empty>All settled.</Empty>}</div>
            <div className="card"><h3>Recent settlements</h3><table><tbody>{w.data.settlements.map((s) => <tr key={s.id}><td>#{s.id} · {dt(s.created_at)}</td><td className="num">{aed(s.amount)}</td></tr>)}</tbody></table></div>
          </>
        )}
      </div>
    </>
  );
}

function App() {
  const { user } = useSession();
  gpsState = useGpsTracker(api, !!user, 30000);
  if (user === undefined) return <Spinner />;
  if (!user) return <LoginForm title="ABC Driver" subtitle="Pickups · Deliveries · Billing" demo="driver1@abccargo.demo" accent="driver" />;
  return (
    <div className="m-app">
      <Routes>
        <Route path="/" element={<RunSheet />} />
        <Route path="/task/:id" element={<Task />} />
        <Route path="/book" element={<Book />} />
        <Route path="/scan" element={<Scan />} />
        <Route path="/wallet" element={<Wallet />} />
      </Routes>
      <Nav />
    </div>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode><ToastProvider><SessionProvider api={api} app="driver"><HashRouter><App /></HashRouter></SessionProvider></ToastProvider></StrictMode>,
);
