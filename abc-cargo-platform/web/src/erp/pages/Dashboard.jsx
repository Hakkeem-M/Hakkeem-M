import { Link } from 'react-router-dom';
import { api } from '../ctx.js';
import { useLoad, Spinner, ErrorBox, Stat, Badge } from '../../shared/ui.jsx';
import { aed, money, num, ago, SERVICES, REGIONS } from '../../shared/format.js';

function Bars({ days, k, alt, fmt = num }) {
  const max = Math.max(1, ...days.map((d) => d[k]));
  return (
    <div className="bars" role="img" aria-label={`${k} per day, last 14 days`}>
      {days.map((d) => (
        <div className="b" key={d.day} title={`${d.day}: ${fmt(d[k])}`}>
          <div className={`col ${alt ? 'alt' : ''}`} style={{ height: `${(d[k] / max) * 120}px` }} />
          <span>{d.day.slice(8)}</span>
        </div>
      ))}
    </div>
  );
}

export default function Dashboard() {
  const { data, error, loading } = useLoad(() => api.get('/api/reports/dashboard'), [], { interval: 60000 });
  if (loading && !data) return <Spinner />;
  if (error) return <ErrorBox error={error} />;
  const k = data.kpi;
  const all = !data.entity;
  const amt = (x) => (all ? '— (multi-currency)' : money(x, data.currency));
  return (
    <>
      <div className="page-head"><h1>{all ? '🌐 Group dashboard — all regions' : `${REGIONS[data.entity]?.flag} ${REGIONS[data.entity]?.name} dashboard`}</h1><span className="muted small">Auto-refreshes every minute{all ? ' · amounts per region currency below' : ''}</span></div>
      <div className="grid g4">
        {data.regions.map((r) => (
          <div key={r.code} className="card kpi"><span className="l">{REGIONS[r.code]?.flag} {REGIONS[r.code]?.name}</span>
            <span className="v" style={{ fontSize: '1.2rem' }}>{money(r.revenue_mtd, r.currency)}</span>
            <span className="small muted">{r.shipments_mtd} shipments MTD · AR {money(r.ar_outstanding, r.currency)}</span></div>
        ))}
      </div>
      <h3 style={{ margin: 0 }}>✈️ International air courier & cargo</h3>
      <div className="grid g4">
        <Stat label="Intl shipments MTD" value={num(k.intl_shipments_mtd)} sub={`Revenue ${amt(k.intl_revenue_mtd)}`} />
        <Stat label="At hub — ready to manifest" value={num(k.intl_ready_to_manifest)} sub={<Link to="/intl/manifests">Open manifests</Link>} />
        <Stat label="Manifested / in flight" value={num(k.intl_in_flight)} sub={`${k.intl_at_destination} at destination`} />
        <Stat label="Customs holds / docs pending" value={num(k.customs_holds)} alert={k.customs_holds > 0} sub={<Link to="/intl">Customs queue</Link>} />
      </div>
      {data.destinations?.length > 0 && (
        <div className="card"><h3>Top destinations (30 days)</h3>
          <div className="row" style={{ gap: 8 }}>{data.destinations.map((d) => <div key={d.code} className="card flat" style={{ minWidth: 150 }}><b>{d.name}</b><div className="small muted">{d.shipments} shpts · {d.kg} kg</div><div>{amt(d.revenue)}</div></div>)}</div></div>
      )}
      <h3 style={{ margin: 0 }}>🚚 Domestic & logistics</h3>
      <div className="grid g4">
        <Stat label="Bookings today" value={num(k.bookings_today)} />
        <Stat label="Pickups pending" value={num(k.pending_pickups)} sub={<Link to="/dispatch">{k.unassigned_pickups} unassigned → route now</Link>} alert={k.unassigned_pickups > 0} />
        <Stat label="In warehouse" value={num(k.in_warehouse)} />
        <Stat label="Out for delivery" value={num(k.out_for_delivery)} sub={`${k.drivers_online} drivers online (GPS)`} />
        <Stat label="Delivered today" value={num(k.delivered_today)} sub={k.first_attempt_rate != null ? `First-attempt rate ${k.first_attempt_rate}% (30d)` : null} />
        <Stat label="Failed attempts" value={num(k.failed_attempts)} alert={k.failed_attempts > 0} />
        <Stat label="Revenue MTD" value={amt(k.revenue_mtd)} sub={`Collected ${amt(k.collected_mtd)}`} />
        <Stat label="Receivables" value={amt(k.ar_outstanding)} sub={`Overdue ${amt(k.ar_overdue)}`} alert={k.ar_overdue > 0} />
        <Stat label="Cash with drivers" value={amt(k.driver_cash)} sub={<Link to="/cash">Settle</Link>} />
        <Stat label="COD to remit" value={amt(k.cod_pending_remit)} />
        <Stat label="Open tickets" value={num(k.open_tickets)} sub={`${k.sla_breached} SLA breached`} alert={k.sla_breached > 0} />
        <Stat label="Pipeline (weighted / mo)" value={amt(k.pipeline_weighted)} sub={<Link to="/crm">Open CRM</Link>} />
      </div>
      <div className="grid g2">
        <div className="card"><h3>Bookings — last 14 days</h3><Bars days={data.days} k="bookings" /></div>
        <div className="card"><h3>Revenue — last 14 days</h3><Bars days={data.days} k="revenue" alt fmt={aed} /></div>
      </div>
      <div className="grid g3">
        <div className="card">
          <h3>Drivers (7 days)</h3>
          <table><thead><tr><th>Driver</th><th className="num">Delivered</th><th className="num">On board</th><th className="num">Pickups</th></tr></thead>
            <tbody>{data.drivers.map((d) => <tr key={d.id}><td>{d.name}<div className="tiny muted">{d.vehicle_no}</div></td><td className="num">{d.delivered_7d}</td><td className="num">{d.on_board}</td><td className="num">{d.pickups}</td></tr>)}</tbody></table>
        </div>
        <div className="card">
          <h3>Revenue by service (30 days)</h3>
          <table><tbody>{data.by_service.map((s) => <tr key={s.service}><td>{SERVICES[s.service]}</td><td className="num">{s.shipments}</td><td className="num">{amt(s.revenue)}</td></tr>)}</tbody></table>
          <h3 style={{ marginTop: 14 }}>Top customers</h3>
          <table><tbody>{data.top_customers.map((c) => <tr key={c.id}><td><Link to={`/customers/${c.id}`}>{c.name}</Link></td><td className="num">{amt(c.revenue)}</td></tr>)}</tbody></table>
        </div>
        <div className="card">
          <h3>Live activity</h3>
          <ul className="timeline">
            {data.recent.map((e, i) => (
              <li key={i}><Link to={`/shipments/${e.shipment_id}`} className="mono small">{e.awb}</Link> <Badge s={e.status} />
                <div className="tiny muted">{e.note || e.location} · {e.user_name || 'system'} · {ago(e.created_at)}</div></li>
            ))}
          </ul>
        </div>
      </div>
    </>
  );
}
