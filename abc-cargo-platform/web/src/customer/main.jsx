// Public Customer App (PWA): worldwide quote & track without login; customers book international air courier /
// cargo (with commercial invoice) or UAE domestic, print labels, pay invoices, raise support tickets.
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, Routes, Route, NavLink, Link, useNavigate, useParams } from 'react-router-dom';
import '../shared/styles.css';
import { createApi } from '../shared/api.js';
import { SessionProvider, useSession, LoginForm, demoAccount, RegionPicker } from '../shared/session.jsx';
import { ToastProvider, useLoad, useAction, Spinner, ErrorBox, Badge, Field, Empty, Modal, useForm } from '../shared/ui.jsx';
import { aed, money, dt, dOnly, SERVICES, STATUS, REGIONS } from '../shared/format.js';
import { registerSW } from '../shared/devices.jsx';
import { ShippingLabel, InvoiceDoc, CommercialInvoice } from '../shared/docs.jsx';
import ShipmentForm from '../shared/ShipmentForm.jsx';

const api = createApi('customer');
registerSW();

function Top({ title, back, right }) {
  const nav = useNavigate();
  return (
    <header className="m-top" style={{ background: 'linear-gradient(135deg, #0b3d91, #1456c4)' }}>
      {back && <button className="btn sm" onClick={() => nav(-1)} aria-label="Back">‹</button>}
      <h1 className="spacer">{title}</h1>{right}
    </header>
  );
}

function Nav() {
  const { user } = useSession();
  return (
    <nav className="m-nav">
      <NavLink to="/" end><span className="ic">🏠</span>Home</NavLink>
      <NavLink to="/track"><span className="ic">🔎</span>Track</NavLink>
      {user ? <>
        <NavLink to="/ship"><span className="ic">✈️</span>Ship</NavLink>
        <NavLink to="/shipments"><span className="ic">📦</span>My shipments</NavLink>
        <NavLink to="/account"><span className="ic">👤</span>Account</NavLink>
      </> : <>
        <NavLink to="/quote"><span className="ic">💲</span>Rates</NavLink>
        <NavLink to="/login"><span className="ic">👤</span>Sign in</NavLink>
      </>}
    </nav>
  );
}

const STEP_INTL = ['BOOKED', 'PICKED_UP', 'IN_WAREHOUSE', 'MANIFESTED', 'DEPARTED', 'ARRIVED', 'CUSTOMS_CLEARED', 'OUT_FOR_DELIVERY', 'DELIVERED'];
const STEP_DOM = ['BOOKED', 'PICKED_UP', 'IN_WAREHOUSE', 'OUT_FOR_DELIVERY', 'DELIVERED'];
function Progress({ t }) {
  const steps = t.dest_country !== 'AE' ? STEP_INTL : STEP_DOM;
  const map = { PICKUP_ASSIGNED: 'BOOKED', IN_TRANSIT: 'IN_WAREHOUSE', CUSTOMS_HOLD: 'ARRIVED', WITH_AGENT: 'CUSTOMS_CLEARED', DELIVERY_FAILED: 'OUT_FOR_DELIVERY' };
  const idx = steps.indexOf(map[t.status] || t.status);
  return (
    <div className="row nowrap" style={{ gap: 3 }} aria-label="Progress">
      {steps.map((s, i) => <div key={s} title={STATUS[s].label} style={{ flex: 1, height: 6, borderRadius: 3, background: i <= idx ? 'var(--brand)' : 'var(--border)' }} />)}
    </div>
  );
}

