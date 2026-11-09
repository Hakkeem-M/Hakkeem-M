// Quotations: create from a lead / customer / walk-in contact, send, accept, convert to a booking. Printable quote.
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, useMeta } from '../ctx.js';
import { qs } from '../../shared/api.js';
import { useLoad, useAction, Spinner, ErrorBox, Badge, Field, Empty, useForm } from '../../shared/ui.jsx';
import { money, dOnly, dt, SERVICES, REGIONS } from '../../shared/format.js';
import { useSession } from '../../shared/session.jsx';
import ShipmentForm from '../../shared/ShipmentForm.jsx';
import { RegionPicker } from '../../shared/session.jsx';

export function Quotations() {
  const nav = useNavigate();
  const [f, setF] = useState({ q: '', status: '' });
  const list = useLoad(() => api.get(`/api/quotations${qs(f)}`), [f.q, f.status]);
  return (
    <>
      <div className="page-head"><h1>Quotations</h1><Link className="btn primary" to="/quotations/new">+ New quotation</Link></div>
      <div className="filters">
        <Field label="Search"><input value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder="Quote no., name, phone" /></Field>
        <Field label="Status"><select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">All</option>{['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'CONVERTED'].map((s) => <option key={s}>{s}</option>)}</select></Field>
      </div>
      <ErrorBox error={list.error} />
      {list.loading && !list.data ? <Spinner /> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Quote</th><th>Region</th><th>Customer / contact</th><th>Route</th><th>Service</th><th className="num">Total</th><th>Valid until</th><th>Status</th></tr></thead>
          <tbody>{list.data?.map((q) => (
            <tr key={q.id} className="clickable" onClick={() => nav(`/quotations/${q.id}`)}>
              <td className="mono"><b>{q.number}</b></td><td>{REGIONS[q.entity_code]?.flag} {q.entity_code}</td>
              <td>{q.customer_name || q.contact_name}<div className="tiny muted">{q.contact_phone}</div></td>
              <td>{q.origin_city} → {q.dest_city}, {q.dest_country}</td><td className="small">{SERVICES[q.service]}</td>
              <td className="num">{money(q.total, q.currency)}</td><td>{q.expired ? <Badge tone="muted">Expired</Badge> : dOnly(q.valid_until)}</td><td><Badge s={q.status} /></td>
            </tr>))}</tbody>
        </table>{!list.data?.length && <Empty>No quotations yet.</Empty>}</div>
      )}
    </>
  );
}

