// International air courier & air cargo: export queue, customs, air manifests (MAWB), flights, agents, country duties.
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, useMeta } from '../ctx.js';
import { qs } from '../../shared/api.js';
import { useLoad, useAction, Spinner, ErrorBox, Badge, Modal, Field, Empty, useForm, Stat } from '../../shared/ui.jsx';
import { aed, dt, dOnly, SERVICES } from '../../shared/format.js';
import { useSession } from '../../shared/session.jsx';
import { Barcode } from '../../shared/devices.jsx';

const STAGES = [['', 'Open (all)'], ['pre_hub', 'Awaiting pickup / hub'], ['ready', 'At hub — ready to manifest'], ['in_flight', 'Manifested / in flight'], ['destination', 'At destination'], ['all', 'All incl. delivered']];

export function IntlOverview() {
  const sum = useLoad(() => api.get('/api/intl/summary'), [], { interval: 60000 });
  const [stage, setStage] = useState('');
  const [customs, setCustoms] = useState('');
  const q = useLoad(() => api.get(`/api/intl/exports${qs({ stage, customs_status: customs })}`), [stage, customs]);
  const [items, setItems] = useState(null);
  const [run, busy] = useAction();
  const s = sum.data;
  const setCustomsStatus = (row, st) => {
    const ref = st === 'SUBMITTED' ? prompt('Export declaration number (optional):') ?? undefined : undefined;
    const note = st === 'HOLD' ? prompt('Reason / documents requested:') ?? undefined : undefined;
    run(() => api.post(`/api/intl/shipments/${row.id}/customs`, { customs_status: st, customs_ref: ref || undefined, note }), 'Customs status updated').then(() => { q.reload(true); sum.reload(true); });
  };
  return (
    <>
      <div className="page-head"><h1>International — exports & customs</h1>
        <div className="row"><Link className="btn" to="/intl/manifests">✈️ Air manifests</Link><Link className="btn" to="/intl/countries">🌍 Countries & duties</Link></div></div>
      {s && (
        <div className="grid g4">
          <Stat label="Docs pending (customs)" value={s.docs_pending} alert={s.docs_pending > 0} sub="Commercial invoice / HS codes" />
          <Stat label="At hub — ready to manifest" value={s.ready_to_manifest} />
          <Stat label="Manifested / in flight" value={s.in_flight} sub={`${s.open_manifests} open manifests`} />
          <Stat label="Customs holds" value={s.customs_hold} alert={s.customs_hold > 0} sub={`${s.at_destination} at destination`} />
        </div>
      )}
      {s?.by_country?.length > 0 && (
        <div className="card"><h3>Top destinations (30 days)</h3>
          <div className="table-wrap"><table><thead><tr><th>Country</th><th>Zone</th><th className="num">Shipments</th><th className="num">Kg</th><th className="num">Revenue</th></tr></thead>
            <tbody>{s.by_country.map((c) => <tr key={c.code}><td><b>{c.name}</b> <span className="muted small">{c.code}</span></td><td>{c.zone}</td><td className="num">{c.shipments}</td><td className="num">{c.kg}</td><td className="num">{aed(c.revenue)}</td></tr>)}</tbody></table></div></div>
      )}
      <div className="filters">
        <Field label="Stage"><select value={stage} onChange={(e) => setStage(e.target.value)}>{STAGES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Customs"><select value={customs} onChange={(e) => setCustoms(e.target.value)}><option value="">Any</option>{['PENDING', 'DOCS_OK', 'SUBMITTED', 'HOLD', 'CLEARED'].map((x) => <option key={x}>{x}</option>)}</select></Field>
      </div>
      <ErrorBox error={q.error} />
      {q.loading && !q.data ? <Spinner /> : (
        <div className="table-wrap"><table>
          <thead><tr><th>AWB</th><th>Status</th><th>Destination</th><th>Customer → consignee</th><th>Service</th><th className="num">Pcs / kg</th><th className="num">Value</th><th>Terms</th><th>Customs</th><th>Manifest</th><th /></tr></thead>
          <tbody>{q.data?.map((r) => (
            <tr key={r.id}>
              <td><Link to={`/shipments/${r.id}`} className="mono"><b>{r.awb}</b></Link>{r.dangerous_goods ? <Badge tone="bad">DG</Badge> : null}</td><td><Badge s={r.status} /></td>
              <td><b>{r.dest_airport || r.dest_country}</b> <span className="small">{r.dest_city}, {r.country_name}</span></td>
              <td className="small">{r.customer_name}<br />→ {r.consignee_name}</td><td className="small">{SERVICES[r.service]}<div className="tiny muted">{r.product}</div></td>
              <td className="num">{r.pieces} / {r.chargeable_weight}</td><td className="num">{r.customs_value} {r.currency}</td><td>{r.incoterm}</td>
              <td><Badge s={r.customs_status} />{r.customs_ref && <div className="tiny mono">{r.customs_ref}</div>}</td>
              <td className="small">{r.manifest_id ? <Link to={`/intl/manifests/${r.manifest_id}`}>{r.manifest_number}</Link> : '—'}</td>
              <td className="right" style={{ whiteSpace: 'nowrap' }}>
                {r.product !== 'DOCUMENT' && !['DEPARTED', 'ARRIVED', 'WITH_AGENT', 'DELIVERED'].includes(r.status) && <button className="btn sm" onClick={() => setItems(r)}>Invoice lines</button>}
                {r.customs_status === 'DOCS_OK' && <button className="btn sm" disabled={busy} onClick={() => setCustomsStatus(r, 'SUBMITTED')}>Declare</button>}
                {['PENDING', 'DOCS_OK', 'SUBMITTED'].includes(r.customs_status) && <button className="btn sm ghost" disabled={busy} onClick={() => setCustomsStatus(r, 'HOLD')}>Hold</button>}
                {r.customs_status === 'HOLD' && <button className="btn sm ok" disabled={busy} onClick={() => setCustomsStatus(r, r.status === 'CUSTOMS_HOLD' ? 'CLEARED' : 'DOCS_OK')}>Release</button>}
              </td>
            </tr>))}</tbody>
        </table>{!q.data?.length && <Empty>No international shipments in this stage.</Empty>}</div>
      )}
      {items && <ItemsModal row={items} onClose={() => setItems(null)} onDone={() => { setItems(null); q.reload(true); sum.reload(true); }} />}
    </>
  );
}

function ItemsModal({ row, onClose, onDone }) {
  const d = useLoad(() => api.get(`/api/shipments/${row.id}`), [row.id]);
  if (d.loading) return <Modal title="Commercial invoice" onClose={onClose}><Spinner /></Modal>;
  return <ItemsEditor s={d.data} onClose={onClose} onDone={onDone} />;
}

export function ItemsEditor({ s, onClose, onDone }) {
  const [items, setItems] = useState(s.items.length ? s.items.map(({ description, hs_code, qty, unit_value, origin_country }) => ({ description, hs_code: hs_code || '', qty, unit_value, origin_country })) : [{ description: '', hs_code: '', qty: 1, unit_value: 0, origin_country: 'AE' }]);
  const [run, busy] = useAction();
  const set = (i, k, v) => setItems(items.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const total = items.reduce((a, i) => a + Number(i.qty) * Number(i.unit_value), 0);
  return (
    <Modal title={`Commercial invoice — ${s.awb}`} onClose={onClose} wide
      footer={<button className="btn primary" disabled={busy} onClick={() => run(() => api.put(`/api/intl/shipments/${s.id}/items`, { items: items.map((i) => ({ ...i, qty: Number(i.qty), unit_value: Number(i.unit_value), hs_code: i.hs_code || undefined })) }), 'Commercial invoice saved').then(onDone)}>Save · {total.toFixed(2)} {s.currency}</button>}>
      <table><thead><tr><th>Description</th><th>HS code</th><th>Qty</th><th>Unit value</th><th>Origin</th><th /></tr></thead>
        <tbody>{items.map((it, i) => <tr key={i}>
          <td><input value={it.description} onChange={(e) => set(i, 'description', e.target.value)} /></td>
          <td><input value={it.hs_code} onChange={(e) => set(i, 'hs_code', e.target.value)} placeholder="6–10 digits" style={{ width: 120 }} /></td>
          <td><input type="number" value={it.qty} onChange={(e) => set(i, 'qty', e.target.value)} style={{ width: 80 }} /></td>
          <td><input type="number" step="any" value={it.unit_value} onChange={(e) => set(i, 'unit_value', e.target.value)} style={{ width: 110 }} /></td>
          <td><input value={it.origin_country} maxLength={2} onChange={(e) => set(i, 'origin_country', e.target.value.toUpperCase())} style={{ width: 60 }} /></td>
          <td><button className="btn sm ghost" disabled={items.length === 1} onClick={() => setItems(items.filter((_, j) => j !== i))}>✕</button></td></tr>)}</tbody></table>
      <button className="btn sm" style={{ marginTop: 8 }} onClick={() => setItems([...items, { description: '', hs_code: '', qty: 1, unit_value: 0, origin_country: 'AE' }])}>+ Line</button>
    </Modal>
  );
}

export function Manifests() {
  const nav = useNavigate();
  const { user } = useSession();
  const [st, setSt] = useState('OPEN,CLOSED,DEPARTED,ARRIVED');
  const list = useLoad(() => api.get(`/api/intl/manifests?status=${st}`), [st]);
  const [creating, setCreating] = useState(false);
  return (
    <>
      <div className="page-head"><div><Link to="/intl" className="small">‹ International</Link><h1>Air & sea manifests (consolidations)</h1></div>
        <div className="row"><select value={st} onChange={(e) => setSt(e.target.value)} style={{ width: 200 }}><option value="OPEN,CLOSED,DEPARTED,ARRIVED">Active</option><option value="CLEARED,DELIVERED">Completed</option><option value="OPEN,CLOSED,DEPARTED,ARRIVED,CLEARED,DELIVERED">All</option></select>
          {['ADMIN', 'OPS'].includes(user.role) && <button className="btn primary" onClick={() => setCreating(true)}>+ New manifest</button>}</div></div>
      {list.loading && !list.data ? <Spinner /> : (
        <div className="table-wrap"><table><thead><tr><th>Manifest</th><th>Mode</th><th>Route</th><th>Flight</th><th>MAWB</th><th>Agent</th><th className="num">AWBs</th><th className="num">Pcs</th><th className="num">Chg kg</th><th>Status</th></tr></thead>
          <tbody>{list.data?.map((m) => <tr key={m.id} className="clickable" onClick={() => nav(`/intl/manifests/${m.id}`)}>
            <td className="mono"><b>{m.number}</b></td><td>{m.mode === 'AIR_CARGO' ? 'Air cargo' : 'Air courier'}</td><td><b>{m.origin_airport} → {m.dest_airport}</b></td>
            <td>{m.airline} {m.flight_no}<div className="tiny muted">{dOnly(m.flight_date)}</div></td><td className="mono small">{m.mawb_no || '—'}</td><td className="small">{m.agent_name || '—'}</td>
            <td className="num">{m.shipments}</td><td className="num">{m.pieces}</td><td className="num">{m.chargeable}</td><td><Badge tone={{ OPEN: 'warn', CLOSED: 'info', DEPARTED: 'info', ARRIVED: 'accent', CLEARED: 'ok', DELIVERED: 'ok' }[m.status]}>{m.status}</Badge></td></tr>)}</tbody></table>
          {!list.data?.length && <Empty>No manifests.</Empty>}</div>
      )}
      {creating && <ManifestModal onClose={() => setCreating(false)} onDone={(m) => nav(`/intl/manifests/${m.id}`)} />}
    </>
  );
}

function ManifestModal({ m = {}, onClose, onDone }) {
  const meta = useLoad(() => api.get('/api/intl/meta'), []);
  const [v, , bind] = useForm({ mode: 'AIR_COURIER', dest_airport: '', airline: '', flight_no: '', flight_date: '', mawb_no: '', agent_id: '', notes: '', vessel: '', container_no: '', ...m });
  const [run, busy] = useAction();
  const editing = !!m.id;
  const save = () => {
    const body = Object.fromEntries(Object.entries(v).filter(([k, x]) => x !== '' && x != null && ['mode', 'dest_airport', 'airline', 'flight_no', 'flight_date', 'mawb_no', 'agent_id', 'notes', 'vessel', 'container_no'].includes(k)));
    if (body.agent_id) body.agent_id = Number(body.agent_id);
    if (editing) { delete body.mode; delete body.dest_airport; }
    return run(() => (editing ? api.patch(`/api/intl/manifests/${m.id}`, body) : api.post('/api/intl/manifests', body)), 'Manifest saved').then(onDone);
  };
  const intlAirports = meta.data?.airports.filter((a) => a.country !== 'AE') || [];
  return (
    <Modal title={editing ? `Flight & MAWB — ${m.number}` : 'New air manifest'} onClose={onClose} footer={<button className="btn primary" disabled={busy || (!editing && !v.dest_airport)} onClick={save}>Save</button>}>
      <div className="grid g2">
        {!editing && <Field label="Mode"><select {...bind('mode')}><option value="AIR_COURIER">Air courier (express consolidation)</option><option value="AIR_CARGO">Air cargo (incl. DG)</option><option value="SEA_CONSOL">Sea cargo consolidation (container)</option></select></Field>}
        {!editing && <Field label={v.mode === 'SEA_CONSOL' ? 'Destination sea port' : 'Destination airport'}><select {...bind('dest_airport')}><option value="">Select…</option>
          {intlAirports.filter((a) => (v.mode === 'SEA_CONSOL' ? a.kind === 'SEA' : a.kind !== 'SEA')).map((a) => <option key={a.code} value={a.code}>{a.code} — {a.city} ({a.country})</option>)}</select></Field>}
        {v.mode === 'SEA_CONSOL' && <><Field label="Vessel"><input {...bind('vessel')} /></Field><Field label="Container no."><input {...bind('container_no')} /></Field></>}
        <Field label="Airline"><input {...bind('airline')} placeholder="e.g. Emirates SkyCargo" /></Field>
        <Field label={v.mode === 'SEA_CONSOL' ? 'Voyage no.' : 'Flight no.'}><input {...bind('flight_no')} placeholder={v.mode === 'SEA_CONSOL' ? '024W' : 'EK123'} /></Field>
        <Field label={v.mode === 'SEA_CONSOL' ? 'Sailing date' : 'Flight date'}><input type="date" {...bind('flight_date')} /></Field>
        <Field label={v.mode === 'SEA_CONSOL' ? 'Bill of lading no.' : 'MAWB no.'} hint={v.mode === 'SEA_CONSOL' ? '' : 'Airline prefix-serial, e.g. 176-12345678'}><input {...bind('mawb_no')} /></Field>
        <Field label="Destination delivery agent"><select {...bind('agent_id')}><option value="">—</option>{meta.data?.agents.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.country})</option>)}</select></Field>
      </div>
      <Field label="Notes"><input {...bind('notes')} /></Field>
    </Modal>
  );
}

