import { createContext, useContext, useEffect, useState } from 'react';
import { useForm, ErrorBox } from './ui.jsx';
import { REGIONS, setCurrency } from './format.js';
import Logo from './Logo.jsx';

const Ctx = createContext(null);

/**
 * Auth/session provider bound to one app ('erp' | 'driver' | 'warehouse' | 'customer').
 * Region: region-bound users are fixed to their region; group users choose one (or "all") — sent as X-Entity.
 */
export function SessionProvider({ api, app, children }) {
  const [user, setUser] = useState(undefined); // undefined = checking, null = signed out
  const [region, setRegionState] = useState(api.region || null);
  const [site, setSite] = useState(undefined); // region served by this domain: AE | GB | SA | IN | GROUP | null
  useEffect(() => { api.get('/api/public/site').then((x) => setSite(x.region ?? null)).catch(() => setSite(null)); }, [api]);

  const applyRegion = (me, wanted) => {
    const r = me?.entity_code || wanted || null;
    api.setRegion(r);
    setRegionState(r);
    setCurrency(REGIONS[r]?.currency || 'AED');
  };

  useEffect(() => {
    api.onUnauthorized(() => setUser(null));
    if (!api.token) { setUser(null); return; }
    api.get('/api/auth/me').then((me) => { applyRegion(me, api.region); setUser(me); }).catch(() => setUser(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  // The domain decides the region (server-enforced); the account's own region applies on other hosts.
  const login = async (email, password) => {
    const r = await api.post('/api/auth/login', { email, password, app });
    api.setToken(r.token);
    const me = await api.get('/api/auth/me');
    applyRegion(me, r.region);
    setUser(me);
    return me;
  };
  const adopt = async (token) => { api.setToken(token); const me = await api.get('/api/auth/me'); applyRegion(me, null); setUser(me); };
  const logout = () => { api.setToken(null); setUser(null); };
  /** Group users only: switch the working region (null = all regions). */
  const switchRegion = (r) => { if (user?.entity_code) return; applyRegion(null, r); };
  return <Ctx.Provider value={{ api, app, user, login, logout, adopt, region, switchRegion, site }}>{children}</Ctx.Provider>;
}
export const useSession = () => useContext(Ctx);

/** Region picker chips for login screens. allowGroup shows "Group (all regions)" for ERP admins. */
export function RegionPicker({ value, onChange, allowGroup }) {
  const opts = [...Object.entries(REGIONS).map(([code, r]) => ({ code, label: `${r.flag} ${r.name}` })), ...(allowGroup ? [{ code: 'GROUP', label: '🌐 Group' }] : [])];
  return (
    <div className="seg" role="radiogroup" aria-label="Region" style={{ flexWrap: 'wrap' }}>
      {opts.map((o) => (
        <button type="button" key={o.code} role="radio" aria-checked={value === o.code} className={value === o.code ? 'on' : ''} onClick={() => onChange(o.code)}>{o.label}</button>
      ))}
    </div>
  );
}

export function LoginForm({ title, subtitle, demo, footer, accent, allowGroup }) {
  const { login, site } = useSession();
  const [v, , bind] = useForm({ email: '', password: '' });
  const region = site || 'GROUP';
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try { await login(v.email.trim(), v.password); } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  const demoFor = typeof demo === 'function' ? demo(region) : demo;
  return (
    <div className="login">
      <section className="hero" aria-label="ABC Cargo and Courier">
        <img className="glass" src="/brand/fluid-glass.svg" alt="" aria-hidden="true" />
        <Logo size={46} invert stacked />
        <div>
          <h2>Moving cargo.<br />Connecting teams.</h2>
          <span className="rule" aria-hidden="true" />
          <p>{site && site !== 'GROUP' ? `Your ${REGIONS[site]?.name} operations` : 'Your operations'}, in one workspace.</p>
        </div>
        <img className="skyline" src="/brand/london-skyline.svg" alt="" aria-hidden="true" />
      </section>
      <div className="panel">
        <form className="stack" onSubmit={submit}>
          <p className="eyebrow">{site && site !== 'GROUP' ? REGIONS[site]?.name : site === 'GROUP' ? 'Group' : 'ABC Cargo'} <span aria-hidden="true">·</span> {title.replace(/^ABC (Cargo )?/, '') || 'ERP'}</p>
          <h1>Welcome back</h1>
          <p className="intro">{subtitle}</p>
          <ErrorBox error={err} />
          <label className="field">Email<input {...bind('email')} type="email" autoComplete="username" required autoFocus /></label>
          <label className="field">Password<input {...bind('password')} type="password" autoComplete="current-password" required /></label>
          <button className="btn primary lg block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          {demoFor && <div className="alert info small">Demo login: <b>{demoFor}</b> / <b>Demo@2026</b>{!site && <div className="tiny">Other regions: same name with <b>.uk</b>, <b>.ksa</b> or <b>.india</b> (e.g. ops.uk@abccargo.demo).</div>}</div>}
          {footer}
          <p className="access">Need access? Contact your IT administrator.</p>
        </form>
        <footer>© 2026 ABC Cargo &amp; Courier<br /><small>Developed By Hakkeem M</small></footer>
      </div>
    </div>
  );
}

/** Demo account names per region (fictional). */
export const demoAccount = (prefix, region) => {
  if (region === 'GROUP') return prefix === 'admin' ? 'admin@abccargo.demo' : `${prefix === 'driver' ? 'driver1' : prefix}@abccargo.demo`;
  const tag = { GB: 'uk', SA: 'ksa', IN: 'india' }[region];
  if (!tag) return `${prefix === 'driver' ? 'driver1' : prefix}@abccargo.demo`;
  return `${prefix}.${tag}@abccargo.demo`;
};
