// Warehouse / export-hub scanner (PWA): IN scan, OUT scan to air manifest (international) / courier / transfer / return.
// Camera (BarcodeDetector / ZXing) or handheld keyboard-wedge scanners. Offline queue with idempotent sync.
import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../shared/styles.css';
import { createApi, safeStore } from '../shared/api.js';
import { SessionProvider, useSession, LoginForm, demoAccount } from '../shared/session.jsx';
import { ToastProvider, useLoad, Spinner, Badge, Field, Empty } from '../shared/ui.jsx';
import { CameraScanner, feedback, registerSW } from '../shared/devices.jsx';
import { dt } from '../shared/format.js';

const api = createApi('warehouse');
registerSW();
const QKEY = 'abc.warehouse.queue';
const loadQ = () => { try { return JSON.parse(safeStore.get(QKEY) || '[]'); } catch { return []; } };
const saveQ = (q) => safeStore.set(QKEY, JSON.stringify(q));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
const AWB_RE = /^ABC\d{9}$/;

function Scanner() {
  const { user, logout } = useSession();
  const branches = useLoad(() => api.get('/api/admin/branches'), []);
  const drivers = useLoad(() => api.get('/api/warehouse/drivers'), []);
  const manifests = useLoad(() => api.get('/api/warehouse/manifests'), [], { interval: 60000 });
  const [branch, setBranch] = useState(() => safeStore.get('abc.wh.branch') || (user.branch_id ? String(user.branch_id) : ''));
  const [dir, setDir] = useState('IN');
  const [purpose, setPurpose] = useState('MANIFEST');
  const [bin, setBin] = useState('');
  const [driver, setDriver] = useState('');
  const [manifest, setManifest] = useState('');
  const [toBranch, setToBranch] = useState('');
  const [camera, setCamera] = useState(false);
  const [manual, setManual] = useState('');
  const [log, setLog] = useState([]);
  const [queue, setQueue] = useState(loadQ);
  const [online, setOnline] = useState(navigator.onLine);
  const [flash, setFlash] = useState('');
  const inputRef = useRef(null);

  useEffect(() => { safeStore.set('abc.wh.branch', branch); }, [branch]);
  useEffect(() => {
    const on = () => setOnline(true); const off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  const flush = useCallback(async () => {
    const q = loadQ();
    if (!q.length || !navigator.onLine) return;
    try {
      const r = await api.post('/api/warehouse/scan/batch', { scans: q });
      const done = new Set(r.results.map((x) => x.client_ref));
      const rest = loadQ().filter((x) => !done.has(x.client_ref));
      saveQ(rest); setQueue(rest);
      setLog((l) => l.map((e) => { const m = r.results.find((x) => x.client_ref === e.ref); return m ? { ...e, result: m.result, message: `${m.message} (synced)`, shipment: m.shipment } : e; }));
    } catch { /* stay queued */ }
  }, []);
  useEffect(() => { if (online) flush(); }, [online, flush]);
  useEffect(() => { const t = setInterval(flush, 20000); return () => clearInterval(t); }, [flush]);

  const scan = useCallback(async (raw) => {
    const awb = String(raw).trim().toUpperCase();
    if (!awb) return;
    if (!branch) { feedback(false); setLog((l) => [{ ref: uid(), awb, result: 'EXCEPTION', message: 'Select your branch first', at: new Date().toISOString() }, ...l]); return; }
    const body = {
      awb, direction: dir, branch_id: Number(branch), bin: dir === 'IN' && bin ? bin : undefined,
      purpose: dir === 'OUT' ? purpose : undefined,
      manifest_id: dir === 'OUT' && purpose === 'MANIFEST' && manifest ? Number(manifest) : undefined,
      driver_id: dir === 'OUT' && purpose === 'DELIVERY' && driver ? Number(driver) : undefined,
      to_branch_id: dir === 'OUT' && purpose === 'TRANSFER' && toBranch ? Number(toBranch) : undefined,
      client_ref: uid(), scanned_at: new Date().toISOString(),
    };
    const entry = { ref: body.client_ref, awb, dir, purpose: body.purpose, at: body.scanned_at, result: 'PENDING', message: 'Sending…' };
    setLog((l) => [entry, ...l].slice(0, 200));
    if (!AWB_RE.test(awb)) entry.message = 'Non-standard barcode — checking…';
    const finish = (res) => {
      const ok = res.result === 'OK';
      feedback(ok);
      setFlash(ok ? 'flash-ok' : 'flash-bad'); setTimeout(() => setFlash(''), 600);
      setLog((l) => l.map((e) => (e.ref === entry.ref ? { ...e, ...res } : e)));
      if (res.result === 'OK' && purpose === 'MANIFEST') manifests.reload(true);
    };
    try {
      if (!navigator.onLine) throw new Error('offline');
      finish(await api.post('/api/warehouse/scan', body));
    } catch (e) {
      if (e.status === 0 || e.message === 'offline') {
        const q = [...loadQ(), body]; saveQ(q); setQueue(q);
        feedback(true);
        setLog((l) => l.map((x) => (x.ref === entry.ref ? { ...x, result: 'QUEUED', message: 'Saved offline — will sync automatically' } : x)));
      } else finish({ result: 'EXCEPTION', message: e.message });
    }
    inputRef.current?.focus();
  }, [branch, dir, bin, purpose, driver, toBranch, manifest, manifests]);

  const onCamera = useCallback((t) => scan(t), [scan]);
  const ok = log.filter((x) => x.result === 'OK').length;
  const bad = log.filter((x) => x.result === 'EXCEPTION').length;
  const mf = manifests.data?.find((m) => String(m.id) === manifest);

  return (
    <div className={`m-app ${flash}`}>
      <header className="m-top dark">
        <h1 className="spacer">Hub Scanner</h1>
        <span className="badge" style={{ background: online ? 'var(--ok)' : 'var(--bad)', color: '#fff', borderColor: 'transparent' }}>{online ? 'Online' : 'Offline'}</span>
        {queue.length > 0 && <button className="btn sm" onClick={flush}>Sync {queue.length}</button>}
        <button className="btn sm" onClick={logout} aria-label="Sign out">⎋</button>
      </header>
      <div className="m-body" style={{ paddingBottom: 24 }}>
        <Field label="Branch / hub"><select value={branch} onChange={(e) => setBranch(e.target.value)}><option value="">Select…</option>{branches.data?.map((b) => <option key={b.id} value={b.id}>{b.code} — {b.name}</option>)}</select></Field>
        <div className="seg"><button className={dir === 'IN' ? 'on in' : ''} onClick={() => setDir('IN')}>⬇ IN (receive)</button><button className={dir === 'OUT' ? 'on out' : ''} onClick={() => setDir('OUT')}>⬆ OUT (dispatch)</button></div>
        {dir === 'IN' ? (
          <Field label="Bin / location (optional)" hint="e.g. EXP-GB for export lanes, A-3 for domestic"><input value={bin} onChange={(e) => setBin(e.target.value.toUpperCase())} placeholder="EXP-IN" /></Field>
        ) : (
          <div className="grid g2">
            <Field label="Purpose"><select value={purpose} onChange={(e) => setPurpose(e.target.value)}>
              <option value="MANIFEST">✈️🚢 Export — air / sea manifest</option><option value="DELIVERY">🚚 Local delivery (courier)</option><option value="TRANSFER">↔ Transfer to branch</option><option value="RETURN">↩ Return to shipper</option></select></Field>
            {purpose === 'MANIFEST' && <Field label="Open manifest"><select value={manifest} onChange={(e) => setManifest(e.target.value)}><option value="">Select…</option>{manifests.data?.map((m) => <option key={m.id} value={m.id}>{m.dest_airport} · {m.flight_no || 'no flight'} · {m.shipments} AWB</option>)}</select></Field>}
            {purpose === 'DELIVERY' && <Field label="Courier (if not pre-assigned)"><select value={driver} onChange={(e) => setDriver(e.target.value)}><option value="">Use assigned</option>{drivers.data?.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.vehicle_no}</option>)}</select></Field>}
            {purpose === 'TRANSFER' && <Field label="To branch"><select value={toBranch} onChange={(e) => setToBranch(e.target.value)}><option value="">Select…</option>{branches.data?.filter((b) => String(b.id) !== branch).map((b) => <option key={b.id} value={b.id}>{b.code}</option>)}</select></Field>}
          </div>
        )}
        {dir === 'OUT' && purpose === 'MANIFEST' && mf && <div className="alert info small">Scanning into <b>{mf.number}</b> → {mf.dest_airport} ({mf.dest_country}). Only AWBs for this destination with complete customs docs are accepted.</div>}
        <form className="row nowrap" onSubmit={(e) => { e.preventDefault(); scan(manual); setManual(''); }}>
          <input ref={inputRef} value={manual} onChange={(e) => setManual(e.target.value)} placeholder="Scan with handheld or type AWB" autoFocus autoComplete="off" autoCapitalize="characters" style={{ fontSize: 18 }} />
          <button className="btn primary">Go</button>
        </form>
        <button className={`btn block ${camera ? '' : 'accent'}`} onClick={() => setCamera((c) => !c)}>{camera ? 'Stop camera' : '📷 Scan with camera'}</button>
        {camera && <CameraScanner onScan={onCamera} />}
        <div className="row between small"><span>Session: <b style={{ color: 'var(--ok)' }}>{ok} OK</b> · <b style={{ color: 'var(--bad)' }}>{bad} exceptions</b> · {queue.length} queued</span>
          <button className="btn sm ghost" onClick={() => setLog([])}>Clear</button></div>
        {log.length ? log.map((e) => (
          <div key={e.ref} className="card" style={{ padding: 10, borderLeft: `4px solid ${e.result === 'OK' ? 'var(--ok)' : e.result === 'EXCEPTION' ? 'var(--bad)' : e.result === 'WARNING' ? 'var(--warn)' : 'var(--muted)'}` }}>
            <div className="row between nowrap"><b className="mono">{e.awb}</b><Badge s={e.result === 'QUEUED' || e.result === 'PENDING' ? undefined : e.result} tone={e.result === 'QUEUED' ? 'info' : undefined}>{e.result === 'QUEUED' ? 'Queued' : e.result === 'PENDING' ? '…' : undefined}</Badge></div>
            <div className="small">{e.dir === 'OUT' ? `OUT · ${e.purpose}` : 'IN'} — {e.message}</div>
            {e.shipment && <div className="tiny muted">{e.shipment.dest_country !== 'AE' ? `✈️ ${e.shipment.dest_country} · ` : ''}{e.shipment.consignee_name} · {e.shipment.dest_city} · {e.shipment.pieces} pcs{e.shipment.bin ? ` · bin ${e.shipment.bin}` : ''}{e.shipment.customs_status && e.shipment.customs_status !== 'NOT_REQUIRED' ? ` · customs ${e.shipment.customs_status}` : ''}</div>}
            <div className="tiny muted">{dt(e.at)}</div>
          </div>
        )) : <Empty>Scan a label to begin. Works offline — scans sync automatically.</Empty>}
        <Inventory branch={branch} />
      </div>
    </div>
  );
}