export function NewQuotation() {
  const nav = useNavigate();
  const { user, region: working } = useSession();
  const [region, setRegion] = useState(user.entity_code || working || 'AE');
  const customers = useLoad(() => api.get('/api/admin/customers'), [region]);
  const leads = useLoad(() => api.get('/api/crm/leads').catch(() => []), []);
  const [c, , bind] = useForm({ customer_id: '', lead_id: '', contact_name: '', contact_phone: '', contact_email: '', valid_days: 14, notes: '' });
  const [run, busy] = useAction();
  const cust = customers.data?.find((x) => String(x.id) === c.customer_id);
  const regionCustomers = (customers.data || []).filter((x) => x.entity_code === region);
  return (
    <>
      <div className="page-head"><div><Link to="/quotations" className="small">‹ Quotations</Link><h1>New quotation</h1></div></div>
      <div className="card stack">
        {!user.entity_code && <Field label="Region (origin)"><RegionPicker value={region} onChange={setRegion} /></Field>}
        <div className="grid g3">
          <Field label="Existing customer (optional)"><select {...bind('customer_id')}><option value="">— new prospect / walk-in —</option>
            {regionCustomers.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.code})</option>)}</select></Field>
          <Field label="CRM lead (optional)"><select {...bind('lead_id')}><option value="">—</option>
            {(leads.data || []).filter((l) => !l.entity_code || l.entity_code === region).map((l) => <option key={l.id} value={l.id}>{l.company} · {l.contact_name}</option>)}</select></Field>
          <Field label="Valid for (days)"><input {...bind('valid_days', 'number')} min="1" max="90" /></Field>
          {!c.customer_id && <><Field label="Contact name"><input {...bind('contact_name')} /></Field>
            <Field label="Contact phone"><input {...bind('contact_phone')} type="tel" /></Field>
            <Field label="Contact email"><input {...bind('contact_email')} type="email" /></Field></>}
        </div>
        <Field label="Notes / terms on quote"><textarea {...bind('notes')} style={{ minHeight: 50 }} /></Field>
      </div>
      <ShipmentForm api={api} region={region} staff key={`${region}-${c.customer_id}`} submitLabel="Create quotation" busy={busy}
        receiversUrl={c.customer_id ? `/api/quotations/customers/${c.customer_id}/receivers` : undefined}
        initial={cust ? { shipper_name: cust.name, shipper_phone: cust.phone || '', shipper_address: cust.address || '', origin_city: cust.city || undefined } : {}}
        onSubmit={async (body) => {
          const q = await run(() => api.post('/api/quotations', {
            ...body, entity_code: region, customer_id: c.customer_id ? Number(c.customer_id) : undefined, lead_id: c.lead_id ? Number(c.lead_id) : undefined,
            contact_name: c.contact_name || undefined, contact_phone: c.contact_phone || undefined, contact_email: c.contact_email || undefined,
            valid_days: Number(c.valid_days) || 14, notes: c.notes || undefined,
          }), 'Quotation created');
          nav(`/quotations/${q.id}`);
        }} />
    </>
  );
}