export function ManifestDetail() {
  const { id } = useParams();
  const meta = useMeta();
  const { user } = useSession();
  const d = useLoad(() => api.get(`/api/intl/manifests/${id}`), [id]);
  const [awb, setAwb] = useState('');
  const [edit, setEdit] = useState(false);
  const [print, setPrint] = useState(false);
  const [run, busy] = useAction();
  if (d.loading && !d.data) return <Spinner />;
  if (d.error) return <ErrorBox error={d.error} />;
  const m = d.data;
  const ops = ['ADMIN', 'OPS'].includes(user.role);
  const act = (path, body, msg) => run(() => api.post(`/api/intl/manifests/${m.id}/${path}`, body || {}), msg).then(() => d.reload(true));
  const add = (e) => { e.preventDefault(); if (!awb.trim()) return; run(() => api.post(`/api/intl/manifests/${m.id}/add`, { awb: awb.trim() }), `${awb} added`).then(() => { setAwb(''); d.reload(true); }).catch(() => {}); };
  const csv = async () => {
    const res = await fetch(`/api/intl/manifests/${m.id}/prealert.csv`, { headers: { Authorization: `Bearer ${api.token}` } });
    if (!res.ok) return;
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: `${m.number}-prealert.csv` });
    a.click(); URL.revokeObjectURL(url);
  };
  return (
    <>
      <div className="page-head"><div><Link to="/intl/manifests" className="small">‹ Manifests</Link><h1 className="mono">{m.number} <Badge tone="info">{m.status}</Badge></h1>
        <div className="muted small">{m.mode === 'AIR_CARGO' ? 'Air cargo' : 'Air courier'} · <b>{m.origin_airport} → {m.dest_airport}</b> {m.dest_airport_name} · {m.airline} {m.flight_no} {dOnly(m.flight_date)} · MAWB <b className="mono">{m.mawb_no || '—'}</b> · agent {m.agent_name || '—'}</div></div>
        <div className="row">
          <button className="btn" onClick={() => setPrint(true)}>🖨️ Manifest</button>
          <button className="btn" onClick={csv}>⬇️ Pre-alert CSV</button>
          {ops && ['OPEN', 'CLOSED'].includes(m.status) && <button className="btn" onClick={() => setEdit(true)}>✏️ Flight / MAWB</button>}
          {ops && m.status === 'OPEN' && <button className="btn primary" disabled={busy} onClick={() => act('close', {}, 'Manifest closed')}>Close manifest</button>}
          {ops && m.status === 'CLOSED' && <button className="btn primary" disabled={busy} onClick={() => act('depart', {}, 'Flight departed — customers notified via tracking')}>✈️ Mark departed</button>}
          {ops && m.status === 'DEPARTED' && <button className="btn primary" disabled={busy} onClick={() => act('arrive', {}, 'Arrived at destination')}>🛬 Mark arrived</button>}
          {ops && m.status === 'ARRIVED' && <button className="btn ok" disabled={busy} onClick={() => {
            const h = prompt('AWBs held by customs (comma separated, blank = clear all):', '');
            if (h !== null) act('clear', { hold_awbs: h.split(',').map((x) => x.trim()).filter(Boolean), handover: true }, 'Customs cleared & handed to agent');
          }}>🛃 Clear customs & hand over</button>}
        </div></div>
      <div className="grid g4">
        <Stat label="AWBs" value={m.totals.shipments} /><Stat label="Pieces" value={m.totals.pieces} />
        <Stat label="Gross / chargeable kg" value={`${m.totals.weight} / ${m.totals.chargeable}`} /><Stat label="Declared value" value={aed(m.totals.value)} />
      </div>
      {m.status === 'OPEN' && (
        <form className="card row" onSubmit={add}>
          <b>Scan to add</b><input value={awb} onChange={(e) => setAwb(e.target.value.toUpperCase())} placeholder="Scan / type AWB (must be IN-scanned at hub, docs OK, same destination)" style={{ flex: 1 }} autoFocus />
          <button className="btn primary" disabled={busy}>Add</button>
          <span className="tiny muted">Or use the Warehouse Scanner app → OUT → Manifest.</span>
        </form>
      )}
      <div className="table-wrap"><table>
        <thead><tr><th>AWB</th><th>Status</th><th>Consignee</th><th>Product</th><th className="num">Pcs</th><th className="num">Kg</th><th className="num">Value</th><th>Terms</th><th>Customs</th><th>Agent ref</th><th /></tr></thead>
        <tbody>{m.shipments.map((s) => <tr key={s.id}>
          <td><Link to={`/shipments/${s.id}`} className="mono">{s.awb}</Link>{s.dangerous_goods ? <Badge tone="bad">DG</Badge> : null}</td><td><Badge s={s.status} /></td><td>{s.consignee_name}<div className="tiny muted">{s.dest_city}</div></td>
          <td>{s.product}</td><td className="num">{s.pieces}</td><td className="num">{s.chargeable_weight}</td><td className="num">{s.customs_value} {s.currency}</td><td>{s.incoterm}</td><td><Badge s={s.customs_status} /></td><td className="mono small">{s.agent_tracking || '—'}</td>
          <td>{ops && m.status === 'OPEN' && <button className="btn sm ghost" onClick={() => act('remove', { shipment_id: s.id }, 'Removed')}>✕</button>}</td></tr>)}</tbody>
      </table>{!m.shipments.length && <Empty>No shipments yet — scan AWBs to consolidate.</Empty>}</div>
      {edit && <ManifestModal m={m} onClose={() => setEdit(false)} onDone={() => { setEdit(false); d.reload(true); }} />}
      {print && (
        <Modal title="Cargo manifest" wide onClose={() => setPrint(false)} footer={<button className="btn primary" onClick={() => window.print()}>Print</button>}>
          <div style={{ background: '#fff', color: '#000', padding: 16, fontSize: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><div><b style={{ fontSize: 18 }}>{meta.company?.name}</b><br />CARGO MANIFEST · {m.mode}</div>
              <div style={{ textAlign: 'right' }}><Barcode value={m.mawb_no || m.number} height={40} fontSize={11} /></div></div>
            <div style={{ margin: '8px 0' }}>Manifest <b>{m.number}</b> · {m.origin_airport} → {m.dest_airport} · Flight {m.airline} {m.flight_no} {dOnly(m.flight_date)} · MAWB <b>{m.mawb_no}</b> · Agent {m.agent_name}</div>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}><thead><tr>{['#', 'HAWB / AWB', 'Consignee', 'City', 'Pcs', 'Kg', 'Value', 'Terms'].map((h) => <th key={h} style={{ border: '1px solid #999', background: '#eef2f8', color: '#000' }}>{h}</th>)}</tr></thead>
              <tbody>{m.shipments.map((s, i) => <tr key={s.id}>{[i + 1, s.awb, s.consignee_name, s.dest_city, s.pieces, s.chargeable_weight, `${s.customs_value} ${s.currency}`, s.incoterm].map((c, j) => <td key={j} style={{ border: '1px solid #999', padding: '3px 6px' }}>{c}</td>)}</tr>)}</tbody>
              <tfoot><tr><td colSpan={4} style={{ border: '1px solid #999', textAlign: 'right' }}><b>Totals</b></td><td style={{ border: '1px solid #999' }}><b>{m.totals.pieces}</b></td><td style={{ border: '1px solid #999' }}><b>{m.totals.chargeable}</b></td><td colSpan={2} style={{ border: '1px solid #999' }}><b>{m.totals.value} AED</b></td></tr></tfoot></table>
            <div style={{ marginTop: 20 }}>Prepared by: {m.created_by_name} · {dt(m.created_at)}</div>
          </div>
        </Modal>
      )}
    </>
  );
}

