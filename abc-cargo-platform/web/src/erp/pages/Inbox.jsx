// Agent inbox (omnichannel enquiries), lead form, enquiry pipeline and the pickups & deliveries board.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../ctx.js';
import { qs } from '../../shared/api.js';
import { useLoad, useAction, Spinner, ErrorBox, Badge, Field, Empty, Modal, useForm } from '../../shared/ui.jsx';
import { money, dt, ago, SERVICES, REGIONS, telLink, waLink, mapsLink } from '../../shared/format.js';
import { useSession } from '../../shared/session.jsx';

export const CHANNELS = {
  WEBSITE: { label: 'Website', ic: '🌐' }, WHATSAPP: { label: 'WhatsApp', ic: '💬' }, FACEBOOK: { label: 'Facebook', ic: '📘' },
  INSTAGRAM: { label: 'Instagram', ic: '📸' }, LINKEDIN: { label: 'LinkedIn', ic: '💼' }, TIKTOK: { label: 'TikTok', ic: '🎵' },
  EMAIL: { label: 'Email', ic: '✉️' }, PHONE: { label: 'Phone', ic: '📞' }, WALKIN: { label: 'Walk-in', ic: '🚶' }, REFERRAL: { label: 'Referral', ic: '🤝' },
};
export const LEAD_TYPES = { COLLECTION: 'Collection booking', QUOTE: 'Quote request', GENERAL: 'General enquiry', TRACKING: 'Tracking enquiry', COMPLAINT: 'Complaint' };
const ID_TYPES = ['Passport', 'National ID', 'Driving licence', 'Residence permit', 'Emirates ID', 'Iqama', 'Aadhaar'];
const ENQ_TONE = { NEW: 'info', QUOTED: 'accent', BOOKED: 'ok', LOST: 'muted', CLOSED: 'muted' };
const ENQ_LABEL = { NEW: 'New', QUOTED: 'Quoted', BOOKED: 'Booked', LOST: 'Lost', CLOSED: 'Closed' };
const EnqBadge = ({ s }) => <span className={`badge ${ENQ_TONE[s] || ''}`}>{ENQ_LABEL[s] || s}</span>;
const TypeBadge = ({ t }) => <span className="badge bad">{LEAD_TYPES[t] || t}</span>;
const Chan = ({ c }) => <span className="small muted" title={CHANNELS[c]?.label}>{CHANNELS[c]?.ic} {CHANNELS[c]?.label}</span>;
const localNow = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const strip = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v != null));

