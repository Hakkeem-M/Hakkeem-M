import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom';
import '../shared/styles.css';
import './erp.css';
import { api, MetaCtx } from './ctx.js';
import { SessionProvider, useSession, LoginForm } from '../shared/session.jsx';
import { ToastProvider, Spinner, useLoad } from '../shared/ui.jsx';
import Dashboard from './pages/Dashboard.jsx';
import { ShipmentList, ShipmentDetail } from './pages/Shipments.jsx';
import Dispatch from './pages/Dispatch.jsx';
import WarehousePage from './pages/Warehouse.jsx';
import { Invoices, InvoiceDetail, CashCod } from './pages/Finance.jsx';
import { Pipeline, LeadDetail, Tickets, TicketDetail, Customer360, CrmTasks } from './pages/Crm.jsx';
import { Customers, Users, Rates, Settings, Audit } from './pages/Admin.jsx';
import { IntlOverview, Manifests, ManifestDetail, Countries } from './pages/International.jsx';


const NAV = [
  { to: '/', label: 'Dashboard', ic: '📊', roles: '*' },
  { to: '/shipments', label: 'Shipments', ic: '📦', roles: '*' },
  { section: 'International' },
  { to: '/intl', label: 'Exports & customs', ic: '🛃', roles: '*' },
  { to: '/intl/manifests', label: 'Air manifests (MAWB)', ic: '✈️', roles: '*' },
  { to: '/intl/countries', label: 'Countries & duties', ic: '🌍', roles: '*' },
  { section: 'Domestic & logistics' },
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
  { to: '/settings', label: 'Settings', ic: '⚙️', roles: ['ADMIN'] },
  { to: '/audit', label: 'Audit log', ic: '🛡️', roles: ['ADMIN'] },
];
const allowed = (n, role) => n.roles === '*' || n.roles?.includes(role);

function Shell() {
  const { user, logout } = useSession();
  const meta = useLoad(() => api.get('/api/public/meta'), []);
  if (user === undefined) return <Spinner />;
  if (!user) return <LoginForm title="ABC Cargo ERP" subtitle="International air courier · Cargo · Domestic · CRM" demo="admin@abccargo.demo" accent="erp" />;
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
      <div className="erp">
        <aside className="side">
          <div className="brand"><img src="/icons/erp.svg" alt="" width="32" height="32" /> <div><b>ABC Cargo</b><div className="tiny">ERP · {user.role}</div></div></div>
          <nav>
            {nav.map((n) => n.section ? <div key={n.section} className="sec">{n.section}</div> : (
              <NavLink key={n.to} to={n.to} end={['/', '/crm', '/intl'].includes(n.to)}><span aria-hidden="true">{n.ic}</span> {n.label}</NavLink>
            ))}
          </nav>
          <div className="me">
            <div className="small"><b>{user.name}</b><div className="tiny muted">{user.email}</div></div>
            <button className="btn sm" onClick={logout}>Sign out</button>
          </div>
        </aside>
        <main className="content">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/shipments" element={<ShipmentList />} />
            <Route path="/shipments/:id" element={<ShipmentDetail />} />
            <Route path="/intl" element={<IntlOverview />} />
            <Route path="/intl/manifests" element={<Manifests />} />
            <Route path="/intl/manifests/:id" element={<ManifestDetail />} />
            <Route path="/intl/countries" element={<Countries />} />
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
