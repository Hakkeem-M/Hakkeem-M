import { createContext, useContext, useEffect, useState } from 'react';
import { useForm, ErrorBox } from './ui.jsx';
import { REGIONS, setCurrency } from './format.js';
import Logo, { LoginArt } from './Logo.jsx';

const Ctx = createContext(null);

/**
 * Auth/session provider bound to one app ('erp' | 'driver' | 'warehouse' | 'customer').
 * Region: region-bound users are fixed to their region; group users choose one (or "all") — sent as X-Entity.
 */
export function SessionProvider({ api, app, children }) {
  const [user, setUser] = useState(undefined); // undefined = checking, null = signed out
  const [region, setRegionState] = useState(api.region || null);

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

  const login = async (email, password, wantedRegion) => {
    const r = await api.post('/api/auth/login', { email, password, app, region: wantedRegion || undefined });
    api.setToken(r.token);
    const me = await api.get('/api/auth/me');
    applyRegion(me, wantedRegion && wantedRegion !== 'GROUP' ? wantedRegion : null);
    setUser(me);
    return me;
  };
  const adopt = async (token) => { api.setToken(token); const me = await api.get('/api/auth/me'); applyRegion(me, null); setUser(me); };
  const logout = () => { api.setToken(null); setUser(null); };
  /** Group users only: switch the working region (null = all regions). */
  const switchRegion = (r) => { if (user?.entity_code) return; applyRegion(null, r); };
  return <Ctx.Provider value={{ api, app, user, login, logout, adopt, region, switchRegion }}>{children}</Ctx.Provider>;
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
  const { login, api } = useSession();
  const [v, , bind] = useForm({ email: '', password: '' });
  const [region, setRegion] = useState(api.region || 'AE');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try { await login(v.email.trim(), v.password, region); } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  const demoFor = typeof demo === 'function' ? demo(region) : demo;
  return (
    <div className="login">
      <section className="hero">
        <Logo size={40} invert caption="UAE · UK · KSA · INDIA" />
        <div>
          <h2>Moving cargo.<br />Connecting regions.</h2>
          <p>{subtitle}</p>
        </div>
        <LoginArt />
        <div className="chips"><span>✈️ Air courier</span><span>📦 Air cargo</span><span>🚢 Sea cargo</span><span>🚚 Domestic</span></div>
      </section>
      <div className="panel">
        <form className="card stack" onSubmit={submit}>
          <div className="row nowrap">
            <img src={`/icons/${accent || 'erp'}.svg`} alt="" width="44" height="44" style={{ borderRadius: 12 }} />
            <div><h1>Welcome back</h1><div className="muted small">{title} — sign in to continue</div></div>
          </div>
          <label className="field">Region<RegionPicker value={region} onChange={setRegion} allowGroup={allowGroup} /></label>
          <ErrorBox error={err} />
          <label className="field">Email<input {...bind('email')} type="email" autoComplete="username" required autoFocus /></label>
          <label className="field">Password<input {...bind('password')} type="password" autoComplete="current-password" required /></label>
          <button className="btn primary lg block" disabled={busy}>{busy ? 'Signing in…' : `Sign in${region !== 'GROUP' ? ` — ${REGIONS[region]?.name}` : ' — Group'}`}</button>
          {demoFor && <div className="alert info small">Demo login: <b>{demoFor}</b> / <b>Demo@2026</b></div>}
          {footer}
        </form>
      </div>
    </div>
  );
}

/** Demo account names per region (fictional). */
export const demoAccount = (prefix, region) => {
  if (region === 'GROUP') return 'admin@abccargo.demo';
  const tag = { GB: 'uk', SA: 'ksa', IN: 'india' }[region];
  if (!tag) return `${prefix === 'driver' ? 'driver1' : prefix}@abccargo.demo`;
  return `${prefix}.${tag}@abccargo.demo`;
};