export function Countries() {
  const { user } = useSession();
  const meta = useLoad(() => api.get('/api/intl/meta'), []);
  const [rows, setRows] = useState({});
  const [run] = useAction();
  const can = ['ADMIN', 'FINANCE'].includes(user.role);
  const val = (c, k) => rows[c.code]?.[k] ?? c[k];
  const set = (c, k, v) => setRows({ ...rows, [c.code]: { ...rows[c.code], [k]: v } });
  const save = (c) => run(() => api.put(`/api/intl/countries/${c.code}`, { zone: val(c, 'zone'), duty_pct: Number(val(c, 'duty_pct')), import_vat_pct: Number(val(c, 'import_vat_pct')), de_minimis: Number(val(c, 'de_minimis')), airport: val(c, 'airport'), active: true }), 'Saved')
    .then(() => { setRows({ ...rows, [c.code]: undefined }); meta.reload(true); });
  return (
    <>
      <div className="page-head"><div><Link to="/intl" className="small">‹ International</Link><h1>Countries, zones & duty rules</h1></div>
        <span className="small muted">Indicative duty/tax rates for DDP billing & DAP guidance. Verify against destination customs tariffs.</span></div>
      {meta.loading ? <Spinner /> : (
        <div className="table-wrap"><table><thead><tr><th>Country</th><th>Zone</th><th>Gateway airport</th><th className="num">Duty %</th><th className="num">Import VAT/GST %</th><th className="num">De-minimis (AED)</th><th /></tr></thead>
          <tbody>{meta.data.countries.map((c) => <tr key={c.code}><td><b>{c.name}</b> <span className="muted small">{c.code}</span></td>
            <td>{can ? <select value={val(c, 'zone')} onChange={(e) => set(c, 'zone', e.target.value)} style={{ width: 80 }}>{['Z1', 'Z2', 'Z3', 'Z4', 'Z5', 'Z6'].map((z) => <option key={z}>{z}</option>)}</select> : c.zone}</td>
            <td>{can ? <input value={val(c, 'airport') || ''} maxLength={3} onChange={(e) => set(c, 'airport', e.target.value.toUpperCase())} style={{ width: 80 }} /> : c.airport}</td>
            {['duty_pct', 'import_vat_pct', 'de_minimis'].map((k) => <td key={k} className="num">{can ? <input type="number" step="any" value={val(c, k)} onChange={(e) => set(c, k, e.target.value)} style={{ width: 100 }} /> : c[k]}</td>)}
            <td>{can && rows[c.code] && <button className="btn sm primary" onClick={() => save(c)}>Save</button>}</td></tr>)}</tbody></table></div>
      )}
      <div className="card"><h3>Overseas delivery agents</h3>
        <table><tbody>{meta.data?.agents.map((a) => <tr key={a.id}><td><b>{a.name}</b></td><td>{a.country}</td><td className="small">{a.contact} · {a.email}</td></tr>)}</tbody></table></div>
    </>
  );
}

