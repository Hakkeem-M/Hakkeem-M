import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, useMeta } from '../ctx.js';
import { qs } from '../../shared/api.js';
import { useLoad, useAction, Spinner, ErrorBox, Badge, Modal, Field, Empty } from '../../shared/ui.jsx';
import { aed, dt, ago, STATUS, SERVICES } from '../../shared/format.js';
import { useSession } from '../../shared/session.jsx';
import ShipmentForm from '../../shared/ShipmentForm.jsx';
import { ShippingLabel } from '../../shared/docs.jsx';

export function ShipmentList() {
  const nav = useNavigate();
  const { user } = useSession();
  const [f, setF] = useState({ q: '', status: '', from: '', to: '', page: 1 });
  const [creating, setCreating] = useState(false);
  const list = useLoad(() => api.get(`/api/shipments${qs({ ...f, limit: 50 })}`), [f.q, f.status, f.from, f.to, f.page]);
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / 50)) : 1;
  return (
    <>
      <div className="page-head">
        <h1>Shipments</h1>
        {['ADMIN', 'OPS'].includes(user.role) && <button className="btn primary" onClick={() => setCreating(true)}>+ New shipment</button>}
      </div>
      <div className="filters">
        <Field label="Search"><input placeholder="AWB, name, phone, ref" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value, page: 1 })} /></Field>
        <Field label="Status"><select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value, page: 1 })}>
          <option value="">All</option>{Object.entries(STATUS).slice(0, 10).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}</select></Field>
        <Field label="From"><input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value, page: 1 })} /></Field>
        <Field label="To"><input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value, page: 1 })} /></Field>
      </div>
      <ErrorBox error={list.error} />
      {list.loading && !list.data ? <Spinner /> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>AWB</th><th>Status</th><th>Customer</th><th>Route</th><th>Consignee</th><th>Service</th><th className="num">Wt</th><th className="num">COD</th><th className="num">Charge</th><th>Driver / Bin</th><th>Updated</th></tr></thead>
            <tbody>
              {list.data?.rows.map((s) => (
                <tr key={s.id} className="clickable" onClick={() => nav(`/shipments/${s.id}`)}>
                  <td className="mono"><b>{s.awb}</b></td><td><Badge s={s.status} /></td><td>{s.customer_name}</td>
                  <td>{s.origin_city} → {s.dest_city}{s.dest_country !== 'AE' && ` (${s.dest_country})`}</td>
                  <td>{s.consignee_name}<div className="tiny muted">{s.consignee_phone}</div></td>
                  <td>{SERVICES[s.service]}</td><td className="num">{s.chargeable_weight}</td>
                  <td className="num">{s.cod_amount ? aed(s.cod_amount) : '—'}</td><td className="num">{aed(s.total_charge)}</td>
                  <td>{s.driver_name || (s.bin ? `${s.branch_code} · ${s.bin}` : '—')}</td><td className="small muted">{ago(s.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!list.data?.rows.length && <Empty>No shipments match.</Empty>}
        </div>
      )}
      <div className="row between"><span className="muted small">{list.data?.total ?? 0} shipments</span>
        <div className="row"><button className="btn sm" disabled={f.page <= 1} onClick={() => setF({ ...f, page: f.page - 1 })}>‹ Prev</button>
          <span className="small">Page {f.page} / {pages}</span>
          <button className="btn sm" disabled={f.page >= pages} onClick={() => setF({ ...f, page: f.page + 1 })}>Next ›</button></div></div>
      {creating && <NewShipment onClose={() => setCreating(false)} onDone={(s) => nav(`/shipments/${s.id}`)} />}
    </>
  );
}

function NewShipment({ onClose, onDone }) {
  const customers = useLoad(() => api.get('/api/admin/customers'), []);
  const [cid, setCid] = useState('');
  const [mode, setMode] = useState('');
  const [run, busy] = useAction();
  const cust = customers.data?.find((c) => String(c.id) === cid);
  return (
    <Modal title="New shipment" onClose={onClose} wide>
      <div className="grid g2" style={{ marginBottom: 12 }}>
        <Field label="Customer"><select value={cid} onChange={(e) => setCid(e.target.value)} required>
          <option value="">Select customer…</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.code} · {c.type})</option>)}</select></Field>
        <Field label="Payment"><select value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="">{cust?.type === 'ACCOUNT' ? 'On account (credit)' : 'Cash at pickup'}</option><option value="PREPAID">Prepaid (invoice now)</option></select></Field>
      </div>
      {cust && (
        <ShipmentForm api={api} busy={busy} key={cust.id}
          initial={{ shipper_name: cust.name, shipper_phone: cust.phone || '', shipper_address: cust.address || '', origin_city: cust.city || 'Dubai', pickup_lat: cust.lat, pickup_lng: cust.lng }}
          onSubmit={async (body) => {
            const s = await run(() => api.post('/api/shipments', { ...body, customer_id: cust.id, payment_mode: mode || undefined }), 'Shipment booked');
            onDone(s);
          }} />
      )}
    </Modal>
  );
}

