import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import { HashRouter, Routes, Route, NavLink, Navigate, Link, useLocation, useNavigate } from 'react-router-dom';
import '../shared/styles.css';
import './erp.css';
import { api, MetaCtx } from './ctx.js';
import { SessionProvider, useSession, LoginForm, demoAccount } from '../shared/session.jsx';
import { REGIONS } from '../shared/format.js';
import Logo from '../shared/Logo.jsx';
import { Quotations, QuotationDetail, NewQuotation } from './pages/Quotations.jsx';
import { ToastProvider, Spinner, useLoad } from '../shared/ui.jsx';
import Dashboard from './pages/Dashboard.jsx';
import { ShipmentList, ShipmentDetail } from './pages/Shipments.jsx';
import Dispatch from './pages/Dispatch.jsx';
import WarehousePage from './pages/Warehouse.jsx';
import { Invoices, InvoiceDetail, CashCod } from './pages/Finance.jsx';
import { Pipeline, LeadDetail, Tickets, TicketDetail, Customer360, CrmTasks } from './pages/Crm.jsx';
import { Customers, Users, Rates, Settings, Audit, Regions } from './pages/Admin.jsx';
import { IntlOverview, Manifests, ManifestDetail, Countries } from './pages/International.jsx';
import { AgentInbox, EnquiryPipeline, PickupsBoard } from './pages/Inbox.jsx';


const NAV = [
  { to: '/', label: 'Dashboard', ic: '📊', roles: '*' },
  { section: 'Customer support' },
  { to: '/inbox', label: 'Agent inbox', ic: '📥', roles: ['ADMIN', 'OPS', 'SALES', 'FINANCE'] },
  { to: '/inbox/pipeline', label: 'Enquiry pipeline', ic: '🧭', roles: ['ADMIN', 'OPS', 'SALES', 'FINANCE'] },
  { section: 'Bookings' },
  { to: '/shipments', label: 'Shipments & bookings', ic: '📦', roles: '*' },
  { to: '/quotations', label: 'Quotations', ic: '💬', roles: ['ADMIN', 'OPS', 'SALES', 'FINANCE'] },
  { section: 'International' },
  { to: '/intl', label: 'Exports & customs', ic: '🛃', roles: '*' },
  { to: '/intl/manifests', label: 'Air & sea manifests', ic: '✈️', roles: '*' },
  { to: '/intl/countries', label: 'Countries & duties', ic: '🌍', roles: '*' },
  { section: 'Domestic & logistics' },
  { to: '/pickups', label: 'Pickups & deliveries', ic: '📋', roles: ['ADMIN', 'OPS'] },
  { to: '/dispatch', label: 'Pickup routing & GPS', ic: '🗺️', roles: ['ADMIN', 'OPS'] },
  { to: '/warehouse', label: 'Hub / warehouse', ic: '🏭', roles: ['ADMIN', 'OPS', 'WAREHOUSE'] },
  { section: 'CRM' },
  { to: '/crm', label: 'Sales pipeline', ic: '🎯', roles: ['ADMIN', 'SALES', 'OPS', 'FINANCE'] },
  { to: '/crm/tasks', label: 'Follow-ups', ic: '✅', roles: ['ADMIN', 'SALES', 'OPS', 'FINANCE'] },
  { to: '/tickets', label: 'Support tickets', ic: '🎧', roles: ['ADMIN', 'SALES', 'OPS', 'FINANCE'] },
  { to: '/customers', label: 'Customers', ic: '🏢', roles: '*' },
  { section: 'Finance' },
  { to: '/invoices', label: 'Invoices & billing', ic: '🧾', roles: ['ADMIN', 'FINANCE', 'OPS'] },
  { to: '/cash', label: 'Driver cash & COD', ic: '💵', roles: ['ADMIN', 'FINANCE', 'OPS'] },
  { section: 'Admin' },
  { to: '/rates', label: 'Rate cards', ic: '🏷️', roles: '*' },
  { to: '/users', label: 'Users & roles', ic: '👥', roles: ['ADMIN', 'OPS'] },
  { to: '/regions', label: 'Regions, VAT & packing', ic: '🌐', roles: ['ADMIN', 'FINANCE'] },
  { to: '/settings', label: 'Settings', ic: '⚙️', roles: ['ADMIN'] },
  { to: '/audit', label: 'Audit log', ic: '🛡️', roles: ['ADMIN'] },
];
const allowed = (n, role) => n.roles === '*' || n.roles?.includes(role);

function RegionSwitch() {
  const { user, region, switchRegion } = useSession();
  if (user.entity_code) {
    const r = REGIONS[user.entity_code];
    return <span className="badge info" title="Your region">{r?.flag} {r?.name} · {r?.currency}</span>;
  }
  return (
    <select value={region || ''} onChange={(e) => { switchRegion(e.target.value || null); location.reload(); }} aria-label="Working region" style={{ minHeight: 30, padding: '2px 6px' }}>
      <option value="">🌐 All regions</option>
      {Object.entries(REGIONS).map(([c, r]) => <option key={c} value={c}>{r.flag} {r.name}</option>)}
    </select>
  );
}