// ---------------------------------------------------------------- Lead form
export function LeadForm({ initial, onClose, onSaved }) {
  const { user, region: working } = useSession();
  const editing = !!initial?.id;
  const [region, setRegion] = useState(initial?.entity_code || user.entity_code || working || 'AE');
  const [meta, setMeta] = useState(null);
  useEffect(() => { api.get(`/api/public/meta?entity=${region}`).then(setMeta).catch(() => {}); }, [region]);
  const prefix = meta?.entities?.find((x) => x.code === region)?.phone_prefix || '';
  const blank = {
    channel: 'PHONE', lead_type: 'GENERAL', customer_name: '', mobile: '', whatsapp: '', alt_phone: '', email: '', landline: '',
    id_type: '', id_number: '', id_expiry: '', agent_code: '', postcode: '', address1: '', address2: '', address3: '', city: '', district: '', region: '',
    service: '', dest_country: '', dest_city: '', pieces: '', weight_kg: '', contents: '', receiver_name: '', receiver_phone: '', receiver_address: '',
    pickup_date: new Date().toISOString().slice(0, 10), pickup_window: '', description: '',
  };
  const [v, setV, bind] = useForm({ ...blank, ...(initial ? strip(initial) : {}) });
  const [sameWa, setSameWa] = useState(!initial?.whatsapp || initial?.whatsapp === initial?.mobile);
  const [dups, setDups] = useState(null);
  const [err, setErr] = useState(null);
  const [run, busy] = useAction();
  useEffect(() => { if (!editing && prefix) setV((s) => ({ ...s, mobile: s.mobile || prefix, landline: s.landline || '' })); }, [prefix]); // eslint-disable-line react-hooks/exhaustive-deps
  const countries = [{ code: region, name: `${REGIONS[region]?.name} (domestic)` }, ...(meta?.country_list || [])];
  const collection = v.lead_type === 'COLLECTION';
  const checkDups = async () => setDups(await api.get(`/api/inbox/duplicates${qs({ mobile: v.mobile, email: v.email, entity: region })}`));
  const save = async (e) => {
    e.preventDefault();
    setErr(null);
    const body = strip({ ...v, whatsapp: sameWa ? v.mobile : v.whatsapp, entity_code: region });
    for (const k of ['pieces', 'weight_kg']) if (body[k] != null) body[k] = Number(body[k]);
    if (body.landline === prefix) delete body.landline;
    try {
      const out = await run(() => (editing ? api.put(`/api/inbox/${initial.id}`, body) : api.post('/api/inbox', body)),
        editing ? 'Lead saved' : 'Lead created');
      onSaved(out);
    } catch (x) { setErr(x); }
  };
  return (
    <Modal title={editing ? `Lead ${initial.ref}` : 'New lead'} onClose={onClose} wide>
      <form className="stack lead-form" onSubmit={save}>
        <div>
          <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>Came in via</div>
          <div className="chips">{Object.entries(CHANNELS).map(([k, c]) => (
            <button type="button" key={k} className={`chip ${v.channel === k ? 'on' : ''}`} aria-pressed={v.channel === k} onClick={() => setV((s) => ({ ...s, channel: k }))}>{c.ic} {c.label}</button>
          ))}</div>
        </div>
        <div className="grid g4">
          <Field label="Lead number"><input value={initial?.ref || 'AUTO'} disabled /></Field>
          <Field label="Region">{user.entity_code || editing ? <input value={`${REGIONS[region]?.flag} ${REGIONS[region]?.name}`} disabled />
            : <select value={region} onChange={(e) => setRegion(e.target.value)}>{Object.entries(REGIONS).map(([c, r]) => <option key={c} value={c}>{r.flag} {r.name}</option>)}</select>}</Field>
          <Field label="Customer name *"><input {...bind('customer_name')} required maxLength={120} /></Field>
          <Field label="Lead type *"><select {...bind('lead_type')} required>{Object.entries(LEAD_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          <Field label="Mobile *"><input {...bind('mobile')} type="tel" required /></Field>
          <Field label="WhatsApp" hint={<label className="row" style={{ gap: 4 }}><input type="checkbox" checked={sameWa} onChange={(e) => setSameWa(e.target.checked)} /> Same as mobile</label>}>
            <input {...bind('whatsapp')} type="tel" value={sameWa ? v.mobile : v.whatsapp} disabled={sameWa} /></Field>
          <Field label="Alternative number"><input {...bind('alt_phone')} type="tel" /></Field>
          <Field label="Email"><input {...bind('email')} type="email" /></Field>
          <Field label="Landline"><input {...bind('landline')} type="tel" placeholder={prefix} /></Field>
          <Field label="ID type"><select {...bind('id_type')}><option value="">Select ID type</option>{ID_TYPES.map((t) => <option key={t}>{t}</option>)}</select></Field>
          <Field label="ID number"><input {...bind('id_number')} /></Field>
          <Field label="ID expiry"><input {...bind('id_expiry')} type="date" /></Field>
          <Field label="Agent code"><input {...bind('agent_code')} /></Field>
          <Field label="Post code"><input {...bind('postcode')} /></Field>
          <Field label="City"><input {...bind('city')} list="lead-cities" /><datalist id="lead-cities">{(meta?.cities || []).map((c) => <option key={c} value={c} />)}</datalist></Field>
          <Field label="District / county"><input {...bind('district')} /></Field>
          <Field label="Address line one" span={2}><input {...bind('address1')} /></Field>
          <Field label="Address line two"><input {...bind('address2')} /></Field>
          <Field label="Address line three"><input {...bind('address3')} /></Field>
        </div>
        <h3 style={{ margin: '4px 0 0' }}>Shipment request</h3>
        <div className="grid g4">
          <Field label="Service"><select {...bind('service')}><option value="">—</option>{Object.entries(SERVICES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          <Field label="Destination country"><select {...bind('dest_country')}><option value="">—</option>{countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></Field>
          <Field label="Destination city"><input {...bind('dest_city')} /></Field>
          <div className="grid g2"><Field label="Pieces"><input {...bind('pieces', 'number')} min="1" /></Field><Field label="Weight (kg)"><input {...bind('weight_kg', 'number')} min="0.1" /></Field></div>
          <Field label="Contents / notes" span={2}><input {...bind('contents')} /></Field>
          <Field label="Collection date"><input {...bind('pickup_date')} type="date" /></Field>
          <Field label="Time window"><input {...bind('pickup_window')} placeholder="14:00-16:00" /></Field>
          <Field label={`Receiver name${collection ? ' *' : ''}`}><input {...bind('receiver_name')} /></Field>
          <Field label={`Receiver phone${collection ? ' *' : ''}`}><input {...bind('receiver_phone')} type="tel" /></Field>
          <Field label="Receiver address" span={2}><input {...bind('receiver_address')} /></Field>
        </div>
        <Field label="Call description *"><textarea {...bind('description')} required maxLength={2000} /></Field>
        {collection && !editing && <div className="alert info small">Collection bookings with address, service, destination, weight and receiver are <b>booked straight away</b> and auto-assigned to the nearest free driver. Boxes are weighed and priced at collection.</div>}
        {dups && <div className="alert warn small">{dups.enquiries.length || dups.customers.length
          ? <>Possible duplicates: {dups.customers.map((c) => <span key={`c${c.id}`}>customer <b>{c.name}</b> ({c.code}) · </span>)}{dups.enquiries.map((x) => <span key={x.id}><b>{x.ref}</b> {x.customer_name} ({ENQ_LABEL[x.status]}) · </span>)}</>
          : 'No duplicates found.'}</div>}
        <ErrorBox error={err} />
        <div className="row between">
          <button type="button" className="btn" onClick={checkDups}>Check for duplicates</button>
          <div className="row"><button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : editing ? 'Save lead' : collection ? 'Save & book collection' : 'Save lead'}</button></div>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- Incoming contact (PABX / WhatsApp / email)
function IncomingModal({ channel, onClose, onDone }) {
  const { user, region } = useSession();
  const [v, , bind] = useForm({ from: '', name: '', body: '' });
  const [ent, setEnt] = useState(user.entity_code || region || 'AE');
  const [run, busy] = useAction();
  const label = { PHONE: 'Incoming call (PABX)', WHATSAPP: 'Incoming WhatsApp', EMAIL: 'Incoming email' }[channel];
  return (
    <Modal title={label} onClose={onClose}>
      <form className="stack" onSubmit={async (e) => { e.preventDefault(); onDone(await run(() => api.post('/api/inbox/incoming', { channel, ...strip(v), entity_code: ent }), 'Logged to inbox')); }}>
        {!user.entity_code && <Field label="Region"><select value={ent} onChange={(e) => setEnt(e.target.value)}>{Object.entries(REGIONS).map(([c, r]) => <option key={c} value={c}>{r.flag} {r.name}</option>)}</select></Field>}
        <div className="grid g2">
          <Field label={channel === 'EMAIL' ? 'From email *' : 'Caller number *'}><input {...bind('from')} type={channel === 'EMAIL' ? 'email' : 'tel'} required autoFocus /></Field>
          <Field label="Name (if known)"><input {...bind('name')} /></Field>
        </div>
        <Field label={channel === 'PHONE' ? 'Call notes *' : 'Message *'}><textarea {...bind('body')} required /></Field>
        <div className="tiny muted">Calls and messages from the same number thread into the caller's open enquiry. Live PABX / WhatsApp Business / mailbox connectors post to the same endpoint.</div>
        <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" disabled={busy}>Log to inbox</button></div>
      </form>
    </Modal>
  );
}

function PromptModal({ title, label, type = 'text', options, initial = '', onClose, onSubmit, submit = 'Save' }) {
  const [val, setVal] = useState(initial);
  return (
    <Modal title={title} onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); onSubmit(val); }}>
        <Field label={label}>{options
          ? <select value={val} onChange={(e) => setVal(e.target.value)} required><option value="">—</option>{options.map((o) => <option key={o}>{o}</option>)}</select>
          : <input type={type} value={val} onChange={(e) => setVal(e.target.value)} required autoFocus />}</Field>
        <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary">{submit}</button></div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- Agent inbox
export function AgentInbox() {
  const nav = useNavigate();
  const { region } = useSession();
  const [sp, setSp] = useSearchParams();
  const sel = Number(sp.get('id')) || null;
  const [view, setView] = useState('open');
  const [q, setQ] = useState('');
  const [modal, setModal] = useState(null);
  const list = useLoad(() => api.get(`/api/inbox${qs({ view, q: q || undefined, limit: 100 })}`), [view, q, region], { interval: 30000 });
  const cur = useLoad(() => (sel ? api.get(`/api/inbox/${sel}`) : Promise.resolve(null)), [sel]);
  const [run, busy] = useAction();
  const [reply, setReply] = useState('');
  const [note, setNote] = useState(false);
  const threadRef = useRef(null);
  const pick = (id) => setSp(id ? { id: String(id) } : {});
  useEffect(() => { if (!sel && list.data?.rows?.length) pick(list.data.rows[0].id); }, [list.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { threadRef.current?.scrollTo?.({ top: 1e6 }); }, [cur.data]);
  const refresh = (e) => { if (e?.id && e.id !== sel) pick(e.id); else cur.reload(true); list.reload(true); };
  const act = async (path, body, ok) => refresh(await run(() => api.post(`/api/inbox/${sel}/${path}`, body || {}), ok));
  const e = cur.data;
  const open = e && ['NEW', 'QUOTED'].includes(e.status);
  return (
    <>
      <div className="page-head">
        <h1 className="ttl">Agent inbox</h1>
        <div className="row">
          <button className="btn" onClick={() => setModal({ incoming: 'PHONE' })}>📞 Incoming call (PABX)</button>
          <button className="btn" onClick={() => setModal({ incoming: 'WHATSAPP' })}>💬 Incoming WhatsApp</button>
          <button className="btn" onClick={() => setModal({ incoming: 'EMAIL' })}>✉️ Incoming email</button>
          <button className="btn primary" onClick={() => setModal({ lead: {} })}>+ New lead</button>
        </div>
      </div>
      <div className="inbox card flat">
        <aside className="ib-list">
          <div className="ib-search">
            <input placeholder="Name, phone, email, ref, AWB" value={q} onChange={(x) => setQ(x.target.value)} aria-label="Search enquiries" />
            <div className="seg sm" role="tablist">{[['open', 'Open'], ['mine', 'Mine'], ['booked', 'Booked'], ['lost', 'Closed'], ['all', 'All']].map(([k, l]) => (
              <button key={k} role="tab" aria-selected={view === k} className={view === k ? 'on' : ''} onClick={() => setView(k)}>{l}</button>))}</div>
          </div>
          {list.loading && !list.data ? <Spinner /> : !list.data?.rows.length ? <Empty>No enquiries.</Empty> : list.data.rows.map((r) => (
            <button key={r.id} className={`ib-item ${r.id === sel ? 'on' : ''}`} onClick={() => pick(r.id)}>
              <div className="row between nowrap"><b className="ellipsis">{CHANNELS[r.channel]?.ic} {r.customer_name}</b><span className="tiny muted">{ago(r.last_at || r.created_at)}</span></div>
              <div className="tiny muted ellipsis">{r.last_message}</div>
              <div className="row" style={{ gap: 4, marginTop: 4 }}><EnqBadge s={r.status} />{r.overdue ? <span className="badge bad">Action overdue</span> : null}
                <span className="tiny muted spacer right">{r.awb || r.quotation_number || r.ref}</span></div>
            </button>
          ))}
        </aside>
        <section className="ib-thread">
          {!e ? (cur.loading ? <Spinner /> : <Empty>Select an enquiry.</Empty>) : (
            <>
              <div className="ib-head">
                <div><div className="row" style={{ gap: 8 }}><h2 style={{ margin: 0 }}>{e.customer_name}</h2><span className="tiny muted">{e.ref}</span></div>
                  <div className="row" style={{ gap: 6, marginTop: 4 }}><Chan c={e.channel} /><EnqBadge s={e.status} /><TypeBadge t={e.lead_type} />
                    {e.overdue ? <span className="badge bad">Action overdue</span> : null}{e.next_action_at && <span className="badge warn">⏰ {e.next_action_at}</span>}</div></div>
                <span className="small muted">{e.owner_name ? `Owner: ${e.owner_name}` : ''}</span>
              </div>
              <div className="ib-msgs" ref={threadRef}>
                {e.messages.map((m) => (
                  <div key={m.id} className={`msg ${m.direction.toLowerCase()}`}>
                    <div>{m.body}</div>
                    <div className="tiny muted">{m.direction === 'NOTE' ? '🔒 Internal note · ' : ''}{m.user_name || (m.direction === 'IN' ? e.customer_name : 'System')} · {dt(m.created_at)}</div>
                  </div>
                ))}
              </div>
              <div className="ib-actions">
                <span className="small muted">{open ? 'Open lead — take the next action or close it' : `This enquiry is ${ENQ_LABEL[e.status].toLowerCase()}`}</span>
                {open && <>
                  <button className="btn primary sm" disabled={busy} onClick={() => act('book', {}, 'Collection booked')}>🚚 Book collection</button>
                  <button className="btn sm" onClick={() => nav(`/quotations/new?enquiry=${e.id}`)}>💬 Create quote</button>
                  <button className="btn sm" onClick={() => setModal({ callback: true })}>⏰ Set callback</button>
                  <button className="btn sm" onClick={() => setModal({ lost: true })}>Mark lost</button>
                  <button className="btn sm" onClick={() => act('close', {}, 'Enquiry closed')}>Close</button>
                </>}
                {['LOST', 'CLOSED'].includes(e.status) && <button className="btn sm" onClick={() => act('reopen', {}, 'Reopened')}>Reopen</button>}
                <button className="btn sm" onClick={() => setModal({ lead: e })}>Edit lead</button>
              </div>
              <form className="ib-reply" onSubmit={async (x) => { x.preventDefault(); if (!reply.trim()) return; await act('messages', { body: reply, note }, note ? 'Note added' : 'Reply logged'); setReply(''); }}>
                <label className="row tiny" style={{ gap: 4 }}><input type="checkbox" checked={note} onChange={(x) => setNote(x.target.checked)} /> Internal note</label>
                <input value={reply} onChange={(x) => setReply(x.target.value)} placeholder={note ? 'Internal note (not sent to customer)' : `Reply via ${CHANNELS[e.channel]?.label}`} aria-label="Reply" />
                <button className="btn primary" disabled={busy}>Send</button>
              </form>
            </>
          )}
        </section>
        <aside className="ib-side">
          {e && <>
            <div className="ib-sec"><div className="sec-t">Customer</div>
              <div className="row nowrap"><span className="avatar">{e.customer_name[0]}</span><div><b>{e.customer_name}</b><div className="tiny muted">{e.customer_code ? `Customer ${e.customer_code}` : 'Private customer'}</div></div></div>
              <div className="small" style={{ marginTop: 8 }}><a href={telLink(e.mobile)}>{e.mobile}</a>{e.whatsapp && <> · <a href={waLink(e.whatsapp, `Hello ${e.customer_name}, ABC Cargo here about ${e.ref}.`)} target="_blank" rel="noreferrer">WhatsApp</a></>}</div>
              {e.email && <div className="small"><a href={`mailto:${e.email}`}>{e.email}</a></div>}
              {e.id_type && <div className="tiny muted">{e.id_type} {e.id_number}{e.id_expiry ? ` · exp ${e.id_expiry}` : ''}</div>}
              <button className="btn sm" style={{ marginTop: 8 }} onClick={() => setModal({ lead: e })}>Open lead form</button></div>
            <div className="ib-sec"><div className="sec-t">Collection point</div>
              {e.address1 ? <><div className="small">{[e.address1, e.address2, e.address3].filter(Boolean).join(', ')}</div><div className="small">{[e.city, e.district, e.postcode].filter(Boolean).join(' · ')}</div>
                {e.lat ? <a className="small" href={mapsLink(e.lat, e.lng)} target="_blank" rel="noreferrer">📍 Open verified pin</a> : <div className="tiny muted">No verified GPS position — dispatcher uses the city centre until the driver confirms.</div>}</>
                : <div className="small muted">No address yet</div>}
              {e.pickup_date && <div className="tiny muted">Collection {e.pickup_date} {e.pickup_window || ''}</div>}</div>
            <div className="ib-sec"><div className="sec-t">Shipment request</div>
              <div className="small">{e.service ? SERVICES[e.service] : '—'}</div>
              <div className="small">{e.dest_city || '—'}{e.dest_country ? `, ${e.dest_country}` : ''} · {e.pieces || '—'} pcs · {e.weight_kg || '—'} kg</div>
              {e.contents && <div className="tiny muted">{e.contents}</div>}
              {e.receiver_name && <div className="tiny">To: {e.receiver_name} {e.receiver_phone}</div>}
              {e.shipment && <div className="stack" style={{ gap: 4, marginTop: 8 }}><Link to={`/shipments/${e.shipment.id}`} className="mono">{e.shipment.awb}</Link>
                <div className="row" style={{ gap: 6 }}><Badge s={e.shipment.status} /><span className="small">{money(e.shipment.total_charge, e.shipment.currency)}</span></div>
                {e.shipment.driver_name && <div className="tiny muted">Driver: {e.shipment.driver_name}</div>}</div>}
              {e.quotation_number && <div className="small" style={{ marginTop: 6 }}>Quote <Link to={`/quotations/${e.quotation_id}`}>{e.quotation_number}</Link> · <Badge s={e.quotation_status} /></div>}</div>
            <div className="ib-sec"><div className="sec-t">Journey</div>
              <ul className="timeline">{e.messages.filter((m) => m.direction === 'SYSTEM').map((m) => <li key={m.id}><div className="small">{m.body}</div><div className="tiny muted">{dt(m.created_at)}</div></li>)}</ul></div>
            <div className="ib-sec"><div className="sec-t">History</div>
              {e.history.length ? e.history.map((h) => <button key={h.id} className="btn ghost sm" onClick={() => pick(h.id)}>{h.ref} · {LEAD_TYPES[h.lead_type]} · {ENQ_LABEL[h.status]}</button>) : <div className="tiny muted">No earlier enquiries from this number.</div>}</div>
          </>}
        </aside>
      </div>
      {modal?.lead && <LeadForm initial={modal.lead.id ? modal.lead : null} onClose={() => setModal(null)} onSaved={(out) => { setModal(null); refresh(out); }} />}
      {modal?.incoming && <IncomingModal channel={modal.incoming} onClose={() => setModal(null)} onDone={(out) => { setModal(null); setView('open'); refresh(out); }} />}
      {modal?.callback && <PromptModal title="Set callback" label="Call back at" type="datetime-local" initial={localNow()} onClose={() => setModal(null)} onSubmit={async (at) => { setModal(null); await act('callback', { at }, 'Callback set'); }} />}
      {modal?.lost && <PromptModal title="Mark lost" label="Reason" options={['Price too high', 'Chose another courier', 'Service not offered', 'No response', 'Duplicate enquiry', 'Other']} onClose={() => setModal(null)} onSubmit={async (reason) => { setModal(null); await act('lost', { reason }, 'Marked lost'); }} />}
    </>
  );
}

// ---------------------------------------------------------------- Enquiry pipeline
export function EnquiryPipeline() {
  const nav = useNavigate();
  const { region } = useSession();
  const [channel, setChannel] = useState('');
  const [modal, setModal] = useState(false);
  const stats = useLoad(() => api.get('/api/inbox/stats'), [region]);
  const list = useLoad(() => api.get(`/api/inbox${qs({ view: 'all', channel: channel || undefined, limit: 200 })}`), [channel, region]);
  const cur = REGIONS[region]?.currency;
  const s = stats.data || {};
  const cols = [['NEW', 'New enquiries', 'Book the collection, or quote if asked'], ['QUOTED', 'Quoted', 'Direct quotation — waiting for customer'],
    ['BOOKED', 'Booked · collection scheduled', 'Driver auto-assigned'], ['LOST', 'Lost', 'With reason']];
  const by = useMemo(() => {
    const m = { NEW: [], QUOTED: [], BOOKED: [], LOST: [] };
    for (const r of list.data?.rows || []) (m[r.status === 'CLOSED' ? 'LOST' : r.status] || []).push(r);
    return m;
  }, [list.data]);
  return (
    <>
      <div className="page-head">
        <div><h1 className="ttl">Enquiry pipeline</h1><div className="small muted">Every enquiry from every channel in one place. A collection is booked straight away — quotes only when the customer asks for a price.</div></div>
        <div className="row"><Link className="btn" to="/pickups">Pickups &amp; deliveries</Link><button className="btn primary" onClick={() => setModal(true)}>+ New lead</button></div>
      </div>
      <div className="grid g4">
        <div className="card kpi solid"><span className="l">New enquiries</span><span className="v">{s.new_count ?? '—'}</span><span className="small">Waiting to be booked or quoted</span></div>
        <div className="card kpi"><span className="l">Quotes out</span><span className="v">{cur ? money(s.quotes_value || 0, cur) : '—'}</span><span className="small muted">{s.quoted || 0} open quotes · direct quotation only</span></div>
        <div className="card kpi"><span className="l">Booked today</span><span className="v">{s.booked_today || 0}</span><span className="small muted">{cur ? `${money(s.booked_value || 0, cur)} rate-card estimate` : 'collections booked'}</span></div>
        <div className="card kpi"><span className="l">Win rate</span><span className="v">{s.win_rate != null ? `${s.win_rate}%` : '—'}</span><span className="small muted">Booked vs lost</span></div>
      </div>
      <div className="card"><div className="sec-t">How it works</div>
        <div className="grid g4 steps">
          {[['Enquiry arrives', 'PABX call, WhatsApp, social, email, web or walk-in'], ['Lead type decides', 'Collection → book now · Price only → direct quotation'],
            ['Collection booked', 'No quote — boxes weighed and priced at collection'], ['Driver auto-assigned', 'Nearest free driver, run re-planned']].map(([t, d], i) => (
            <div key={t} className="step"><span className="n">{i + 1}</span><div><b>{t}</b><div className="tiny muted">{d}</div></div></div>))}
        </div></div>
      <div className="chips"><button className={`chip ${!channel ? 'on' : ''}`} onClick={() => setChannel('')}>All</button>
        {Object.entries(CHANNELS).map(([k, c]) => <button key={k} className={`chip ${channel === k ? 'on' : ''}`} onClick={() => setChannel(k)}>{c.label} {s.by_channel?.find((x) => x.channel === k)?.n ? <span className="tiny">({s.by_channel.find((x) => x.channel === k).n})</span> : null}</button>)}</div>
      <ErrorBox error={list.error} />
      <div className="kanban k4">
        {cols.map(([k, t, d]) => (
          <div key={k} className="colm"><div className="row between"><div><div className="sec-t" style={{ margin: 0 }}>{t}</div><div className="tiny muted">{d}</div></div><span className="small">{by[k].length}</span></div>
            {by[k].map((r) => (
              <div key={r.id} className="lead">
                <div className="row between nowrap"><Chan c={r.channel} /><span className="tiny muted">{r.ref}</span></div>
                <b>{r.customer_name}</b><div className="tiny muted">{r.mobile}</div>
                <div className="row" style={{ gap: 4, marginTop: 4 }}><TypeBadge t={r.lead_type} />{r.overdue ? <span className="badge bad">Action overdue</span> : null}
                  {r.awb && <span className="badge ok">{r.awb}</span>}{r.lost_reason && <span className="tiny muted">{r.lost_reason}</span>}</div>
                <div className="right" style={{ marginTop: 6 }}><button className="btn sm" onClick={() => nav(`/inbox?id=${r.id}`)}>Open</button></div>
              </div>))}
          </div>))}
      </div>
      {modal && <LeadForm onClose={() => setModal(false)} onSaved={(out) => { setModal(false); nav(`/inbox?id=${out.id}`); }} />}
    </>
  );
}

// ---------------------------------------------------------------- Pickups & deliveries board
export function PickupsBoard() {
  const { region } = useSession();
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const board = useLoad(() => api.get(`/api/pickups${qs({ date })}`), [date, region], { interval: 30000 });
  const [run, busy] = useAction();
  const [modal, setModal] = useState(null);
  const act = async (id, path, body, ok) => { await run(() => api.post(`/api/pickups/${id}/${path}`, body || {}), ok); board.reload(); };
  const b = board.data;
  const Card = ({ s, col }) => (
    <div className="lead">
      <div className="tiny"><b>{s.pickup_date}{s.pickup_window ? ` · ${s.pickup_window}` : ''}</b>{s.overdue ? <span className="badge bad" style={{ marginLeft: 6 }}>Overdue</span> : null}</div>
      <b>{s.customer_name}</b>
      <div className="tiny muted">{s.shipper_address}</div>
      <div className="tiny"><Link to={`/shipments/${s.id}`} className="mono">{s.awb}</Link>{s.enquiry_ref && <> · <Link to={`/inbox?id=${s.enquiry_id}`}>{s.enquiry_ref}</Link></>}</div>
      <div className="tiny">{s.pieces} pcs · {s.driver_name || <span className="badge warn">No driver</span>}</div>
      {s.pickup_missed_reason && <div className="tiny" style={{ color: 'var(--bad)' }}>Missed: {s.pickup_missed_reason}</div>}
      <div className="row" style={{ gap: 4, marginTop: 6 }}>
        {(col === 'scheduled' || col === 'missed') && !s.driver_id && <button className="btn sm primary" disabled={busy} onClick={() => act(s.id, 'assign', {}, 'Nearest driver assigned')}>Assign nearest</button>}
        {col === 'scheduled' && s.driver_id && <button className="btn sm" disabled={busy} onClick={() => act(s.id, 'start', {}, 'Driver en route')}>Start</button>}
        {col === 'en_route' && <><button className="btn sm primary" disabled={busy} onClick={() => act(s.id, 'collected', {}, 'Collected')}>Collected</button>
          <button className="btn sm" onClick={() => setModal({ missed: s })}>Failed</button></>}
        {col !== 'completed' && <><button className="btn sm" onClick={() => setModal({ postpone: s })}>Postpone</button>
          <button className="btn sm" onClick={() => setModal({ cancel: s })}>Cancel booking</button></>}
      </div>
    </div>
  );
  return (
    <>
      <div className="page-head">
        <div><h1 className="ttl">Pickups &amp; deliveries</h1><div className="small muted">Every collection by time window, live from the driver app.</div></div>
        <div className="row"><label className="row small">Service date <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: 'auto' }} /></label>
          <Link className="btn" to="/dispatch">🗺️ Routing &amp; GPS</Link><Link className="btn primary" to="/inbox">+ Schedule pickup</Link></div>
      </div>
      <ErrorBox error={board.error} />
      {!b ? <Spinner /> : (
        <div className="kanban k4">
          {[['scheduled', 'Scheduled'], ['en_route', 'En route'], ['completed', 'Completed'], ['missed', 'Missed']].map(([k, t]) => (
            <div key={k} className="colm"><div className="row between"><div className="sec-t" style={{ margin: 0 }}>{t}</div><span className="small">{b[k].length}</span></div>
              {b[k].length ? b[k].map((s) => <Card key={s.id} s={s} col={k} />) : <div className="tiny muted">Nothing here.</div>}
            </div>))}
        </div>
      )}
      {modal?.missed && <PromptModal title={`Failed collection · ${modal.missed.awb}`} label="Reason" options={b.reasons} onClose={() => setModal(null)} onSubmit={async (reason) => { const id = modal.missed.id; setModal(null); await act(id, 'missed', { reason }, 'Marked missed — back to dispatch'); }} />}
      {modal?.postpone && <PromptModal title={`Postpone · ${modal.postpone.awb}`} label="New collection date" type="date" initial={date} onClose={() => setModal(null)} onSubmit={async (d) => { const id = modal.postpone.id; setModal(null); await act(id, 'postpone', { date: d }, 'Postponed'); }} />}
      {modal?.cancel && <PromptModal title={`Cancel booking · ${modal.cancel.awb}`} label="Reason" options={['Customer cancelled', 'Duplicate booking', 'Booked in error', 'Other']} submit="Cancel booking" onClose={() => setModal(null)} onSubmit={async (reason) => { const id = modal.cancel.id; setModal(null); await act(id, 'cancel', { reason }, 'Booking cancelled'); }} />}
    </>
  );
}
