// CRM: sales pipeline (kanban), lead detail & conversion, follow-ups, support tickets, Customer 360.
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../ctx.js';
import { useLoad, useAction, Spinner, ErrorBox, Badge, Modal, Field, Empty, useForm, Stat } from '../../shared/ui.jsx';
import { aed, dt, ago, dOnly, telLink, waLink, UAE_CITIES } from '../../shared/format.js';
import { useSession } from '../../shared/session.jsx';
import { KycCard } from './Shipments.jsx';
import { money, REGIONS } from '../../shared/format.js';

const STAGES = ['NEW', 'CONTACTED', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION', 'LOST'];
const ACT_IC = { CALL: '📞', MEETING: '🤝', EMAIL: '✉️', WHATSAPP: '💬', NOTE: '📝', TASK: '✅' };

export function Pipeline() {
  const nav = useNavigate();
  const { user } = useSession();
  const leads = useLoad(() => api.get('/api/crm/leads'), []);
  const pipe = useLoad(() => api.get('/api/crm/pipeline'), []);
  const [creating, setCreating] = useState(false);
  const [over, setOver] = useState(null);
  const [run] = useAction();
  const canEdit = ['ADMIN', 'SALES'].includes(user.role);
  const move = (id, stage) => {
    const body = { stage };
    if (stage === 'LOST') { const r = prompt('Lost reason?'); if (!r) return; body.lost_reason = r; }
    run(() => api.patch(`/api/crm/leads/${id}`, body), `Moved to ${stage}`).then(() => { leads.reload(true); pipe.reload(true); });
  };
  const by = (s) => (leads.data || []).filter((l) => l.stage === s);
  return (
    <>
      <div className="page-head"><h1>Sales pipeline</h1>{canEdit && <button className="btn primary" onClick={() => setCreating(true)}>+ New lead</button>}</div>
      {pipe.data && (
        <div className="grid g4">
          <Stat label="Open leads" value={pipe.data.stages.filter((s) => !['WON', 'LOST'].includes(s.stage)).reduce((a, s) => a + s.count, 0)} />
          <Stat label="Weighted pipeline / month" value={aed(pipe.data.open_weighted)} />
          <Stat label="Won" value={pipe.data.stages.find((s) => s.stage === 'WON')?.count || 0} />
          <Stat label="Win rate" value={pipe.data.win_rate == null ? '—' : `${pipe.data.win_rate}%`} />
        </div>
      )}
      <ErrorBox error={leads.error} />
      {leads.loading && !leads.data ? <Spinner /> : (
        <div className="kanban">
          {STAGES.map((st) => {
            const items = by(st);
            const value = items.reduce((a, l) => a + l.est_monthly_value, 0);
            return (
              <div key={st} className={`colm ${over === st ? 'over' : ''}`}
                onDragOver={(e) => { if (canEdit) { e.preventDefault(); setOver(st); } }} onDragLeave={() => setOver(null)}
                onDrop={(e) => { setOver(null); const id = Number(e.dataTransfer.getData('text/plain')); if (id) move(id, st); }}>
                <div className="row between"><Badge s={st} /><span className="tiny muted">{items.length} · {aed(value)}</span></div>
                {items.map((l) => (
                  <div key={l.id} className="lead" draggable={canEdit} onDragStart={(e) => e.dataTransfer.setData('text/plain', String(l.id))} onClick={() => nav(`/crm/leads/${l.id}`)}>
                    <b>{l.company}</b><div className="small muted">{l.contact_name}</div>
                    <div className="row between tiny"><span>{aed(l.est_monthly_value)}/mo · {l.probability}%</span><span>{l.owner_name}</span></div>
                    {l.next_action_at && <div className="tiny" style={{ color: new Date(`${l.next_action_at.replace(' ', 'T')}Z`) < new Date() ? 'var(--bad)' : 'var(--text-2)' }}>⏰ {dt(l.next_action_at)}</div>}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
      <div className="tiny muted">Drag cards between columns to update stage. Winning a lead is done via “Convert to customer” on the lead.</div>
      {creating && <LeadModal onClose={() => setCreating(false)} onDone={(l) => nav(`/crm/leads/${l.id}`)} />}
    </>
  );
}

function LeadModal({ onClose, onDone }) {
  const [v, , bind] = useForm({ company: '', contact_name: '', phone: '', email: '', city: 'Dubai', source: 'WEBSITE', est_monthly_shipments: 0, est_monthly_value: 0, expected_close: '', notes: '' });
  const [run, busy] = useAction();
  const save = () => run(() => api.post('/api/crm/leads', { ...v, expected_close: v.expected_close || undefined }), 'Lead created').then(onDone);
  return (
    <Modal title="New lead" onClose={onClose} footer={<button className="btn primary" disabled={busy || !v.company || !v.contact_name} onClick={save}>Create lead</button>}>
      <div className="grid g2">
        <Field label="Company"><input {...bind('company')} required /></Field>
        <Field label="Contact person"><input {...bind('contact_name')} required /></Field>
        <Field label="Phone"><input {...bind('phone')} type="tel" /></Field>
        <Field label="Email"><input {...bind('email')} type="email" /></Field>
        <Field label="City"><select {...bind('city')}>{UAE_CITIES.map((c) => <option key={c}>{c}</option>)}</select></Field>
        <Field label="Source"><select {...bind('source')}>{['WEBSITE', 'REFERRAL', 'COLD_CALL', 'WALK_IN', 'EXHIBITION', 'SOCIAL', 'OTHER'].map((s) => <option key={s}>{s}</option>)}</select></Field>
        <Field label="Est. shipments / month"><input {...bind('est_monthly_shipments', 'number')} /></Field>
        <Field label="Est. value / month (AED)"><input {...bind('est_monthly_value', 'number')} /></Field>
        <Field label="Expected close"><input {...bind('expected_close')} type="date" /></Field>
      </div>
      <Field label="Notes"><textarea {...bind('notes')} /></Field>
    </Modal>
  );
}

function ActivityLog({ entity, entityId, items, onChange }) {
  const [v, setV, bind] = useForm({ type: 'CALL', subject: '', notes: '', due_at: '', done: true });
  const [run, busy] = useAction();
  const add = () => run(() => api.post('/api/crm/activities', { entity, entity_id: entityId, ...v, due_at: v.due_at ? v.due_at.replace('T', ' ') + ':00' : undefined, done: v.type === 'TASK' ? false : v.done }), 'Logged')
    .then(() => { setV({ ...v, subject: '', notes: '', due_at: '' }); onChange(); });
  return (
    <div className="card stack">
      <h3>Activities & follow-ups</h3>
      <div className="grid g4">
        <Field label="Type"><select {...bind('type')}>{Object.keys(ACT_IC).map((t) => <option key={t}>{t}</option>)}</select></Field>
        <Field label="Subject" span={2}><input {...bind('subject')} placeholder="e.g. Rate discussion" /></Field>
        <Field label="Follow-up due"><input type="datetime-local" {...bind('due_at')} /></Field>
      </div>
      <Field label="Notes"><textarea {...bind('notes')} style={{ minHeight: 50 }} /></Field>
      <div className="row"><label className="row small"><input type="checkbox" checked={v.done && v.type !== 'TASK'} disabled={v.type === 'TASK'} onChange={(e) => setV({ ...v, done: e.target.checked })} /> Already done</label>
        <span className="spacer" /><button className="btn primary" disabled={busy || !v.subject} onClick={add}>Add</button></div>
      <ul className="timeline">{items.map((a) => (
        <li key={a.id} className={a.done ? '' : 'private'}>
          <b>{ACT_IC[a.type]} {a.subject}</b> {!a.done && <Badge tone="warn">Due {dt(a.due_at)}</Badge>}
          {a.notes && <div className="small">{a.notes}</div>}
          <div className="tiny muted">{a.owner_name} · {dt(a.created_at)} {!a.done && <button className="btn sm ghost" onClick={() => api.post(`/api/crm/activities/${a.id}/done`).then(onChange)}>Mark done</button>}</div>
        </li>))}</ul>
    </div>
  );
}

export function LeadDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { user } = useSession();
  const d = useLoad(() => api.get(`/api/crm/leads/${id}`), [id]);
  const [convert, setConvert] = useState(false);
  if (d.loading && !d.data) return <Spinner />;
  if (d.error) return <ErrorBox error={d.error} />;
  const l = d.data;
  const canEdit = ['ADMIN', 'SALES'].includes(user.role);
  return (
    <>
      <div className="page-head"><div><Link to="/crm" className="small">‹ Pipeline</Link><h1>{l.company} <Badge s={l.stage} /></h1>
        <div className="muted small">{l.contact_name} · {l.city} · source {l.source} · owner {l.owner_name}</div></div>
        <div className="row">
          {l.phone && <a className="btn" href={telLink(l.phone)}>📞 Call</a>}
          {l.phone && <a className="btn" href={waLink(l.phone, `Hello ${l.contact_name}, this is ABC Cargo & Courier.`)} target="_blank" rel="noreferrer">💬 WhatsApp</a>}
          {l.email && <a className="btn" href={`mailto:${l.email}`}>✉️ Email</a>}
          {canEdit && !l.customer_id && l.stage !== 'LOST' && <button className="btn ok" onClick={() => setConvert(true)}>🏆 Convert to customer</button>}
          {l.customer_id && <Link className="btn primary" to={`/customers/${l.customer_id}`}>Open customer</Link>}
        </div></div>
      <div className="grid g4">
        <Stat label="Est. shipments / mo" value={l.est_monthly_shipments} />
        <Stat label="Est. value / mo" value={aed(l.est_monthly_value)} />
        <Stat label="Probability" value={`${l.probability}%`} />
        <Stat label="Expected close" value={dOnly(l.expected_close)} />
      </div>
      {l.notes && <div className="card small">{l.notes}</div>}
      {l.lost_reason && <div className="alert warn">Lost: {l.lost_reason}</div>}
      <ActivityLog entity="LEAD" entityId={l.id} items={l.activities} onChange={() => d.reload(true)} />
      {convert && <ConvertModal lead={l} onClose={() => setConvert(false)} onDone={(c) => nav(`/customers/${c.id}`)} />}
    </>
  );
}

function ConvertModal({ lead, onClose, onDone }) {
  const [v, , bind] = useForm({ type: 'ACCOUNT', credit_limit: Math.round(lead.est_monthly_value * 1.5), payment_terms_days: 30, trn: '', address: '' });
  const [run, busy] = useAction();
  return (
    <Modal title={`Convert ${lead.company}`} onClose={onClose}
      footer={<button className="btn ok" disabled={busy} onClick={() => run(() => api.post(`/api/crm/leads/${lead.id}/convert`, { ...v, trn: v.trn || undefined, address: v.address || undefined }), 'Customer account opened').then(onDone)}>Open account</button>}>
      <div className="grid g2">
        <Field label="Account type"><select {...bind('type')}><option value="ACCOUNT">Credit account (monthly invoice)</option><option value="CASH">Cash / prepaid</option></select></Field>
        <Field label="Credit limit (AED)"><input {...bind('credit_limit', 'number')} /></Field>
        <Field label="Payment terms (days)"><input {...bind('payment_terms_days', 'number')} /></Field>
        <Field label="TRN (VAT no.)"><input {...bind('trn')} /></Field>
        <Field label="Billing address" span={2}><input {...bind('address')} /></Field>
      </div>
    </Modal>
  );
}

export function CrmTasks() {
  const [all, setAll] = useState(false);
  const t = useLoad(() => api.get(`/api/crm/tasks${all ? '?all=1' : ''}`), [all]);
  return (
    <>
      <div className="page-head"><h1>Follow-ups</h1><label className="row small"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Whole team</label></div>
      {t.loading ? <Spinner /> : (
        <div className="table-wrap"><table><thead><tr><th>Due</th><th>Type</th><th>Subject</th><th>For</th><th /></tr></thead>
          <tbody>{t.data?.map((a) => {
            const late = new Date(`${a.due_at.replace(' ', 'T')}Z`) < new Date();
            return <tr key={a.id}><td>{late ? <Badge tone="bad">{dt(a.due_at)}</Badge> : dt(a.due_at)}</td><td>{ACT_IC[a.type]} {a.type}</td><td>{a.subject}</td>
              <td><Link to={a.entity === 'LEAD' ? `/crm/leads/${a.entity_id}` : `/customers/${a.entity_id}`}>{a.entity_name}</Link></td>
              <td className="right"><button className="btn sm" onClick={() => api.post(`/api/crm/activities/${a.id}/done`).then(() => t.reload(true))}>Done</button></td></tr>;
          })}</tbody></table>{!t.data?.length && <Empty>No open follow-ups. 🎉</Empty>}</div>
      )}
    </>
  );
}

export function Tickets() {
  const nav = useNavigate();
  const [open, setOpen] = useState('1');
  const t = useLoad(() => api.get(`/api/crm/tickets?open=${open}`), [open]);
  const [creating, setCreating] = useState(false);
  return (
    <>
      <div className="page-head"><h1>Support tickets</h1>
        <div className="row"><select value={open} onChange={(e) => setOpen(e.target.value)} style={{ width: 160 }}><option value="1">Open</option><option value="">All</option></select>
          <button className="btn primary" onClick={() => setCreating(true)}>+ New ticket</button></div></div>
      {t.loading && !t.data ? <Spinner /> : (
        <div className="table-wrap"><table><thead><tr><th>Ticket</th><th>Priority</th><th>Status</th><th>Subject</th><th>Customer</th><th>AWB</th><th>SLA due</th><th>Assigned</th><th>Updated</th></tr></thead>
          <tbody>{t.data?.map((x) => (
            <tr key={x.id} className="clickable" onClick={() => nav(`/tickets/${x.id}`)}><td className="mono">{x.number}</td><td><Badge s={x.priority} /></td><td><Badge s={x.status} /></td>
              <td>{x.subject}<div className="tiny muted">{x.category} · {x.channel}</div></td><td>{x.customer_name || '—'}</td><td className="mono small">{x.awb || '—'}</td>
              <td>{x.sla_breached ? <Badge tone="bad">Breached</Badge> : <span className="small">{dt(x.sla_due_at)}</span>}</td><td className="small">{x.assigned_name || '—'}</td><td className="small muted">{ago(x.updated_at)}</td></tr>))}</tbody>
        </table>{!t.data?.length && <Empty>No tickets.</Empty>}</div>
      )}
      {creating && <TicketModal onClose={() => setCreating(false)} onDone={(x) => nav(`/tickets/${x.id}`)} />}
    </>
  );
}

function TicketModal({ onClose, onDone }) {
  const customers = useLoad(() => api.get('/api/admin/customers'), []);
  const [v, , bind] = useForm({ customer_id: '', awb: '', category: 'DELAY', priority: 'MEDIUM', channel: 'PHONE', subject: '', description: '' });
  const [run, busy] = useAction();
  const save = () => run(() => api.post('/api/crm/tickets', { ...v, customer_id: v.customer_id ? Number(v.customer_id) : undefined, awb: v.awb || undefined, description: v.description || undefined }), 'Ticket created').then(onDone);
  return (
    <Modal title="New support ticket" onClose={onClose} footer={<button className="btn primary" disabled={busy || !v.subject} onClick={save}>Create</button>}>
      <div className="grid g3">
        <Field label="Customer"><select {...bind('customer_id')}><option value="">— (from AWB)</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <Field label="AWB"><input {...bind('awb')} /></Field>
        <Field label="Channel"><select {...bind('channel')}>{['PHONE', 'EMAIL', 'WHATSAPP', 'WALK_IN', 'PORTAL'].map((c) => <option key={c}>{c}</option>)}</select></Field>
        <Field label="Category"><select {...bind('category')}>{['DELAY', 'DAMAGE', 'LOST', 'BILLING', 'PICKUP', 'COD', 'OTHER'].map((c) => <option key={c}>{c}</option>)}</select></Field>
        <Field label="Priority"><select {...bind('priority')}>{['LOW', 'MEDIUM', 'HIGH', 'URGENT'].map((c) => <option key={c}>{c}</option>)}</select></Field>
      </div>
      <Field label="Subject"><input {...bind('subject')} /></Field>
      <Field label="Description"><textarea {...bind('description')} /></Field>
    </Modal>
  );
}

export function TicketDetail() {
  const { id } = useParams();
  const d = useLoad(() => api.get(`/api/crm/tickets/${id}`), [id]);
  const staff = useLoad(() => api.get('/api/admin/staff'), []);
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const [run, busy] = useAction();
  if (d.loading && !d.data) return <Spinner />;
  if (d.error) return <ErrorBox error={d.error} />;
  const t = d.data;
  const patch = (b) => run(() => api.patch(`/api/crm/tickets/${t.id}`, b), 'Updated').then(() => d.reload(true));
  return (
    <>
      <div className="page-head"><div><Link to="/tickets" className="small">‹ Tickets</Link><h1>{t.number} · {t.subject}</h1>
        <div className="muted small">{t.category} · via {t.channel} · {t.customer_name && <Link to={`/customers/${t.customer_id}`}>{t.customer_name}</Link>} {t.awb && <> · <Link to={`/shipments/${t.shipment_id}`} className="mono">{t.awb}</Link></>} · opened {dt(t.created_at)}</div></div>
        {t.sla_breached ? <Badge tone="bad">SLA breached</Badge> : <Badge tone="info">SLA {dt(t.sla_due_at)}</Badge>}</div>
      <div className="grid g3">
        <Field label="Status"><select value={t.status} onChange={(e) => patch({ status: e.target.value })}>{['OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED', 'CLOSED'].map((s) => <option key={s}>{s}</option>)}</select></Field>
        <Field label="Priority"><select value={t.priority} onChange={(e) => patch({ priority: e.target.value })}>{['LOW', 'MEDIUM', 'HIGH', 'URGENT'].map((s) => <option key={s}>{s}</option>)}</select></Field>
        <Field label="Assigned to"><select value={t.assigned_to || ''} onChange={(e) => patch({ assigned_to: e.target.value ? Number(e.target.value) : null })}><option value="">Unassigned</option>{staff.data?.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.role})</option>)}</select></Field>
      </div>
      {t.description && <div className="card">{t.description}</div>}
      <div className="card stack">
        <h3>Conversation</h3>
        <ul className="timeline">{t.comments.map((c) => <li key={c.id} className={c.internal ? 'private' : ''}><b className="small">{c.user_name}</b> <span className="tiny muted">{c.user_role} · {dt(c.created_at)}</span>
          {c.internal ? <Badge tone="muted">Internal</Badge> : null}<div>{c.body}</div></li>)}</ul>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Reply to customer or add an internal note…" />
        <div className="row"><label className="row small"><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Internal note (hidden from customer)</label><span className="spacer" />
          <button className="btn primary" disabled={busy || !body.trim()} onClick={() => run(() => api.post(`/api/crm/tickets/${t.id}/comments`, { body, internal })).then(() => { setBody(''); d.reload(true); })}>Send</button></div>
      </div>
    </>
  );
}

export function Customer360() {
  const { id } = useParams();
  const d = useLoad(() => api.get(`/api/crm/customers/${id}/360`), [id]);
  const [contact, setContact] = useState(false);
  if (d.loading && !d.data) return <Spinner />;
  if (d.error) return <ErrorBox error={d.error} />;
  const { customer: c, kpi } = d.data;
  return (
    <>
      <div className="page-head"><div><Link to="/customers" className="small">‹ Customers</Link><h1>{c.name} <Badge tone={c.type === 'ACCOUNT' ? 'info' : 'muted'}>{c.type}</Badge> <span className="badge">{REGIONS[c.entity_code]?.flag} {c.entity_code}</span></h1>
        <div className="muted small">{c.code} · {c.industry || '—'} · {c.city} · TRN {c.trn || '—'} · account manager {c.account_manager || '—'}</div></div>
        <div className="row">{c.phone && <a className="btn" href={telLink(c.phone)}>📞 Call</a>}{c.phone && <a className="btn" href={waLink(c.phone)} target="_blank" rel="noreferrer">💬 WhatsApp</a>}</div></div>
      <div className="grid g4">
        <Stat label="Shipments (30d)" value={kpi.shipments_30d || 0} sub={`${kpi.shipments} lifetime · last ${ago(kpi.last_shipment_at)}`} />
        <Stat label="Revenue (30d)" value={aed(kpi.revenue_30d)} sub={`Lifetime ${aed(kpi.lifetime_revenue)}`} />
        <Stat label="Outstanding" value={aed(kpi.outstanding)} sub={`Overdue ${aed(kpi.overdue)}`} alert={kpi.overdue > 0} />
        <Stat label={c.type === 'ACCOUNT' ? 'Credit available' : 'COD pending'} value={c.type === 'ACCOUNT' ? aed(kpi.credit_available) : aed(kpi.cod_pending)} alert={c.type === 'ACCOUNT' && kpi.credit_available < 0} />
      </div>
      <div className="grid g2">
        <div className="stack">
          <div className="card"><div className="row between"><h3>Contacts</h3><button className="btn sm" onClick={() => setContact(true)}>+ Add</button></div>
            <table><tbody>{d.data.contacts.map((p) => <tr key={p.id}><td><b>{p.name}</b> {p.is_primary ? <Badge tone="ok">Primary</Badge> : null}<div className="tiny muted">{p.title}</div></td><td className="small">{p.phone}<br />{p.email}</td></tr>)}</tbody></table>
            {!d.data.contacts.length && <Empty>No contacts.</Empty>}</div>
          <div className="card"><h3>Recent shipments</h3><table><tbody>{d.data.recent_shipments.map((s) => <tr key={s.id}><td><Link to={`/shipments/${s.id}`} className="mono">{s.awb}</Link></td><td><Badge s={s.status} /></td><td>{s.dest_city}</td><td className="num">{aed(s.total_charge)}</td></tr>)}</tbody></table></div>
          <div className="card"><h3>Invoices</h3><table><tbody>{d.data.invoices.map((i) => <tr key={i.id}><td><Link to={`/invoices/${i.id}`} className="mono">{i.number}</Link></td><td><Badge s={i.status} /></td><td className="num">{aed(i.total)}</td><td className="small">due {dOnly(i.due_date)}</td></tr>)}</tbody></table></div>
          <div className="card"><h3>Tickets</h3><table><tbody>{d.data.tickets.map((t) => <tr key={t.id}><td><Link to={`/tickets/${t.id}`}>{t.number}</Link></td><td>{t.subject}</td><td><Badge s={t.status} /></td></tr>)}</tbody></table>{!d.data.tickets.length && <Empty>No tickets.</Empty>}</div>
        </div>
        <div className="stack">
          <ActivityLog entity="CUSTOMER" entityId={c.id} items={d.data.activities} onChange={() => d.reload(true)} />
          <Receivers cid={c.id} />
          <KycCard ownerType="CUSTOMER" ownerId={c.id} />
        </div>
      </div>
      {contact && <ContactModal cid={c.id} onClose={() => setContact(false)} onDone={() => { setContact(false); d.reload(true); }} />}
    </>
  );
}

function ContactModal({ cid, onClose, onDone }) {
  const [v, setV, bind] = useForm({ name: '', title: '', phone: '', email: '', is_primary: false });
  const [run, busy] = useAction();
  return (
    <Modal title="Add contact" onClose={onClose} footer={<button className="btn primary" disabled={busy || !v.name} onClick={() => run(() => api.post(`/api/crm/customers/${cid}/contacts`, v), 'Contact added').then(onDone)}>Save</button>}>
      <div className="grid g2">
        <Field label="Name"><input {...bind('name')} /></Field><Field label="Title"><input {...bind('title')} /></Field>
        <Field label="Phone"><input {...bind('phone')} type="tel" /></Field><Field label="Email"><input {...bind('email')} type="email" /></Field>
      </div>
      <label className="row small" style={{ marginTop: 8 }}><input type="checkbox" checked={v.is_primary} onChange={(e) => setV({ ...v, is_primary: e.target.checked })} /> Primary contact</label>
    </Modal>
  );
}

function Receivers({ cid }) {
  const list = useLoad(() => api.get(`/api/quotations/customers/${cid}/receivers`), [cid]);
  return (
    <div className="card"><h3>📒 Saved receivers</h3>
      {list.data?.length ? <table><tbody>{list.data.map((r) => <tr key={r.id}><td><b>{r.name}</b>{r.relation ? <span className="tiny muted"> · {r.relation}</span> : null}<div className="tiny muted">{r.phone}</div></td>
        <td className="small">{r.address}, {r.city} {r.postcode} · {r.country}</td><td className="num tiny">{r.use_count}×</td></tr>)}</tbody></table>
        : <Empty>No saved receivers — they are added automatically on booking.</Empty>}
    </div>
  );
}