const store = {
  get(k, d) { try { const v = sessionStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
/** Tab title for a route: nav label, or "<nav label> · <id>" for detail pages. */
function tabLabel(path) {
  const exact = NAV.find((n) => n.to === path);
  if (exact) return `${exact.ic} ${exact.label}`;
  const base = NAV.filter((n) => n.to && n.to !== '/' && path.startsWith(`${n.to}/`)).sort((a, b) => b.to.length - a.to.length)[0];
  const last = path.split('/').filter(Boolean).pop();
  if (!base) return path;
  return `${base.ic} ${last === 'new' ? `New · ${base.label}` : `${base.label} · ${last}`}`;
}
/** Multi-tab workspace: every page opened stays as a tab until closed (per browser session). */
function TabBar() {
  const loc = useLocation();
  const nav = useNavigate();
  const [tabs, setTabs] = useState(() => store.get('erp.tabs', ['/']));
  const path = loc.pathname;
  useEffect(() => {
    setTabs((t) => {
      const rest = (t.includes(path) ? t : [...t, path]).filter((x) => x !== '/').slice(-11);
      const next = ['/', ...rest];
      store.set('erp.tabs', next);
      return next;
    });
    requestAnimationFrame(() => { try { document.querySelector('.tabbar .t.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch { /* old browsers */ } });
  }, [path]);
  const close = (p) => {
    const i = tabs.indexOf(p);
    const next = tabs.filter((x) => x !== p);
    setTabs(next); store.set('erp.tabs', next);
    if (p === path) nav(next[Math.max(0, i - 1)] || '/');
  };
  return (
    <div className="tabbar no-print" role="tablist" aria-label="Open pages">
      {tabs.map((p) => (
        <span key={p} className={`t ${p === path ? 'on' : ''}`} role="tab" aria-selected={p === path}>
          <Link to={p} title={tabLabel(p)}>{tabLabel(p)}</Link>
          {p !== '/' && <button type="button" onClick={() => close(p)} aria-label={`Close ${tabLabel(p)}`}>×</button>}
        </span>
      ))}
    </div>
  );
}

function Shell() {
  const { user, logout, region } = useSession();
  const meta = useLoad(() => api.get(`/api/public/meta?entity=${region || 'AE'}`), [region]);
  const [mini, setMini] = useState(() => store.get('erp.mini', false));
  const toggleMini = () => setMini((m) => { store.set('erp.mini', !m); return !m; });
  if (user === undefined) return <Spinner />;
  if (!user) return <LoginForm title="ABC Cargo ERP" subtitle="UAE · UK · KSA · India — international cargo, courier & CRM" demo={(r) => demoAccount('admin', r)} accent="erp" allowGroup />;
  const nav = [];
  let section = null;
  for (const n of NAV) {
    if (n.section) { section = n; continue; }
    if (!allowed(n, user.role)) continue;
    if (section) { nav.push(section); section = null; }
    nav.push(n);
  }
  return (
    <MetaCtx.Provider value={meta.data || {}}>
      <div className={`erp ${mini ? 'mini' : ''}`}>
        <aside className="side">
          <div className="brand">
            <Logo size={26} caption={`ERP · ${user.role}`} />
            <button className="burger" onClick={toggleMini} aria-label={mini ? 'Expand menu' : 'Collapse menu'} aria-expanded={!mini}>☰</button>
          </div>
          <div className="region"><RegionSwitch /></div>
          <nav>
            {nav.map((n) => n.section ? <div key={n.section} className="sec">{n.section}</div> : (
              <NavLink key={n.to} to={n.to} end={['/', '/crm', '/intl', '/inbox'].includes(n.to)} title={n.label}><span aria-hidden="true">{n.ic}</span> <span className="lbl">{n.label}</span></NavLink>
            ))}
          </nav>
          <div className="me">
            <div className="small who"><b>{user.name}</b><div className="tiny muted">{user.email}</div></div>
            <button className="btn sm" onClick={logout} title="Sign out">{mini ? '⏻' : 'Sign out'}</button>
          </div>
        </aside>
        <div className="main-col">
        <TabBar />
        <main className="content">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/shipments" element={<ShipmentList />} />
            <Route path="/shipments/:id" element={<ShipmentDetail />} />
            <Route path="/quotations" element={<Quotations />} />
            <Route path="/quotations/new" element={<NewQuotation />} />
            <Route path="/quotations/:id" element={<QuotationDetail />} />
            <Route path="/regions" element={<Regions />} />
            <Route path="/intl" element={<IntlOverview />} />
            <Route path="/intl/manifests" element={<Manifests />} />
            <Route path="/intl/manifests/:id" element={<ManifestDetail />} />
            <Route path="/intl/countries" element={<Countries />} />
            <Route path="/inbox" element={<AgentInbox />} />
            <Route path="/inbox/pipeline" element={<EnquiryPipeline />} />
            <Route path="/pickups" element={<PickupsBoard />} />
            <Route path="/dispatch" element={<Dispatch />} />
            <Route path="/warehouse" element={<WarehousePage />} />
            <Route path="/invoices" element={<Invoices />} />
            <Route path="/invoices/:id" element={<InvoiceDetail />} />
            <Route path="/cash" element={<CashCod />} />
            <Route path="/crm" element={<Pipeline />} />
            <Route path="/crm/tasks" element={<CrmTasks />} />
            <Route path="/crm/leads/:id" element={<LeadDetail />} />
            <Route path="/tickets" element={<Tickets />} />
            <Route path="/tickets/:id" element={<TicketDetail />} />
            <Route path="/customers" element={<Customers />} />
            <Route path="/customers/:id" element={<Customer360 />} />
            <Route path="/rates" element={<Rates />} />
            <Route path="/users" element={<Users />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/audit" element={<Audit />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </main>
        </div>
      </div>
    </MetaCtx.Provider>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ToastProvider>
      <SessionProvider api={api} app="erp">
        <HashRouter><Shell /></HashRouter>
      </SessionProvider>
    </ToastProvider>
  </StrictMode>,
);
