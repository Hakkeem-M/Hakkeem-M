import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../ctx.js';
import { useLoad, useAction, Spinner, Badge, Field, Empty, ErrorBox } from '../../shared/ui.jsx';
import { dt, aed } from '../../shared/format.js';
import { useSession } from '../../shared/session.jsx';

export default function WarehousePage() {
  const { user } = useSession();
  const branches = useLoad(() => api.get('/api/admin/branches'), []);
  const [branch, setBranch] = useState(user.branch_id ? String(user.branch_id) : '');
  const inv = useLoad(() => api.get(`/api/warehouse/inventory${branch ? `?branch_id=${branch}` : ''}`), [branch], { interval: 30000 });
  const scans = useLoad(() => api.get(`/api/warehouse/scans?limit=50${branch ? `&branch_id=${branch}` : ''}`), [branch], { interval: 30000 });
  const drivers = useLoad(() => api.get('/api/warehouse/drivers'), []);
  const [sel, setSel] = useState([]);
  const [drv, setDrv] = useState('');
  const [run, busy] = useAction();
  const assign = () => run(() => api.post('/api/shipments/assign', { shipment_ids: sel, driver_id: Number(drv) }), 'Delivery driver assigned — scan OUT to dispatch')
    .then(() => { setSel([]); inv.reload(true); });

  return (
    <>
      <div className="page-head">
        <h1>Warehouse inventory</h1>
        <div className="row">
          <select value={branch} onChange={(e) => setBranch(e.target.value)} style={{ width: 260 }}><option value="">All branches</option>
            {branches.data?.map((b) => <option key={b.id} value={b.id}>{b.code} — {b.name}</option>)}</select>
          <a className="btn accent" href="/warehouse" target="_blank" rel="noreferrer">📱 Open scanner app</a>
        </div>
      </div>
      <ErrorBox error={inv.error} />
      {inv.data && (
        <div className="grid g4">
          <div className="card kpi"><span className="l">In stock</span><span className="v">{inv.data.total}</span></div>
          <div className="card kpi"><span className="l">Incoming transfers</span><span className="v">{inv.data.incoming_transfers}</span></div>
          <div className="card kpi"><span className="l">Aged &gt; 48 h</span><span className="v">{inv.data.rows.filter((r) => r.hours_in_stock > 48).length}</span></div>
          <div className="card kpi"><span className="l">Bins used</span><span className="v">{Object.keys(inv.data.by_bin).length}</span></div>
        </div>
      )}
      {['ADMIN', 'OPS'].includes(user.role) && sel.length > 0 && (
        <div className="card row">
          <b>{sel.length} selected</b>
          <select value={drv} onChange={(e) => setDrv(e.target.value)} style={{ width: 260 }}><option value="">Assign delivery driver…</option>{drivers.data?.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.vehicle_no}</option>)}</select>
          <button className="btn primary" disabled={!drv || busy} onClick={assign}>Assign</button>
        </div>
      )}
      {inv.loading && !inv.data ? <Spinner /> : (
        <div className="table-wrap"><table>
          <thead><tr><th><input type="checkbox" aria-label="Select all" onChange={(e) => setSel(e.target.checked ? inv.data.rows.map((r) => r.id) : [])} /></th>
            <th>Bin</th><th>AWB</th><th>Destination</th><th>Consignee</th><th className="num">Pcs</th><th className="num">COD</th><th>Delivery driver</th><th className="num">Hours</th></tr></thead>
          <tbody>{inv.data?.rows.map((r) => (
            <tr key={r.id}>
              <td><input type="checkbox" checked={sel.includes(r.id)} onChange={(e) => setSel(e.target.checked ? [...sel, r.id] : sel.filter((x) => x !== r.id))} aria-label={`Select ${r.awb}`} /></td>
              <td><b>{r.bin || '—'}</b><div className="tiny muted">{r.branch_code}</div></td><td><Link to={`/shipments/${r.id}`} className="mono">{r.awb}</Link></td>
              <td>{r.dest_city}</td><td>{r.consignee_name}</td><td className="num">{r.pieces}</td><td className="num">{r.cod_amount ? aed(r.cod_amount) : '—'}</td>
              <td>{r.driver_name || <span className="muted">unassigned</span>}</td><td className="num">{r.hours_in_stock > 48 ? <Badge tone="bad">{r.hours_in_stock}</Badge> : r.hours_in_stock}</td>
            </tr>))}</tbody>
        </table>{!inv.data?.rows.length && <Empty>Warehouse is empty.</Empty>}</div>
      )}
      <div className="card"><h3>Recent scans</h3>
        <table><thead><tr><th>Time</th><th>Dir</th><th>AWB</th><th>Branch / bin</th><th>Purpose</th><th>Result</th><th>Message</th><th>By</th></tr></thead>
          <tbody>{scans.data?.map((s) => <tr key={s.id}><td className="small">{dt(s.scanned_at)}</td><td><Badge tone={s.direction === 'IN' ? 'ok' : 'accent'}>{s.direction}</Badge></td>
            <td className="mono">{s.awb}</td><td>{s.branch_code}{s.bin && ` · ${s.bin}`}</td><td className="small">{s.purpose || '—'}</td><td><Badge s={s.result} /></td><td className="small">{s.message}</td><td className="small">{s.user_name}</td></tr>)}</tbody></table>
        <Field label=" "><span className="tiny muted">Scans are performed in the mobile Warehouse Scanner app (camera or handheld scanner, works offline).</span></Field>
      </div>
    </>
  );
}