function TrackResult({ t }) {
  return (
    <div className="card stack">
      <div className="row between"><b className="mono">{t.awb}</b><Badge s={t.status}>{t.status_label}</Badge></div>
      <Progress t={t} />
      <div className="big-number" style={{ fontSize: '1.15rem' }}>{t.origin_city}, UAE → {t.dest_city}{t.dest_country !== 'AE' ? `, ${t.dest_country_name}` : ''}</div>
      <div className="small muted">{SERVICES[t.service]} · {t.pieces} pcs · {t.chargeable_weight} kg{t.flight_no && ` · flight ${t.flight_no} ${dOnly(t.flight_date)} → ${t.dest_airport}`}</div>
      {t.status === 'CUSTOMS_HOLD' && <div className="alert warn small">Held by destination customs. Our team will contact the receiver for any documents required.</div>}
      {t.agent_name && t.agent_tracking && <div className="small">Local delivery partner: {t.agent_name} · ref {t.agent_tracking}</div>}
      {t.status === 'DELIVERED' && <div className="alert ok">Delivered {dt(t.delivered_at)} · received by {t.pod_name}</div>}
      <ul className="timeline">{t.events.map((e, i) => <li key={i}><b className="small">{STATUS[e.status]?.label || e.status}</b> <span className="small muted">{e.location}</span><div className="small">{e.note}</div><div className="tiny muted">{dt(e.created_at)}</div></li>)}</ul>
    </div>
  );
}

function Track() {
  const { awb: initial } = useParams();
  const [awb, setAwb] = useState(initial || '');
  const [t, setT] = useState(null);
  const [err, setErr] = useState(null);
  const go = async (e) => {
    e?.preventDefault();
    setErr(null); setT(null);
    try { setT(await api.get(`/api/public/track/${encodeURIComponent(awb.trim())}`)); } catch (x) { setErr(x); }
  };
  return (
    <>
      <Top title="Track shipment" />
      <div className="m-body">
        <form className="row nowrap" onSubmit={go}><input value={awb} onChange={(e) => setAwb(e.target.value.toUpperCase())} placeholder="AWB e.g. ABC100000013" autoFocus /><button className="btn primary">Track</button></form>
        <ErrorBox error={err} />
        {t && <TrackResult t={t} />}
      </div>
    </>
  );
}

function Quote() {
  const { region: sessionRegion } = useSession();
  const [region, setRegion] = useState(sessionRegion || 'AE');
  const [v, setV, bind] = useForm({ dest_country: region === 'IN' ? 'AE' : 'IN', dest_city: '', weight: 2, length: '', width: '', height: '', customs_value: 0, incoterm: 'DAP', product: 'PARCEL' });
  const meta = useLoad(() => api.get(`/api/public/meta?entity=${region}`), [region]);
  const [q, setQ] = useState(null);
  const [err, setErr] = useState(null);
  const go = async (e) => {
    e.preventDefault(); setErr(null);
    try {
      const r = await api.post('/api/public/quote', { entity: region, origin_city: meta.data?.cities[0] || 'City', dest_city: v.dest_city || (v.dest_country === region ? meta.data?.cities[1] || 'City' : 'City'),
        dest_country: v.dest_country, weight: v.weight, length: v.length || undefined, width: v.width || undefined, height: v.height || undefined,
        customs_value: Number(v.customs_value) || 0, incoterm: v.dest_country === region ? undefined : v.incoterm, product: v.product });
      setQ(r.quotes);
    } catch (x) { setErr(x); }
  };
  return (
    <>
      <Top title="Rates — ship worldwide" />
      <form className="m-body" onSubmit={go}>
        <div className="card stack">
          <Field label="Sending from"><RegionPicker value={region} onChange={(r) => { setRegion(r); setV((s) => ({ ...s, dest_country: r === 'IN' ? 'AE' : 'IN' })); setQ(null); }} /></Field>
          <Field label="Destination country"><select {...bind('dest_country')}>{meta.data?.country_list?.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}<option value={region}>{REGIONS[region]?.name} (domestic)</option></select></Field>
          {v.dest_country === region && <Field label="City"><select {...bind('dest_city')}>{meta.data?.cities.map((c) => <option key={c}>{c}</option>)}</select></Field>}
          <div className="grid g2">
            <Field label="Weight (kg)"><input {...bind('weight', 'number')} /></Field>
            {v.dest_country !== region && <Field label="Contents"><select {...bind('product')}><option value="PARCEL">Parcel</option><option value="DOCUMENT">Documents</option><option value="CARGO">Air cargo</option></select></Field>}
          </div>
          <Field label="Box size cm (optional)"><div className="row nowrap" style={{ gap: 4 }}><input {...bind('length', 'number')} placeholder="L" /><input {...bind('width', 'number')} placeholder="W" /><input {...bind('height', 'number')} placeholder="H" /></div></Field>
          {v.dest_country !== region && v.product !== 'DOCUMENT' && <div className="grid g2"><Field label={`Goods value (${REGIONS[region]?.currency})`}><input {...bind('customs_value', 'number')} /></Field>
            <Field label="Duties"><select {...bind('incoterm')}><option value="DAP">Receiver pays</option><option value="DDP">I pay (DDP)</option></select></Field></div>}
          <button className="btn primary lg">Get prices</button>
        </div>
        <ErrorBox error={err} />
        {q && (q.length ? q.map((x) => (
          <div key={x.service} className="card row nowrap"><div className="spacer"><b>{SERVICES[x.service]}</b><div className="small muted">{x.mode === 'SEA' ? '🚢 ' : '✈️ '}{x.transit} · {x.unit === 'CBM' ? `${x.chargeable_units} CBM` : `${x.chargeable_weight} kg`} chargeable</div>
            {x.duties_estimate > 0 && <div className="tiny">incl. duties & taxes {money(x.duties_estimate, x.currency)}</div>}
            {x.duties_guide?.applies && v.incoterm === 'DAP' && <div className="tiny muted">Receiver pays est. {money(x.duties_guide.total, x.currency)} duties/taxes</div>}</div>
            <div className="big-number" style={{ fontSize: '1.2rem' }}>{money(x.total_charge, x.currency)}</div></div>
        )) : <Empty>No service to this destination yet.</Empty>)}
        <Link to="/ship" className="btn accent lg block">Book a pickup</Link>
      </form>
    </>
  );
}

