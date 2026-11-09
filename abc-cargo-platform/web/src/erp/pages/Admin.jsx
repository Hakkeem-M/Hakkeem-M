import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../ctx.js';
import { useLoad, useAction, Spinner, ErrorBox, Badge, Modal, Field, Empty, useForm } from '../../shared/ui.jsx';
import { aed, dt, UAE_CITIES, SERVICES } from '../../shared/format.js';
import { useSession } from '../../shared/session.jsx';

export function Customers() {
  const nav = useNavigate();
  const { user } = useSession();
  const [q, setQ] = useState('');
  const list = useLoad(() => api.get(`/api/admin/customers?q=${encodeURIComponent(q)}`), [q]);
  const [edit, setEdit] = useState(null);
  return (
    <>
      <div className="page-head"><h1>Customers</h1>
        <div className="row"><input placeholder="Search name, code, phone" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 260 }} />
          {['ADMIN', 'SALES', 'FINANCE', 'OPS'].includes(user.role) && <button className="btn primary" onClick={() => setEdit({})}>+ New customer</button>}</div></div>
      <ErrorBox error={list.error} />
      {list.loading && !list.data ? <Spinner /> : (
        <div className="table-wrap"><table><thead><tr><th>Code</th><th>Name</th><th>Type</th><th>City</th><th>Phone</th><th>Account manager</th><th className="num">Shipments</th><th className="num">Outstanding</th><th className="num">Credit limit</th><th /></tr></thead>
          <tbody>{list.data?.map((c) => (
            <tr key={c.id} className="clickable" onClick={() => nav(`/customers/${c.id}`)}><td className="mono">{c.code}</td><td><b>{c.name}</b>{!c.active && <Badge tone="muted">inactive</Badge>}</td>
              <td><Badge tone={c.type === 'ACCOUNT' ? 'info' : 'muted'}>{c.type}</Badge></td><td>{c.city}</td><td className="small">{c.phone}</td><td className="small">{c.account_manager || '—'}</td>
              <td className="num">{c.shipments}</td><td className="num">{aed(c.outstanding)}</td><td className="num">{c.credit_limit ? aed(c.credit_limit) : '—'}</td>
              <td><button className="btn sm" onClick={(e) => { e.stopPropagation(); setEdit(c); }}>Edit</button></td></tr>))}</tbody></table>
          {!list.data?.length && <Empty>No customers.</Empty>}</div>
      )}
      {edit && <CustomerModal c={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); list.reload(true); }} />}
    </>
  );
}

function CustomerModal({ c, onClose, onDone }) {
  const staff = useLoad(() => api.get('/api/admin/staff'), []);
  const [v, setV, bind] = useForm({ name: '', type: 'ACCOUNT', phone: '', email: '', address: '', city: 'Dubai', trn: '', industry: '', credit_limit: 0, payment_terms_days: 30, account_manager_id: '', active: true, ...c, active: c.active === undefined ? true : !!c.active });
  const [run, busy] = useAction();
  const save = () => {
    const body = { ...v };
    for (const k of ['id', 'code', 'created_at', 'shipments', 'outstanding', 'account_manager', 'lat', 'lng']) delete body[k];
    return run(() => (c.id ? api.put(`/api/admin/customers/${c.id}`, body) : api.post('/api/admin/customers', body)), 'Customer saved').then(onDone);
  };
  return (
    <Modal title={c.id ? `Edit ${c.name}` : 'New customer'} onClose={onClose} footer={<button className="btn primary" disabled={busy || !v.name} onClick={save}>Save</button>}>
      <div className="grid g2">
        <Field label="Name"><input {...bind('name')} /></Field>
        <Field label="Type"><select {...bind('type')}><option value="ACCOUNT">Account (credit)</option><option value="CASH">Cash / prepaid</option></select></Field>
        <Field label="Phone"><input {...bind('phone')} /></Field><Field label="Email"><input {...bind('email')} /></Field>
        <Field label="City"><select {...bind('city')}>{UAE_CITIES.map((x) => <option key={x}>{x}</option>)}</select></Field>
        <Field label="Address"><input {...bind('address')} /></Field>
        <Field label="TRN"><input {...bind('trn')} /></Field><Field label="Industry"><input {...bind('industry')} /></Field>
        <Field label="Credit limit (AED)" hint="Finance only"><input {...bind('credit_limit', 'number')} /></Field>
        <Field label="Payment terms (days)"><input {...bind('payment_terms_days', 'number')} /></Field>
        <Field label="Account manager"><select {...bind('account_manager_id')}><option value="">—</option>{staff.data?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
        <label className="row small"><input type="checkbox" checked={v.active} onChange={(e) => setV({ ...v, active: e.target.checked })} /> Active</label>
      </div>
    </Modal>
  );
}

const ROLES = ['ADMIN', 'OPS', 'FINANCE', 'SALES', 'WAREHOUSE', 'DRIVER', 'CUSTOMER'];
export function Users() {
  const { user } = useSession();
  const list = useLoad(() => api.get('/api/admin/users'), []);
  const [edit, setEdit] = useState(null);
  return (
    <>
      <div className="page-head"><h1>Users & roles</h1>{user.role === 'ADMIN' && <button className="btn primary" onClick={() => setEdit({})}>+ New user</button>}</div>
      <div className="card small muted">Roles: ADMIN (everything) · OPS (shipments, dispatch, warehouse) · FINANCE (billing, cash, COD) · SALES (CRM) · WAREHOUSE (scanner app) · DRIVER (driver app) · CUSTOMER (customer app).</div>
      {list.loading ? <Spinner /> : (
        <div className="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Branch</th><th>Vehicle / capacity</th><th>Customer</th><th>Last login</th><th>Status</th><th /></tr></thead>
          <tbody>{list.data?.map((u) => <tr key={u.id}><td><b>{u.name}</b><div className="tiny muted">{u.phone}</div></td><td className="small">{u.email}</td><td><Badge tone="info">{u.role}</Badge></td>
            <td>{u.branch_code || '—'}</td><td className="small">{u.vehicle_no ? `${u.vehicle_no} · ${u.capacity} stops` : '—'}</td><td className="small">{u.customer_name || '—'}</td>
            <td className="small">{u.last_login_at ? dt(u.last_login_at) : 'never'}</td><td>{u.active ? <Badge tone="ok">Active</Badge> : <Badge tone="muted">Disabled</Badge>}</td>
            <td>{user.role === 'ADMIN' && <button className="btn sm" onClick={() => setEdit(u)}>Edit</button>}</td></tr>)}</tbody></table></div>
      )}
      {edit && <UserModal u={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); list.reload(true); }} />}
    </>
  );
}

