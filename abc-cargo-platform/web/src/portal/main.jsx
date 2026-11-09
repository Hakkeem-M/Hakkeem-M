// Landing page: links to the four applications.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../shared/styles.css';

const APPS = [
  { href: '/customer', icon: 'customer', title: 'Customer App', sub: 'Ship worldwide, instant rates with duties, track, pay, support', who: 'Public · mobile' },
  { href: '/erp', icon: 'erp', title: 'ERP', sub: 'International exports & customs, air manifests, CRM, billing, pickup routing, reports', who: 'Staff · desktop' },
  { href: '/driver', icon: 'driver', title: 'Driver Billing App', sub: 'Run sheet, GPS, pickup billing & receipts, POD with COD', who: 'Couriers · mobile' },
  { href: '/warehouse', icon: 'warehouse', title: 'Hub Scanner', sub: 'IN / OUT scanning, export manifests, offline queue', who: 'Warehouse · mobile' },
];

function Portal() {
  return (
    <div style={{ maxWidth: 980, margin: '0 auto', padding: '40px 16px' }}>
      <div className="row nowrap" style={{ marginBottom: 24 }}>
        <img src="/icons/erp.svg" alt="" width="52" height="52" style={{ borderRadius: 14 }} />
        <div><h1 style={{ margin: 0 }}>ABC Cargo & Courier</h1><div className="muted">International air courier & cargo · UAE domestic · Logistics</div></div>
      </div>
      <div className="grid g2">
        {APPS.map((a) => (
          <a key={a.href} href={a.href} className="card row nowrap" style={{ color: 'inherit', textDecoration: 'none', alignItems: 'flex-start' }}>
            <img src={`/icons/${a.icon}.svg`} alt="" width="48" height="48" style={{ borderRadius: 12 }} />
            <div><h2 style={{ margin: '0 0 4px' }}>{a.title}</h2><div className="small">{a.sub}</div><div className="tiny muted" style={{ marginTop: 6 }}>{a.who}</div></div>
          </a>
        ))}
      </div>
      <p className="small muted" style={{ marginTop: 24 }}>Mobile apps are installable PWAs: open on a phone and choose “Add to Home Screen”.</p>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<StrictMode><Portal /></StrictMode>);