function Home() {
  const { user } = useSession();
  const nav = useNavigate();
  const [awb, setAwb] = useState('');
  const prof = useLoad(() => (user ? api.get('/api/customer/profile') : Promise.resolve(null)), [user?.id]);
  const recent = useLoad(() => (user ? api.get('/api/customer/shipments?active=1') : Promise.resolve([])), [user?.id]);
  return (
    <>
      <Top title="ABC Cargo & Courier" right={user ? <span className="small">{user.name.split(' ')[0]}</span> : <Link className="btn sm" to="/login">Sign in</Link>} />
      <div className="m-body">
        <div className="card stack" style={{ background: 'linear-gradient(135deg, var(--brand-soft), var(--accent-soft))' }}>
          <h2 style={{ margin: 0 }}>Ship worldwide from the UAE ✈️</h2>
          <div className="small">International air courier, air freight cargo and UAE same-day delivery — door to door, customs handled.</div>
          <form className="row nowrap" onSubmit={(e) => { e.preventDefault(); if (awb.trim()) nav(`/track/${awb.trim()}`); }}>
            <input value={awb} onChange={(e) => setAwb(e.target.value.toUpperCase())} placeholder="Track AWB" /><button className="btn primary">Track</button></form>
        </div>
        <div className="grid g2" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <Link to={user ? '/ship' : '/login'} className="card center" style={{ color: 'inherit' }}><div style={{ fontSize: 28 }}>✈️</div><b>Send abroad</b><div className="tiny muted">230+ lanes via DXB</div></Link>
          <Link to="/quote" className="card center" style={{ color: 'inherit' }}><div style={{ fontSize: 28 }}>💲</div><b>Instant rates</b><div className="tiny muted">Duties estimate incl.</div></Link>
        </div>
        {user && prof.data && (
          <div className="grid g3" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            <div className="card kpi"><span className="l">Active</span><span className="v">{prof.data.stats.active || 0}</span></div>
            <div className="card kpi"><span className="l">Delivered</span><span className="v">{prof.data.stats.delivered || 0}</span></div>
            <Link to="/invoices" className="card kpi" style={{ color: 'inherit' }}><span className="l">Due</span><span className="v" style={{ fontSize: '1rem' }}>{aed(prof.data.stats.amount_due)}</span></Link>
          </div>
        )}
        {user && recent.data?.slice(0, 5).map((s) => (
          <Link key={s.id} to={`/shipments/${s.awb}`} className="card" style={{ color: 'inherit' }}>
            <div className="row between"><b className="mono small">{s.awb}</b><Badge s={s.status} /></div>
            <div className="small">{s.dest_country !== 'AE' ? `✈️ ${s.dest_city}, ${s.dest_country}` : `${s.origin_city} → ${s.dest_city}`} · {s.consignee_name}</div>
          </Link>
        ))}
        {!user && <div className="card small">Business account? Get monthly invoicing, credit terms and COD remittance — <Link to="/login">sign in</Link> or <Link to="/register">register</Link>.</div>}
      </div>
    </>
  );
}

