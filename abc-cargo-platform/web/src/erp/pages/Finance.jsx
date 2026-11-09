import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, useMeta } from '../ctx.js';
import { qs } from '../../shared/api.js';
import { useLoad, useAction, Spinner, ErrorBox, Badge, Modal, Field, Empty, useForm } from '../../shared/ui.jsx';
import { aed, dOnly, dt, ago } from '../../shared/format.js';
import { useSession } from '../../shared/session.jsx';
import { InvoiceDoc } from '../../shared/docs.jsx';

export function Invoices() {
  const nav = useNavigate();
  const { user } = useSession();
  const [f, setF] = useState({ q: '', status: '', overdue: '' });
  const list = useLoad(() => api.get(`/api/finance/invoices${qs(f)}`), [f.q, f.status, f.overdue]);
  const ar = useLoad(() => api.get('/api/finance/receivables'), []);
  const [billing, setBilling] = useState(false);
  return (
    <>
      <div className="page-head"><h1>Invoices & billing</h1>
        {['ADMIN', 'FINANCE'].includes(user.role) && <button className="btn primary" onClick={() => setBilling(true)}>+ Account billing run</button>}</div>
      <div className="card"><h3>Receivables by customer</h3>
        <table><thead><tr><th>Customer</th><th className="num">Open invoices</th><th className="num">Outstanding</th><th className="num">Overdue</th><th className="num">Credit limit</th></tr></thead>
          <tbody>{ar.data?.map((r) => <tr key={r.customer_id}><td><Link to={`/customers/${r.customer_id}`}>{r.name}</Link></td><td className="num">{r.open_invoices}</td>
            <td className="num">{aed(r.outstanding)}</td><td className="num">{r.overdue > 0 ? <Badge tone="bad">{aed(r.overdue)}</Badge> : '—'}</td><td className="num">{r.credit_limit ? aed(r.credit_limit) : '—'}</td></tr>)}</tbody></table>
        {ar.data && !ar.data.length && <Empty>No outstanding receivables.</Empty>}
      </div>
      <div className="filters">
        <Field label="Search"><input value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder="Invoice no. or customer" /></Field>
        <Field label="Status"><select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">All</option>{['UNPAID', 'PARTIAL', 'PAID', 'VOID'].map((s) => <option key={s}>{s}</option>)}</select></Field>
        <label className="row small"><input type="checkbox" checked={f.overdue === '1'} onChange={(e) => setF({ ...f, overdue: e.target.checked ? '1' : '' })} /> Overdue only</label>
      </div>
      <ErrorBox error={list.error} />
      {list.loading && !list.data ? <Spinner /> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Number</th><th>Customer</th><th>Type</th><th>Status</th><th>Issued</th><th>Due</th><th className="num">Lines</th><th className="num">Total</th><th className="num">Balance</th></tr></thead>
          <tbody>{list.data?.rows.map((i) => (
            <tr key={i.id} className="clickable" onClick={() => nav(`/invoices/${i.id}`)}><td className="mono"><b>{i.number}</b></td><td>{i.customer_name}</td><td>{i.type}</td><td><Badge s={i.status} /></td>
              <td>{dOnly(i.issue_date)}</td><td>{dOnly(i.due_date)}</td><td className="num">{i.line_count}</td><td className="num">{aed(i.total)}</td><td className="num">{aed(i.balance)}</td></tr>))}</tbody>
        </table>{!list.data?.rows.length && <Empty>No invoices.</Empty>}</div>
      )}
      {billing && <BillingRun onClose={() => setBilling(false)} onDone={(inv) => nav(`/invoices/${inv.id}`)} />}
    </>
  );
}