function UserModal({ u, onClose, onDone }) {
  const branches = useLoad(() => api.get('/api/admin/branches'), []);
  const customers = useLoad(() => api.get('/api/admin/customers'), []);
  const [v, setV, bind] = useForm({ name: '', email: '', phone: '', role: 'OPS', branch_id: '', customer_id: '', vehicle_no: '', capacity: 25, password: '', ...u, active: u.active === undefined ? true : !!u.active });
  const [run, busy] = useAction();
  const save = () => {
    const body = { name: v.name, email: v.email, phone: v.phone, role: v.role, branch_id: v.branch_id, customer_id: v.customer_id, vehicle_no: v.vehicle_no, capacity: v.capacity || 25, active: v.active, password: v.password };
    return run(() => (u.id ? api.put(`/api/admin/users/${u.id}`, body) : api.post('/api/admin/users', body)), 'User saved').then(onDone);
  };
  return (
    <Modal title={u.id ? `Edit ${u.name}` : 'New user'} onClose={onClose} footer={<button className="btn primary" disabled={busy} onClick={save}>Save</button>}>
      <div className="grid g2">
        <Field label="Name"><input {...bind('name')} /></Field><Field label="Email"><input {...bind('email')} type="email" /></Field>
        <Field label="Phone"><input {...bind('phone')} /></Field>
        <Field label="Role"><select {...bind('role')}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select></Field>
        <Field label="Branch"><select {...bind('branch_id')}><option value="">—</option>{branches.data?.map((b) => <option key={b.id} value={b.id}>{b.code}</option>)}</select></Field>
        {v.role === 'DRIVER' && <><Field label="Vehicle no."><input {...bind('vehicle_no')} /></Field><Field label="Max stops / route"><input {...bind('capacity', 'number')} /></Field></>}
        {v.role === 'CUSTOMER' && <Field label="Customer account"><select {...bind('customer_id')}><option value="">Select…</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>}
        <Field label={u.id ? 'Reset password (optional)' : 'Password'} hint="Min 8 chars, letters + numbers"><input {...bind('password')} type="password" autoComplete="new-password" /></Field>
        <label className="row small"><input type="checkbox" checked={v.active} onChange={(e) => setV({ ...v, active: e.target.checked })} /> Active (unticking signs the user out everywhere)</label>
      </div>
    </Modal>
  );
}