function Ship() {
  const nav = useNavigate();
  const { user } = useSession();
  const prof = useLoad(() => api.get('/api/customer/profile'), []);
  const [payOnline, setPayOnline] = useState(false);
  const [run, busy] = useAction();
  if (prof.loading) return <><Top title="Book shipment" /><Spinner /></>;
  const c = prof.data.customer;
  const cash = c.type === 'CASH';
  return (
    <>
      <Top title="Book a shipment" />
      <div className="m-body">
        <ShipmentForm api={api} mobile busy={busy} region={c.entity_code} receiversUrl="/api/customer/receivers"
          initial={{ shipper_name: c.name, shipper_phone: c.phone || user.phone || '', shipper_address: c.address || '', origin_city: c.city || undefined }}
          submitLabel="Book & schedule pickup"
          extra={() => cash && (
            <div className="card flat stack"><b>Payment</b>
              <label className="row"><input type="radio" checked={!payOnline} onChange={() => setPayOnline(false)} /> Pay the courier at pickup (cash / card)</label>
              {prof.data.payments_demo && <label className="row"><input type="radio" checked={payOnline} onChange={() => setPayOnline(true)} /> Pay online now</label>}
            </div>
          )}
          onSubmit={async (body) => {
            const r = await run(() => api.post('/api/customer/shipments', { ...body, pay_online: payOnline }), 'Booked! Pickup will be scheduled.');
            nav(r.invoice ? `/invoices/${r.invoice.id}` : `/shipments/${r.shipment.awb}`);
          }} />
      </div>
    </>
  );
}

function Shipments() {
  const [q, setQ] = useState('');
  const list = useLoad(() => api.get(`/api/customer/shipments?q=${encodeURIComponent(q)}`), [q]);
  return (
    <>
      <Top title="My shipments" />
      <div className="m-body">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search AWB, receiver, reference" />
        {list.loading && !list.data ? <Spinner /> : list.data?.length ? list.data.map((s) => (
          <Link key={s.id} to={`/shipments/${s.awb}`} className="card" style={{ color: 'inherit' }}>
            <div className="row between"><b className="mono small">{s.awb}</b><Badge s={s.status} /></div>
            <div className="small">{s.dest_country !== 'AE' ? `✈️ ${s.dest_city}, ${s.dest_country}` : `${s.origin_city} → ${s.dest_city}`} · {s.consignee_name}</div>
            <div className="tiny muted">{SERVICES[s.service]} · {money(s.total_charge, s.currency)} · {dt(s.created_at)}{s.reference && ` · ${s.reference}`}</div>
          </Link>
        )) : <Empty>No shipments yet. <Link to="/ship">Book your first</Link>.</Empty>}
      </div>
    </>
  );
}