export function QuotationDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const meta = useMeta();
  const d = useLoad(() => api.get(`/api/quotations/${id}`), [id]);
  const [run, busy] = useAction();
  if (d.loading && !d.data) return <Spinner />;
  if (d.error) return <ErrorBox error={d.error} />;
  const q = d.data;
  const p = q.pricing;
  const cur = q.currency;
  const status = (st) => run(() => api.post(`/api/quotations/${q.id}/status`, { status: st }), `Marked ${st.toLowerCase()}`).then(() => d.reload(true));
  const convert = () => run(() => api.post(`/api/quotations/${q.id}/convert`, {}), 'Booking created').then((r) => nav(`/shipments/${r.shipment.id}`));
  const msg = `Dear ${q.contact_name}, your ABC Cargo quotation ${q.number}: ${SERVICES[q.service]} ${q.origin_city} to ${q.dest_city}, ${q.dest_country} — ${money(q.total, cur)}. Valid until ${dOnly(q.valid_until)}.`;
  const lines = [['Freight', p.freight], ['Fuel surcharge', p.fuel_surcharge], ['Packing', p.packing_charge], ['AWB / documentation', p.awb_charge],
    ['Handling', p.handling_charge], ['Other', p.other_charge], ['COD fee', p.cod_fee], ['Dangerous goods', p.dg_surcharge], ['Duties & taxes (DDP)', p.duties_estimate],
    ['Discount', p.discount ? -p.discount : 0], [`VAT ${p.vat_rate}%`, p.vat]].filter(([, a]) => a);
  return (
    <>
      <div className="page-head no-print"><div><Link to="/quotations" className="small">‹ Quotations</Link><h1 className="mono">{q.number} <Badge s={q.expired ? 'EXPIRED' : q.status} /></h1>
        <div className="muted small">{REGIONS[q.entity_code]?.flag} {REGIONS[q.entity_code]?.name} · created {dt(q.created_at)} by {q.created_by_name}</div></div>
        <div className="row">
          <button className="btn" onClick={() => window.print()}>🖨️ Print / PDF</button>
          {q.contact_phone && <a className="btn" target="_blank" rel="noreferrer" href={`https://wa.me/${q.contact_phone.replace(/[^\d]/g, '')}?text=${encodeURIComponent(msg)}`}>💬 WhatsApp</a>}
          {q.contact_email && <a className="btn" href={`mailto:${q.contact_email}?subject=${encodeURIComponent(`Quotation ${q.number}`)}&body=${encodeURIComponent(msg)}`}>✉️ Email</a>}
          {['DRAFT'].includes(q.status) && <button className="btn" disabled={busy} onClick={() => status('SENT')}>Mark sent</button>}
          {['DRAFT', 'SENT'].includes(q.status) && <button className="btn ok" disabled={busy} onClick={() => status('ACCEPTED')}>Accepted</button>}
          {['DRAFT', 'SENT'].includes(q.status) && <button className="btn ghost" disabled={busy} onClick={() => status('REJECTED')}>Rejected</button>}
          {!['CONVERTED', 'REJECTED'].includes(q.status) && !q.expired && <button className="btn primary" disabled={busy} onClick={convert}>📦 Convert to booking</button>}
          {q.shipment_id && <Link className="btn primary" to={`/shipments/${q.shipment_id}`}>Open booking {q.awb}</Link>}
        </div></div>
      <div className="card" style={{ background: '#fff', color: '#000', maxWidth: 860 }}>
        <div className="row between"><div><div style={{ fontSize: 20, fontWeight: 800, color: '#c8102e' }}>{meta.company?.name}</div><div className="small">{meta.company?.address} · {meta.company?.phone}</div>
          <div className="small">{meta.company?.tax_label}: {meta.company?.trn}</div></div>
          <div style={{ textAlign: 'right' }}><div style={{ fontSize: 18, fontWeight: 800 }}>QUOTATION</div><div>No. <b>{q.number}</b></div><div>Valid until {dOnly(q.valid_until)}</div></div></div>
        <hr />
        <div className="grid g2"><div><b>To</b><br />{q.customer_name || q.contact_name}<br />{q.contact_phone}<br />{q.contact_email}</div>
          <div><b>Shipment</b><br />{SERVICES[q.service]}<br />{q.origin_city} → {q.dest_city}, {p.country || q.dest_country}<br />
            {p.boxes?.length ? `${p.boxes.length} boxes · ` : ''}{p.unit === 'CBM' ? `${p.chargeable_units} CBM chargeable` : `${p.chargeable_weight} kg chargeable`}{p.cbm ? ` · ${p.cbm} CBM` : ''} · transit {p.transit}</div></div>
        {p.boxes?.length > 0 && (
          <table style={{ marginTop: 10 }}><thead><tr><th>Box</th><th className="num">Actual kg</th><th className="num">Dims cm</th><th className="num">Bill kg</th><th className="num">CBM</th><th>Packing</th><th className="num">Packing charge</th></tr></thead>
            <tbody>{p.boxes.map((b) => <tr key={b.seq}><td>#{b.seq}</td><td className="num">{b.actual_weight}</td><td className="num">{b.length ? `${b.length}×${b.width}×${b.height}` : '—'}</td>
              <td className="num">{b.bill_weight}</td><td className="num">{b.cbm}</td><td>{b.packing_type}</td><td className="num">{money(b.packing_charge, cur)}</td></tr>)}</tbody></table>
        )}
        <table style={{ marginTop: 10, maxWidth: 380, marginLeft: 'auto' }}><tbody>
          {lines.map(([l, a]) => <tr key={l}><td>{l}</td><td className="num">{money(a, cur)}</td></tr>)}
          <tr><td><b>Total</b></td><td className="num"><b>{money(q.total, cur)}</b></td></tr></tbody></table>
        {p.duties_guide?.applies && q.payload.incoterm !== 'DDP' && <div className="small" style={{ marginTop: 8 }}>Receiver pays estimated import duty & taxes of {money(p.duties_guide.total, cur)} on arrival (DAP).</div>}
        {q.notes && <div className="small" style={{ marginTop: 8 }}>{q.notes}</div>}
        <div className="tiny" style={{ marginTop: 12, color: '#555' }}>Prices in {cur}. Final charges are confirmed on collection after weighing and measuring. Duties are estimates set by destination customs.</div>
      </div>
    </>
  );
}