export function Rates() {
  const { user } = useSession();
  const list = useLoad(() => api.get('/api/admin/rates'), []);
  const [run] = useAction();
  const [rows, setRows] = useState({});
  const can = ['ADMIN', 'FINANCE'].includes(user.role);
  const val = (r, k) => rows[r.id]?.[k] ?? r[k];
  const set = (r, k, x) => setRows({ ...rows, [r.id]: { ...rows[r.id], [k]: x } });
  const save = (r) => run(() => api.put(`/api/admin/rates/${r.id}`, { base_weight: Number(val(r, 'base_weight')), base_price: Number(val(r, 'base_price')), per_kg: Number(val(r, 'per_kg')), transit: val(r, 'transit'), active: !!val(r, 'active') }), 'Rate saved').then(() => list.reload(true));
  return (
    <>
      <div className="page-head"><h1>Rate cards</h1><span className="small muted">Freight = base price (up to base kg) + per extra kg. Fuel surcharge, COD fee and VAT from Settings.</span></div>
      {list.loading ? <Spinner /> : (
        <div className="table-wrap"><table><thead><tr><th>Service</th><th>Zone</th><th className="num">Base kg</th><th className="num">Base price</th><th className="num">Per extra kg</th><th>Transit</th><th>Active</th><th /></tr></thead>
          <tbody>{list.data?.map((r) => <tr key={r.id}><td><b>{SERVICES[r.service]}</b></td><td>{r.zone}</td>
            {['base_weight', 'base_price', 'per_kg'].map((k) => <td key={k} className="num">{can ? <input type="number" step="any" value={val(r, k)} onChange={(e) => set(r, k, e.target.value)} style={{ width: 100 }} /> : r[k]}</td>)}
            <td>{can ? <input value={val(r, 'transit') || ''} onChange={(e) => set(r, 'transit', e.target.value)} /> : r.transit}</td>
            <td><input type="checkbox" disabled={!can} checked={!!val(r, 'active')} onChange={(e) => set(r, 'active', e.target.checked)} /></td>
            <td>{can && rows[r.id] && <button className="btn sm primary" onClick={() => save(r)}>Save</button>}</td></tr>)}</tbody></table></div>
      )}
    </>
  );
}

export function Settings() {
  const s = useLoad(() => api.get('/api/admin/settings'), []);
  if (s.loading) return <Spinner />;
  return <SettingsForm initial={s.data} />;
}
function SettingsForm({ initial }) {
  const [v, , bind] = useForm(initial);
  const [run, busy] = useAction();
  const F = [['company_name', 'Company name'], ['company_trn', 'Company TRN'], ['company_phone', 'Phone'], ['company_email', 'Email'], ['company_address', 'Address'],
    ['vat_rate_pct', 'VAT %'], ['fuel_surcharge_pct', 'Fuel surcharge %'], ['cod_fee_pct', 'COD fee %'], ['cod_fee_min', 'COD fee minimum (AED)'], ['volumetric_divisor', 'Volumetric divisor (cm³/kg)']];
  return (
    <>
      <div className="page-head"><h1>Settings</h1><button className="btn primary" disabled={busy} onClick={() => run(() => api.put('/api/admin/settings', v), 'Settings saved')}>Save</button></div>
      <div className="card grid g2">{F.map(([k, l]) => <Field key={k} label={l}><input {...bind(k)} /></Field>)}</div>
      <div className="alert info small">Company details appear on tax invoices, receipts and labels. Use your registered legal name and TRN.</div>
    </>
  );
}

export function Audit() {
  const [action, setAction] = useState('');
  const a = useLoad(() => api.get(`/api/admin/audit?limit=300${action ? `&action=${action}` : ''}`), [action]);
  return (
    <>
      <div className="page-head"><h1>Audit log</h1><select value={action} onChange={(e) => setAction(e.target.value)} style={{ width: 220 }}>
        <option value="">All actions</option>{['auth', 'shipment', 'scan', 'driver', 'routing', 'invoice', 'payment', 'cash', 'cod', 'lead', 'ticket', 'customer', 'user', 'rate', 'settings'].map((x) => <option key={x}>{x}</option>)}</select></div>
      {a.loading ? <Spinner /> : (
        <div className="table-wrap"><table><thead><tr><th>Time</th><th>User</th><th>Action</th><th>Entity</th><th>Detail</th><th>IP</th></tr></thead>
          <tbody>{a.data?.map((r) => <tr key={r.id}><td className="small">{dt(r.created_at)}</td><td className="small">{r.user_name || '—'} <span className="tiny muted">{r.user_role}</span></td>
            <td><code className="small">{r.action}</code></td><td className="small">{r.entity} {r.entity_id}</td><td className="tiny mono" style={{ maxWidth: 380, wordBreak: 'break-all' }}>{r.detail}</td><td className="tiny">{r.ip}</td></tr>)}</tbody></table></div>
      )}
    </>
  );
}