function ShipmentView() {
  const { awb } = useParams();
  const meta = useLoad(() => api.get('/api/public/meta'), []);
  const d = useLoad(() => api.get(`/api/customer/shipments/${awb}`), [awb]);
  const [doc, setDoc] = useState(null);
  const [run, busy] = useAction();
  if (d.loading && !d.data) return <><Top title="Shipment" back /><Spinner /></>;
  if (d.error) return <><Top title="Shipment" back /><div className="m-body"><ErrorBox error={d.error} /></div></>;
  const s = d.data;
  return (
    <>
      <Top title={s.awb} back />
      <div className="m-body">
        <TrackResult t={{ ...s, status_label: STATUS[s.status]?.label, dest_country_name: s.dest_country, events: s.events.slice().reverse(), flight_no: s.manifest?.flight_no, flight_date: s.manifest?.flight_date }} />
        <div className="card small">
          <div><b>To:</b> {s.consignee_name}, {s.consignee_address}, {s.dest_city} {s.consignee_postcode} {s.dest_country}</div>
          <div><b>Charges:</b> {money(s.total_charge, s.currency)} ({s.payment_mode}){s.duties_estimate ? ` incl. DDP duties ${money(s.duties_estimate, s.currency)}` : ''}{s.box_count > 1 ? ` · ${s.box_count} boxes` : ''}{s.mode === 'SEA' ? ` · ${s.cbm} CBM` : ''}{s.shipment_type === 'INTERNATIONAL' && ` · customs: ${STATUS[s.customs_status]?.label}`}</div>
          {s.customs_status === 'PENDING' && <div className="alert warn small" style={{ marginTop: 6 }}>Customs documents incomplete (HS codes / item values). Our team will contact you, or raise a ticket.</div>}
        </div>
        <div className="grid g2" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <button className="btn" onClick={() => setDoc('label')}>🖨️ Label</button>
          {s.shipment_type === 'INTERNATIONAL' && s.product !== 'DOCUMENT' ? <button className="btn" onClick={() => setDoc('ci')}>🧾 Commercial invoice</button> : <span />}
          <Link className="btn" to={`/support/new?awb=${s.awb}`}>🎧 Get help</Link>
          {s.status === 'BOOKED' && <button className="btn danger" disabled={busy} onClick={() => confirm('Cancel this shipment?') && run(() => api.post(`/api/customer/shipments/${s.id}/cancel`), 'Cancelled').then(d.reload)}>Cancel</button>}
        </div>
      </div>
      {doc === 'label' && <Modal title="Label" onClose={() => setDoc(null)} footer={<button className="btn primary" onClick={() => window.print()}>Print</button>}><ShippingLabel s={s} company={meta.data?.company} /></Modal>}
      {doc === 'ci' && <Modal title="Commercial invoice" wide onClose={() => setDoc(null)} footer={<button className="btn primary" onClick={() => window.print()}>Print</button>}><CommercialInvoice s={s} company={meta.data?.company} /></Modal>}
    </>
  );
}

function Invoices() {
  const list = useLoad(() => api.get('/api/customer/invoices'), []);
  return (
    <>
      <Top title="Invoices" back />
      <div className="m-body">
        {list.loading ? <Spinner /> : list.data?.length ? list.data.map((i) => (
          <Link key={i.id} to={`/invoices/${i.id}`} className="card row between" style={{ color: 'inherit' }}>
            <div><b className="mono small">{i.number}</b><div className="tiny muted">{dOnly(i.issue_date)} · due {dOnly(i.due_date)}</div></div>
            <div className="right"><Badge s={i.status} /><div className="small">{money(i.balance > 0 ? i.balance : i.total, i.currency)}</div></div>
          </Link>
        )) : <Empty>No invoices.</Empty>}
      </div>
    </>
  );
}

function InvoiceView() {
  const { id } = useParams();
  const meta = useLoad(() => api.get('/api/public/meta'), []);
  const prof = useLoad(() => api.get('/api/customer/profile'), []);
  const d = useLoad(() => api.get(`/api/customer/invoices/${id}`), [id]);
  const [run, busy] = useAction();
  if (d.loading && !d.data) return <><Top title="Invoice" back /><Spinner /></>;
  if (d.error) return <><Top title="Invoice" back /><div className="m-body"><ErrorBox error={d.error} /></div></>;
  const inv = d.data;
  return (
    <>
      <Top title={inv.number} back />
      <div className="m-body">
        {['UNPAID', 'PARTIAL'].includes(inv.status) && prof.data?.payments_demo && (
          <button className="btn accent lg block" disabled={busy} onClick={() => run(() => api.post(`/api/customer/invoices/${inv.id}/pay`), 'Payment successful').then(d.reload)}>💳 Pay {money(inv.balance, inv.currency)} online (demo gateway)</button>
        )}
        <div style={{ overflowX: 'auto' }}><InvoiceDoc inv={inv} company={meta.data?.company} /></div>
        <button className="btn block" onClick={() => window.print()}>🖨️ Print / save PDF</button>
      </div>
    </>
  );
}