function BillingRun({ onClose, onDone }) {
  const customers = useLoad(() => api.get('/api/admin/customers'), []);
  const [cid, setCid] = useState('');
  const [to, setTo] = useState('');
  const billable = useLoad(() => (cid ? api.get(`/api/finance/billable${qs({ customer_id: cid, to })}`) : Promise.resolve([])), [cid, to]);
  const [run, busy] = useAction();
  const total = (billable.data || []).reduce((a, s) => a + s.total_charge, 0);
  return (
    <Modal title="Account billing run" onClose={onClose} wide
      footer={<button className="btn primary" disabled={!billable.data?.length || busy} onClick={() => run(() => api.post('/api/finance/invoices/generate', { customer_id: Number(cid), to: to || undefined }), 'Invoice generated').then(onDone)}>Generate invoice · {aed(total)}</button>}>
      <div className="grid g2">
        <Field label="Account customer"><select value={cid} onChange={(e) => setCid(e.target.value)}><option value="">Select…</option>
          {customers.data?.filter((c) => c.type === 'ACCOUNT').map((c) => <option key={c.id} value={c.id}>{c.name} ({c.code})</option>)}</select></Field>
        <Field label="Shipments up to (optional)"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      <div style={{ maxHeight: 340, overflowY: 'auto', marginTop: 12 }}>
        <table><thead><tr><th>AWB</th><th>Date</th><th>Route</th><th className="num">Kg</th><th className="num">Net</th><th className="num">VAT</th><th className="num">Total</th></tr></thead>
          <tbody>{billable.data?.map((s) => <tr key={s.id}><td className="mono">{s.awb}</td><td>{dOnly(s.created_at)}</td><td>{s.origin_city} → {s.dest_city}</td><td className="num">{s.chargeable_weight}</td><td className="num">{s.subtotal.toFixed(2)}</td><td className="num">{s.vat.toFixed(2)}</td><td className="num">{s.total_charge.toFixed(2)}</td></tr>)}</tbody></table>
        {cid && billable.data && !billable.data.length && <Empty>No uninvoiced, picked-up shipments.</Empty>}
      </div>
    </Modal>
  );
}

export function InvoiceDetail() {
  const { id } = useParams();
  const meta = useMeta();
  const { user } = useSession();
  const d = useLoad(() => api.get(`/api/finance/invoices/${id}`), [id]);
  const [pay, setPay] = useState(false);
  const [run, busy] = useAction();
  if (d.loading && !d.data) return <Spinner />;
  if (d.error) return <ErrorBox error={d.error} />;
  const inv = d.data;
  const canPay = ['ADMIN', 'FINANCE'].includes(user.role) && ['UNPAID', 'PARTIAL'].includes(inv.status);
  return (
    <>
      <div className="page-head no-print"><div><Link to="/invoices" className="small">‹ Invoices</Link><h1 className="mono">{inv.number} <Badge s={inv.status} /></h1></div>
        <div className="row">
          <button className="btn" onClick={() => window.print()}>🖨️ Print / PDF</button>
          {canPay && <button className="btn primary" onClick={() => setPay(true)}>Record payment</button>}
          {user.role === 'ADMIN' && inv.paid === 0 && inv.status !== 'VOID' && <button className="btn danger" disabled={busy} onClick={() => {
            const reason = prompt('Reason for voiding this invoice?');
            if (reason) run(() => api.post(`/api/finance/invoices/${inv.id}/void`, { reason }), 'Invoice voided').then(d.reload);
          }}>Void</button>}
        </div></div>
      <InvoiceDoc inv={inv} company={meta.company} />
      {pay && <PaymentModal inv={inv} onClose={() => setPay(false)} onDone={() => { setPay(false); d.reload(); }} />}
    </>
  );
}