export function ShipmentDetail() {
  const { id } = useParams();
  const meta = useMeta();
  const { user } = useSession();
  const d = useLoad(() => api.get(`/api/shipments/${id}`), [id]);
  const drivers = useLoad(() => api.get('/api/warehouse/drivers').catch(() => []), []);
  const [run, busy] = useAction();
  const [label, setLabel] = useState(false);
  const [drv, setDrv] = useState('');
  if (d.loading && !d.data) return <Spinner />;
  if (d.error) return <ErrorBox error={d.error} />;
  const s = d.data;
  const canOps = ['ADMIN', 'OPS'].includes(user.role);
  const assign = () => run(() => api.post('/api/shipments/assign', { shipment_ids: [s.id], driver_id: Number(drv) }), 'Driver assigned').then((r) => {
    if (!r.results[0].ok) throw new Error(r.results[0].error);
    d.reload();
  });
  const status = (st) => { const note = prompt(`Note for status ${STATUS[st].label}`) ?? undefined; return run(() => api.post(`/api/shipments/${s.id}/status`, { status: st, note }), 'Status updated').then(d.reload); };
  return (
    <>
      <div className="page-head">
        <div><Link to="/shipments" className="small">‹ Shipments</Link><h1 className="mono">{s.awb} <Badge s={s.status} /></h1>
          <div className="muted small">{s.customer_name} ({s.customer_code}) · booked {dt(s.created_at)} · {SERVICES[s.service]} · {s.zone}</div></div>
        <div className="row">
          <button className="btn" onClick={() => setLabel(true)}>🖨️ Label</button>
          {canOps && ['BOOKED', 'PICKUP_ASSIGNED'].includes(s.status) && <button className="btn danger" disabled={busy} onClick={() => status('CANCELLED')}>Cancel</button>}
          {canOps && s.status === 'DELIVERY_FAILED' && <button className="btn" disabled={busy} onClick={() => status('RETURNED')}>Return to shipper</button>}
        </div>
      </div>
      <div className="grid g3">
        <div className="card"><h3>Shipper</h3>{s.shipper_name}<div className="muted">{s.shipper_phone}</div><div>{s.shipper_address}, {s.origin_city}</div>
          {s.pickup_lat && <a className="small" href={`https://www.google.com/maps?q=${s.pickup_lat},${s.pickup_lng}`} target="_blank" rel="noreferrer">📍 {s.pickup_lat.toFixed(5)}, {s.pickup_lng.toFixed(5)}</a>}
          {s.pickup_window && <div className="small">Window: {s.pickup_window}</div>}</div>
        <div className="card"><h3>Consignee</h3>{s.consignee_name}<div className="muted">{s.consignee_phone}</div><div>{s.consignee_address}, {s.dest_city} {s.dest_country}</div></div>
        <div className="card"><h3>Charges</h3>
          <table><tbody>
            <tr><td>Freight</td><td className="num">{aed(s.freight)}</td></tr><tr><td>Fuel surcharge</td><td className="num">{aed(s.fuel_surcharge)}</td></tr>
            {s.cod_fee > 0 && <tr><td>COD fee</td><td className="num">{aed(s.cod_fee)}</td></tr>}
            <tr><td>VAT {s.vat_rate}%</td><td className="num">{aed(s.vat)}</td></tr><tr><td><b>Total</b></td><td className="num"><b>{aed(s.total_charge)}</b></td></tr>
          </tbody></table>
          <div className="small">Payment: <b>{s.payment_mode}</b>{s.invoice_id && <> · <Link to={`/invoices/${s.invoice_id}`}>{s.invoice_number}</Link> <Badge s={s.invoice_status} /></>}</div>
          {s.cod_amount > 0 && <div className="small">COD {aed(s.cod_amount)} · collected {aed(s.cod_collected)}{s.cod_remittance_id ? ' · remitted' : ''}</div>}
        </div>
      </div>
      <div className="grid g2">
        <div className="card">
          <h3>Tracking timeline</h3>
          <ul className="timeline">{s.events.slice().reverse().map((e) => (
            <li key={e.id} className={e.public ? '' : 'private'}><Badge s={e.status} /> <span className="small">{e.location}</span>
              <div className="small">{e.note}</div><div className="tiny muted">{dt(e.created_at)} · {e.user_name || 'system'}{!e.public && ' · internal'}{e.lat ? ` · GPS ${e.lat.toFixed(4)},${e.lng.toFixed(4)}` : ''}</div></li>))}</ul>
        </div>
        <div className="stack">
          <div className="card"><h3>Parcel</h3>{s.pieces} pcs · {s.weight} kg actual · <b>{s.chargeable_weight} kg chargeable</b>{s.length && ` · ${s.length}×${s.width}×${s.height} cm`}
            <div className="small muted">{s.description} {s.reference && `· Ref ${s.reference}`}</div>
            <div className="small">Location: {s.branch_name ? `${s.branch_name}${s.bin ? ` · bin ${s.bin}` : ''}` : '—'} · Driver: {s.driver_name || '—'} · Attempts: {s.attempts}</div></div>
          {canOps && ['BOOKED', 'PICKUP_ASSIGNED', 'IN_WAREHOUSE', 'DELIVERY_FAILED'].includes(s.status) && (
            <div className="card"><h3>Assign driver</h3><div className="row nowrap">
              <select value={drv} onChange={(e) => setDrv(e.target.value)}><option value="">Select driver…</option>{drivers.data?.map((x) => <option key={x.id} value={x.id}>{x.name} · {x.vehicle_no}</option>)}</select>
              <button className="btn primary" disabled={!drv || busy} onClick={assign}>Assign</button></div>
              <div className="tiny muted">For optimised multi-stop runs use Dispatch & Routing.</div></div>
          )}
          {s.status === 'DELIVERED' && (
            <div className="card"><h3>Proof of delivery</h3>Received by <b>{s.pod_name}</b> · {dt(s.delivered_at)}
              <div className="row" style={{ alignItems: 'flex-start' }}>
                {s.pod_signature && <img src={s.pod_signature} alt="Signature" style={{ maxWidth: 240, background: '#fff', border: '1px solid var(--border)', borderRadius: 8 }} />}
                {s.pod_photo && <img src={s.pod_photo} alt="POD photo" style={{ maxWidth: 240, borderRadius: 8 }} />}
              </div></div>
          )}
          {s.scans.length > 0 && (
            <div className="card"><h3>Warehouse scans</h3><table><tbody>{s.scans.map((w) => (
              <tr key={w.id}><td>{w.direction}</td><td>{w.branch_code}{w.bin && ` · ${w.bin}`}</td><td><Badge s={w.result} /></td><td className="small">{w.message}</td><td className="small muted">{dt(w.scanned_at)}</td></tr>))}</tbody></table></div>
          )}
        </div>
      </div>
      {label && <Modal title="Shipping label" onClose={() => setLabel(false)} footer={<button className="btn primary" onClick={() => window.print()}>Print</button>}>
        <div className="print-area"><ShippingLabel s={s} company={meta.company} /></div></Modal>}
    </>
  );
}