function Support() {
  const list = useLoad(() => api.get('/api/customer/tickets'), []);
  return (
    <>
      <Top title="Support" back right={<Link className="btn sm" to="/support/new">+ New</Link>} />
      <div className="m-body">
        {list.loading ? <Spinner /> : list.data?.length ? list.data.map((t) => (
          <Link key={t.id} to={`/support/${t.id}`} className="card" style={{ color: 'inherit' }}>
            <div className="row between"><b>{t.subject}</b><Badge s={t.status} /></div>
            <div className="tiny muted">{t.number} · {t.category}{t.awb && ` · ${t.awb}`} · {dt(t.updated_at)}</div>
          </Link>
        )) : <Empty>No tickets. Need help? Tap + New.</Empty>}
      </div>
    </>
  );
}

function NewTicket() {
  const nav = useNavigate();
  const awb = new URLSearchParams(location.hash.split('?')[1] || '').get('awb') || '';
  const [v, , bind] = useForm({ awb, category: 'DELAY', subject: '', description: '' });
  const [run, busy] = useAction();
  return (
    <>
      <Top title="New support request" back />
      <form className="m-body" onSubmit={(e) => { e.preventDefault(); run(() => api.post('/api/customer/tickets', { ...v, awb: v.awb || undefined, description: v.description || undefined }), 'Ticket created').then((t) => nav(`/support/${t.id}`, { replace: true })); }}>
        <Field label="AWB (optional)"><input {...bind('awb')} /></Field>
        <Field label="Topic"><select {...bind('category')}>{[['DELAY', 'Delay / where is my parcel'], ['PICKUP', 'Pickup'], ['DAMAGE', 'Damaged'], ['LOST', 'Lost'], ['BILLING', 'Billing / duties'], ['COD', 'COD payment'], ['OTHER', 'Other']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Subject"><input {...bind('subject')} required /></Field>
        <Field label="Details"><textarea {...bind('description')} /></Field>
        <button className="btn primary lg" disabled={busy}>Submit</button>
      </form>
    </>
  );
}

function TicketView() {
  const { id } = useParams();
  const d = useLoad(() => api.get(`/api/customer/tickets/${id}`), [id]);
  const [body, setBody] = useState('');
  const [run, busy] = useAction();
  if (d.loading && !d.data) return <><Top title="Ticket" back /><Spinner /></>;
  const t = d.data;
  return (
    <>
      <Top title={t.number} back />
      <div className="m-body">
        <div className="card"><div className="row between"><b>{t.subject}</b><Badge s={t.status} /></div><div className="small">{t.description}</div></div>
        <ul className="timeline">{t.comments.map((c) => <li key={c.id}><b className="small">{c.user_role === 'CUSTOMER' ? 'You' : 'ABC Cargo support'}</b> <span className="tiny muted">{dt(c.created_at)}</span><div>{c.body}</div></li>)}</ul>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write a reply…" />
        <button className="btn primary" disabled={busy || !body.trim()} onClick={() => run(() => api.post(`/api/customer/tickets/${t.id}/comments`, { body })).then(() => { setBody(''); d.reload(true); })}>Send</button>
      </div>
    </>
  );
}

function Account() {
  const { user, logout } = useSession();
  const prof = useLoad(() => api.get('/api/customer/profile'), []);
  const c = prof.data?.customer;
  return (
    <>
      <Top title="Account" />
      <div className="m-body">
        {c && <div className="card"><b>{c.name}</b> <Badge tone={c.type === 'ACCOUNT' ? 'info' : 'muted'}>{c.type === 'ACCOUNT' ? 'Business account' : 'Pay per shipment'}</Badge>
          <div className="small muted">{c.code} · {user.email}</div>
          {c.type === 'ACCOUNT' && <div className="small">Credit limit {aed(c.credit_limit)} · terms {c.payment_terms_days} days</div>}
          {prof.data.stats.cod_pending > 0 && <div className="small">COD awaiting remittance: {aed(prof.data.stats.cod_pending)}</div>}</div>}
        <Link className="btn block" to="/invoices">🧾 Invoices & payments</Link>
        <Link className="btn block" to="/support">🎧 Support tickets</Link>
        <button className="btn ghost block" onClick={logout}>Sign out</button>
      </div>
    </>
  );
}

function Register() {
  const { adopt } = useSession();
  const nav = useNavigate();
  const [v, setV, bind] = useForm({ name: '', company: '', email: '', phone: '', city: '', address: '', password: '', region: 'AE' });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { const r = await api.post('/api/auth/register', { ...v, company: v.company || undefined, address: v.address || undefined, city: v.city || undefined }); await adopt(r.token); nav('/ship'); } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <>
      <Top title="Create account" back />
      <form className="m-body" onSubmit={submit}>
        <ErrorBox error={err} />
        <Field label="Your country"><RegionPicker value={v.region} onChange={(r) => setV((x) => ({ ...x, region: r }))} /></Field>
        <Field label="Full name"><input {...bind('name')} required autoComplete="name" /></Field>
        <Field label="Company (optional)"><input {...bind('company')} autoComplete="organization" /></Field>
        <Field label="Email"><input {...bind('email')} type="email" required autoComplete="email" /></Field>
        <Field label="Mobile"><input {...bind('phone')} type="tel" required autoComplete="tel" placeholder="+971 5x xxx xxxx" /></Field>
        <Field label="Pickup address"><input {...bind('address')} autoComplete="street-address" /></Field>
        <Field label="Password" hint="8+ characters with letters and numbers"><input {...bind('password')} type="password" required autoComplete="new-password" /></Field>
        <button className="btn primary lg" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
      </form>
    </>
  );
}

function RequireUser({ children }) {
  const { user } = useSession();
  if (!user) return <LoginPage />;
  return children;
}
function LoginPage() {
  const { user } = useSession();
  const nav = useNavigate();
  if (user) { setTimeout(() => nav('/'), 0); return null; }
  return <LoginForm title="ABC Cargo" subtitle="UAE · UK · KSA · India — ship worldwide, track, pay" demo={(r) => demoAccount('customer', r)} accent="customer"
    footer={<div className="small center">New here? <Link to="/register">Create an account</Link> · <Link to="/track">Track without login</Link></div>} />;
}

function App() {
  const { user } = useSession();
  if (user === undefined) return <Spinner />;
  return (
    <div className="m-app">
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/track" element={<Track />} />
        <Route path="/track/:awb" element={<Track />} />
        <Route path="/quote" element={<Quote />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<Register />} />
        <Route path="/ship" element={<RequireUser><Ship /></RequireUser>} />
        <Route path="/shipments" element={<RequireUser><Shipments /></RequireUser>} />
        <Route path="/shipments/:awb" element={<RequireUser><ShipmentView /></RequireUser>} />
        <Route path="/invoices" element={<RequireUser><Invoices /></RequireUser>} />
        <Route path="/invoices/:id" element={<RequireUser><InvoiceView /></RequireUser>} />
        <Route path="/support" element={<RequireUser><Support /></RequireUser>} />
        <Route path="/support/new" element={<RequireUser><NewTicket /></RequireUser>} />
        <Route path="/support/:id" element={<RequireUser><TicketView /></RequireUser>} />
        <Route path="/account" element={<RequireUser><Account /></RequireUser>} />
      </Routes>
      <Nav />
    </div>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode><ToastProvider><SessionProvider api={api} app="customer"><HashRouter><App /></HashRouter></SessionProvider></ToastProvider></StrictMode>,
);