function PaymentModal({ inv, onClose, onDone }) {
  const [v, , bind] = useForm({ amount: Number(inv.balance.toFixed(2)), method: 'BANK', reference: '' });
  const [run, busy] = useAction();
  return (
    <Modal title={`Record payment — ${inv.number}`} onClose={onClose}
      footer={<button className="btn primary" disabled={busy} onClick={() => run(() => api.post(`/api/finance/invoices/${inv.id}/payments`, { ...v, reference: v.reference || undefined }), 'Payment recorded').then(onDone)}>Save payment</button>}>
      <div className="grid g3">
        <Field label="Amount (AED)"><input {...bind('amount', 'number')} /></Field>
        <Field label="Method"><select {...bind('method')}>{['BANK', 'CASH', 'CARD', 'ONLINE'].map((m) => <option key={m}>{m}</option>)}</select></Field>
        <Field label="Reference"><input {...bind('reference')} placeholder="TT / cheque / txn no." /></Field>
      </div>
      <div className="small muted" style={{ marginTop: 8 }}>Balance due {aed(inv.balance)}</div>
    </Modal>
  );
}

export function CashCod() {
  const { user } = useSession();
  const cash = useLoad(() => api.get('/api/finance/driver-cash'), []);
  const cod = useLoad(() => api.get('/api/finance/cod'), []);
  const sets = useLoad(() => api.get('/api/finance/settlements'), []);
  const [run, busy] = useAction();
  const canWrite = ['ADMIN', 'FINANCE'].includes(user.role);
  const settle = (d) => {
    const v = prompt(`Cash counted from ${d.name} (expected ${d.cash_in_hand.toFixed(2)} AED):`, d.cash_in_hand.toFixed(2));
    if (v == null) return;
    run(() => api.post(`/api/finance/driver-cash/${d.driver_id}/settle`, { amount_received: Number(v) }), 'Cash settled').then(() => { cash.reload(); sets.reload(); });
  };
  const remit = (c) => {
    const ref = prompt(`Bank transfer reference for COD ${c.amount.toFixed(2)} AED to ${c.name}:`);
    if (ref) run(() => api.post(`/api/finance/cod/${c.customer_id}/remit`, { reference: ref }), 'COD remitted').then(cod.reload);
  };
  return (
    <>
      <div className="page-head"><h1>Driver cash & COD</h1></div>
      <div className="card"><h3>Cash with drivers (not yet handed over)</h3>
        {cash.loading ? <Spinner /> : <table><thead><tr><th>Driver</th><th className="num">Cash in hand</th><th className="num">of which COD</th><th className="num">Card (info)</th><th className="num">Collections</th><th>Oldest</th><th /></tr></thead>
          <tbody>{cash.data?.map((d) => <tr key={d.driver_id}><td>{d.name}<div className="tiny muted">{d.vehicle_no}</div></td><td className="num"><b>{aed(d.cash_in_hand)}</b></td>
            <td className="num">{aed(d.cod_cash)}</td><td className="num">{aed(d.card_total)}</td><td className="num">{d.collections}</td><td className="small">{d.oldest ? ago(d.oldest) : '—'}</td>
            <td className="right">{canWrite && d.collections > 0 && <button className="btn sm primary" disabled={busy} onClick={() => settle(d)}>Settle</button>}</td></tr>)}</tbody></table>}
        <div className="tiny muted">Settlement must match counted cash exactly; shortages must be investigated before closing.</div>
      </div>
      <div className="card"><h3>COD collected — pending remittance to shippers</h3>
        <table><thead><tr><th>Customer</th><th className="num">Shipments</th><th className="num">Amount</th><th /></tr></thead>
          <tbody>{cod.data?.map((c) => <tr key={c.customer_id}><td>{c.name} ({c.code})</td><td className="num">{c.shipments}</td><td className="num"><b>{aed(c.amount)}</b></td>
            <td className="right">{canWrite && <button className="btn sm" disabled={busy} onClick={() => remit(c)}>Mark remitted</button>}</td></tr>)}</tbody></table>
        {cod.data && !cod.data.length && <Empty>No COD pending.</Empty>}
      </div>
      <div className="card"><h3>Recent settlements</h3>
        <table><tbody>{sets.data?.map((s) => <tr key={s.id}><td>#{s.id}</td><td>{s.driver_name}</td><td className="num">{aed(s.amount)}</td><td className="small">{dt(s.created_at)} · received by {s.received_by_name}</td></tr>)}</tbody></table>
      </div>
    </>
  );
}
