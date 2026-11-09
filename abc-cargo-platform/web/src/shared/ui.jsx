import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { STATUS } from './format.js';

export function Badge({ s, children, tone }) {
  const m = STATUS[s] || { label: s, tone: tone || '' };
  return <span className={`badge ${tone || m.tone}`}>{children || m.label}</span>;
}

export function Field({ label, children, hint, span }) {
  return (
    <label className="field" style={span ? { gridColumn: `span ${span}` } : undefined}>
      {label}
      {children}
      {hint && <span className="tiny muted" style={{ fontWeight: 400 }}>{hint}</span>}
    </label>
  );
}

export function Spinner({ label }) {
  return <div className="row" style={{ padding: 20, justifyContent: 'center' }}><span className="spin" aria-hidden="true" /> <span className="muted">{label || 'Loading…'}</span></div>;
}

export function Empty({ children }) { return <div className="empty">{children || 'Nothing here yet.'}</div>; }

export function ErrorBox({ error }) {
  if (!error) return null;
  return <div className="alert bad" role="alert">{error.message || String(error)}</div>;
}

export function Modal({ title, onClose, children, wide, footer }) {
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="row between" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button className="btn ghost sm" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
        {footer && <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>{footer}</div>}
      </div>
    </div>
  );
}

const ToastCtx = createContext(() => {});
export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((msg, tone = '') => {
    const id = Math.random().toString(36).slice(2);
    setItems((x) => [...x, { id, msg, tone }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), tone === 'bad' ? 5000 : 2800);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-wrap" aria-live="polite">{items.map((t) => <div key={t.id} className={`toast ${t.tone}`}>{t.msg}</div>)}</div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

/** Data loader hook: const { data, error, loading, reload } = useLoad(() => api.get(url), [deps]) */
export function useLoad(fn, deps = [], { interval } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const reload = useCallback(async (quiet) => {
    if (!quiet) setState((s) => ({ ...s, loading: true }));
    try {
      const data = await fnRef.current();
      setState({ data, error: null, loading: false });
    } catch (error) {
      setState((s) => ({ ...s, error, loading: false }));
    }
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { reload(); }, deps);
  useEffect(() => {
    if (!interval) return undefined;
    const t = setInterval(() => reload(true), interval);
    return () => clearInterval(t);
  }, [interval, reload]);
  return { ...state, reload };
}

/** Async action helper with busy flag + toast on error. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn, okMsg) => {
    setBusy(true);
    try {
      const r = await fn();
      if (okMsg) toast(okMsg, 'ok');
      return r;
    } catch (e) {
      toast(e.message || 'Something went wrong', 'bad');
      throw e;
    } finally {
      setBusy(false);
    }
  }, [toast]);
  return [run, busy];
}

/** Controlled form state helper. */
export function useForm(initial) {
  const [v, setV] = useState(initial);
  const bind = (k, type) => ({
    value: v[k] ?? '',
    onChange: (e) => setV((s) => ({ ...s, [k]: type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value })),
    ...(type === 'number' ? { type: 'number', inputMode: 'decimal', step: 'any' } : {}),
  });
  return [v, setV, bind];
}

export function Stat({ label, value, alert, sub }) {
  return (
    <div className={`card kpi ${alert ? 'alert' : ''}`}>
      <span className="l">{label}</span>
      <span className="v">{value}</span>
      {sub && <span className="small muted">{sub}</span>}
    </div>
  );
}
