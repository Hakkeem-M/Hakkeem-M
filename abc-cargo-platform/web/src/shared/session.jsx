import { createContext, useContext, useEffect, useState } from 'react';
import { useForm, ErrorBox } from './ui.jsx';

const Ctx = createContext(null);

/** Auth/session provider bound to one app ('erp' | 'driver' | 'warehouse' | 'customer'). */
export function SessionProvider({ api, app, children }) {
  const [user, setUser] = useState(undefined); // undefined = checking, null = signed out
  useEffect(() => {
    api.onUnauthorized(() => setUser(null));
    if (!api.token) { setUser(null); return; }
    api.get('/api/auth/me').then(setUser).catch(() => setUser(null));
  }, [api]);
  const login = async (email, password) => {
    const r = await api.post('/api/auth/login', { email, password, app });
    api.setToken(r.token);
    const me = await api.get('/api/auth/me');
    setUser(me);
    return me;
  };
  const adopt = async (token) => { api.setToken(token); setUser(await api.get('/api/auth/me')); };
  const logout = () => { api.setToken(null); setUser(null); };
  return <Ctx.Provider value={{ api, app, user, login, logout, adopt }}>{children}</Ctx.Provider>;
}
export const useSession = () => useContext(Ctx);

export function LoginForm({ title, subtitle, demo, footer, accent }) {
  const { login } = useSession();
  const [v, , bind] = useForm({ email: '', password: '' });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try { await login(v.email.trim(), v.password); } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 16 }}>
      <form className="card stack" style={{ width: 'min(420px, 100%)', padding: 24 }} onSubmit={submit}>
        <div className="row nowrap">
          <img src={`/icons/${accent || 'erp'}.svg`} alt="" width="44" height="44" style={{ borderRadius: 12 }} />
          <div><h1 style={{ margin: 0 }}>{title}</h1><div className="muted small">{subtitle}</div></div>
        </div>
        <ErrorBox error={err} />
        <label className="field">Email<input {...bind('email')} type="email" autoComplete="username" required autoFocus /></label>
        <label className="field">Password<input {...bind('password')} type="password" autoComplete="current-password" required /></label>
        <button className="btn primary lg block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        {demo && <div className="alert info small">Demo login: <b>{demo}</b> / <b>Demo@2026</b></div>}
        {footer}
      </form>
    </div>
  );
}