function Inventory({ branch }) {
  const [open, setOpen] = useState(false);
  const inv = useLoad(() => (open && branch ? api.get(`/api/warehouse/inventory?branch_id=${branch}`) : Promise.resolve(null)), [open, branch]);
  return (
    <div className="card">
      <button className="btn block" onClick={() => setOpen((o) => !o)}>{open ? 'Hide' : 'Show'} stock on hand</button>
      {open && (inv.loading ? <Spinner /> : inv.data && (
        <div className="stack" style={{ marginTop: 10 }}>
          <div className="small">{inv.data.total} parcels · {inv.data.rows.filter((r) => r.shipment_type === 'INTERNATIONAL').length} export · {inv.data.incoming_transfers} incoming</div>
          <div className="row" style={{ gap: 6 }}>{Object.entries(inv.data.by_bin).map(([b, n]) => <span key={b} className="badge">{b}: {n}</span>)}</div>
          <table><tbody>{inv.data.rows.slice(0, 80).map((r) => <tr key={r.id}><td className="mono small">{r.awb}</td><td>{r.bin || '—'}</td><td className="small">{r.shipment_type === 'INTERNATIONAL' ? `✈️ ${r.dest_country}` : r.dest_city}</td><td className="small">{r.customs_status === 'PENDING' ? <Badge tone="warn">docs</Badge> : r.driver_name || ''}</td></tr>)}</tbody></table>
        </div>
      ))}
    </div>
  );
}

function App() {
  const { user } = useSession();
  if (user === undefined) return <Spinner />;
  if (!user) return <LoginForm title="ABC Hub Scanner" subtitle="IN / OUT · Export manifests · Offline-ready" demo={(r) => demoAccount('warehouse', r)} accent="warehouse" />;
  return <Scanner />;
}

createRoot(document.getElementById('root')).render(
  <StrictMode><ToastProvider><SessionProvider api={api} app="warehouse"><App /></SessionProvider></ToastProvider></StrictMode>,
);