/** International panel for the ERP shipment detail page. */
export function IntlPanel({ s, onChange }) {
  const { user } = useSession();
  const [items, setItems] = useState(false);
  const [v, , bind] = useForm({ status: 'OUT_FOR_DELIVERY', note: '', pod_name: '', agent_tracking: s.agent_tracking || '' });
  const [run, busy] = useAction();
  const ops = ['ADMIN', 'OPS'].includes(user.role);
  const atDest = ['ARRIVED', 'CUSTOMS_HOLD', 'CUSTOMS_CLEARED', 'WITH_AGENT', 'OUT_FOR_DELIVERY', 'DELIVERY_FAILED'].includes(s.status);
  return (
    <div className="card stack">
      <h3>✈️ International · customs</h3>
      <div className="small">{s.product} · {s.incoterm} · reason {s.export_reason || '—'} · gateway <b>{s.dest_airport}</b> · customs <Badge s={s.customs_status} /> {s.customs_ref && <span className="mono">{s.customs_ref}</span>}{s.dangerous_goods ? <> · <Badge tone="bad">Dangerous goods</Badge></> : null}</div>
      <div className="small">Declared value <b>{s.customs_value} {s.currency}</b>{s.duties_estimate ? ` · DDP duties billed ${aed(s.duties_estimate)}` : ''} · consignee postcode {s.consignee_postcode || '—'} · tax ID {s.consignee_tax_id || '—'}</div>
      {s.items.length > 0 && <table><thead><tr><th>Item</th><th>HS</th><th className="num">Qty</th><th className="num">Unit</th></tr></thead>
        <tbody>{s.items.map((i) => <tr key={i.id}><td>{i.description}</td><td className="mono">{i.hs_code || <Badge tone="warn">missing</Badge>}</td><td className="num">{i.qty}</td><td className="num">{i.unit_value}</td></tr>)}</tbody></table>}
      {s.manifest && <div className="small">Manifest <Link to={`/intl/manifests/${s.manifest.id}`} className="mono">{s.manifest.number}</Link> · {s.manifest.flight_no} {dOnly(s.manifest.flight_date)} · MAWB {s.manifest.mawb_no || '—'} · <Badge tone="info">{s.manifest.status}</Badge></div>}
      {s.agent && <div className="small">Delivery partner: <b>{s.agent.name}</b>{s.agent_tracking && ` · ref ${s.agent_tracking}`}</div>}
      {ops && s.product !== 'DOCUMENT' && !['DEPARTED', 'ARRIVED', 'WITH_AGENT', 'DELIVERED'].includes(s.status) && <button className="btn sm" onClick={() => setItems(true)}>Edit commercial invoice</button>}
      {ops && atDest && (
        <div className="card flat stack"><b className="small">Record partner / destination update</b>
          <div className="grid g2">
            <Field label="Status"><select {...bind('status')}>{['WITH_AGENT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'DELIVERY_FAILED', 'CUSTOMS_HOLD', 'CUSTOMS_CLEARED', 'RETURNED'].map((x) => <option key={x}>{x}</option>)}</select></Field>
            <Field label="Partner tracking no."><input {...bind('agent_tracking')} /></Field>
            {v.status === 'DELIVERED' && <Field label="Received by (POD)"><input {...bind('pod_name')} /></Field>}
            <Field label="Note"><input {...bind('note')} /></Field>
          </div>
          <button className="btn primary sm" disabled={busy} onClick={() => run(() => api.post(`/api/intl/shipments/${s.id}/agent-event`, Object.fromEntries(Object.entries(v).filter(([, x]) => x !== ''))), 'Update recorded').then(onChange)}>Save update</button>
        </div>
      )}
      {items && <ItemsEditor s={s} onClose={() => setItems(false)} onDone={() => { setItems(false); onChange(); }} />}
    </div>
  );
}
