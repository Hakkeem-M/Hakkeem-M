// Printable documents: AWB shipping label and VAT tax invoice / receipt.
import { Barcode } from './devices.jsx';
import { aed, dOnly, dt, SERVICES } from './format.js';

export function ShippingLabel({ s, company }) {
  return (
    <div className="label-doc" style={{ border: '2px solid #000', borderRadius: 8, padding: 12, background: '#fff', color: '#000', maxWidth: 420, fontSize: 13 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '2px solid #000', paddingBottom: 6 }}>
        <b style={{ fontSize: 16 }}>{company?.name || 'ABC Cargo & Courier'}</b>
        <b style={{ fontSize: 18 }}>{SERVICES[s.service] || s.service}</b>
      </div>
      {s.dest_country && s.dest_country !== 'AE' && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #000', padding: '4px 0' }}>
          <b style={{ fontSize: 34, letterSpacing: 2 }}>{s.dest_airport || s.dest_country}</b>
          <div style={{ textAlign: 'right', fontSize: 12 }}>DXB → {s.dest_airport}<br />{s.product} · {s.incoterm}{s.dangerous_goods ? ' · ⚠ DG' : ''}<br />Value {s.customs_value} {s.currency}</div>
        </div>
      )}
      <div style={{ textAlign: 'center', padding: '6px 0' }}><Barcode value={s.awb} height={70} width={2.2} /></div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, borderTop: '1px solid #000', paddingTop: 6 }}>
        <div><div style={{ fontSize: 10, fontWeight: 700 }}>FROM</div>{s.shipper_name}<br />{s.shipper_address}<br />{s.origin_city}<br />{s.shipper_phone}</div>
        <div><div style={{ fontSize: 10, fontWeight: 700 }}>TO</div><b>{s.consignee_name}</b><br />{s.consignee_address}<br /><b style={{ fontSize: 16 }}>{s.dest_city}</b> {s.dest_country !== 'AE' && s.dest_country}<br />{s.consignee_phone}</div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid #000', marginTop: 6, paddingTop: 6 }}>
        <span>Pcs: <b>{s.pieces}</b></span><span>Wt: <b>{s.chargeable_weight} kg</b></span><span>{dOnly(s.created_at)}</span>
      </div>
      {s.cod_amount > 0 && <div style={{ marginTop: 6, border: '2px solid #000', textAlign: 'center', fontWeight: 800, fontSize: 18 }}>COD {aed(s.cod_amount)}</div>}
      {s.reference && <div style={{ marginTop: 4 }}>Ref: {s.reference}</div>}
    </div>
  );
}

export function InvoiceDoc({ inv, company, receipt }) {
  const title = receipt ? 'TAX INVOICE / RECEIPT' : 'TAX INVOICE';
  return (
    <div style={{ background: '#fff', color: '#000', padding: 20, borderRadius: 8, maxWidth: 820, fontSize: 13 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 800, color: '#0b3d91' }}>{company?.name || 'ABC Cargo & Courier'}</div>
          <div>{company?.address}</div><div>{company?.phone} · {company?.email}</div>
          <div>TRN: <b>{company?.trn}</b></div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 18, fontWeight: 800 }}>{title}</div>
          <div>No. <b>{inv.number}</b></div>
          <div>Date: {dOnly(inv.issue_date)}</div>
          {inv.type === 'CREDIT' && <div>Due: {dOnly(inv.due_date)}</div>}
          <div>Status: <b>{inv.status}</b></div>
        </div>
      </div>
      <div style={{ margin: '14px 0', padding: 10, background: '#f4f6fb', borderRadius: 6 }}>
        <div style={{ fontSize: 11, fontWeight: 700 }}>BILL TO</div>
        <b>{inv.customer_name}</b> {inv.customer_code && `(${inv.customer_code})`}<br />
        {inv.customer_address} {inv.customer_city}<br />
        {inv.customer_trn && <>TRN: {inv.customer_trn}</>}
      </div>
      <table style={{ border: '1px solid #ccc' }}>
        <thead><tr><th style={{ background: '#eef2f8', color: '#000' }}>Description</th><th className="num" style={{ background: '#eef2f8', color: '#000' }}>Taxable</th><th className="num" style={{ background: '#eef2f8', color: '#000' }}>VAT %</th><th className="num" style={{ background: '#eef2f8', color: '#000' }}>VAT</th><th className="num" style={{ background: '#eef2f8', color: '#000' }}>Total</th></tr></thead>
        <tbody>
          {inv.lines?.map((l) => (
            <tr key={l.id}><td>{l.description}</td><td className="num">{l.amount.toFixed(2)}</td><td className="num">{l.vat_rate}</td><td className="num">{l.vat.toFixed(2)}</td><td className="num">{(l.amount + l.vat).toFixed(2)}</td></tr>
          ))}
        </tbody>
      </table>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
        <table style={{ width: 280 }}>
          <tbody>
            <tr><td>Subtotal (excl. VAT)</td><td className="num">{aed(inv.subtotal)}</td></tr>
            <tr><td>VAT</td><td className="num">{aed(inv.vat)}</td></tr>
            <tr><td><b>Total</b></td><td className="num"><b>{aed(inv.total)}</b></td></tr>
            <tr><td>Paid</td><td className="num">{aed(inv.paid)}</td></tr>
            <tr><td><b>Balance due</b></td><td className="num"><b>{aed(inv.total - inv.paid)}</b></td></tr>
          </tbody>
        </table>
      </div>
      {inv.payments?.length > 0 && (
        <div style={{ marginTop: 8 }} className="small">Payments: {inv.payments.map((p) => `${p.method} ${aed(p.amount)} (${dt(p.created_at)})`).join(' · ')}</div>
      )}
      <div style={{ marginTop: 18, fontSize: 11, color: '#555' }}>Amounts in UAE Dirham (AED). Export shipments are zero-rated. This is a computer-generated document.</div>
    </div>
  );
}

/** Commercial / proforma invoice for customs (international exports). */
export function CommercialInvoice({ s, company }) {
  const items = s.items || [];
  const total = items.reduce((a, i) => a + i.qty * i.unit_value, 0);
  const cell = { border: '1px solid #999', padding: '4px 6px' };
  return (
    <div style={{ background: '#fff', color: '#000', padding: 20, borderRadius: 8, maxWidth: 860, fontSize: 12 }}>
      <div style={{ textAlign: 'center', fontSize: 18, fontWeight: 800 }}>COMMERCIAL INVOICE</div>
      <div style={{ display: 'flex', justifyContent: 'space-between', margin: '8px 0' }}>
        <div>AWB: <b>{s.awb}</b><br />Date: {dOnly(s.created_at)}<br />Reference: {s.reference || '—'}</div>
        <div style={{ textAlign: 'right' }}>Carrier: {company?.name || 'ABC Cargo & Courier'}<br />Service: {SERVICES[s.service]}<br />Incoterm: <b>{s.incoterm}</b> · Reason: {s.export_reason}</div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div style={{ ...cell }}><b>EXPORTER / SHIPPER</b><br />{s.shipper_name}<br />{s.shipper_address}<br />{s.origin_city}, United Arab Emirates<br />Tel {s.shipper_phone}</div>
        <div style={{ ...cell }}><b>CONSIGNEE / IMPORTER</b><br />{s.consignee_name}<br />{s.consignee_address}<br />{s.dest_city} {s.consignee_postcode} · {s.dest_country}<br />Tel {s.consignee_phone}{s.consignee_tax_id && <><br />Tax ID {s.consignee_tax_id}</>}</div>
      </div>
      <table style={{ marginTop: 10, borderCollapse: 'collapse', width: '100%' }}>
        <thead><tr>{['#', 'Description of goods', 'HS code', 'Origin', 'Qty', `Unit value (${s.currency})`, `Total (${s.currency})`].map((h) => <th key={h} style={{ ...cell, background: '#eef2f8', color: '#000' }}>{h}</th>)}</tr></thead>
        <tbody>{items.map((i, n) => <tr key={i.id || n}><td style={cell}>{n + 1}</td><td style={cell}>{i.description}</td><td style={cell}>{i.hs_code || '—'}</td><td style={cell}>{i.origin_country}</td>
          <td style={{ ...cell, textAlign: 'right' }}>{i.qty}</td><td style={{ ...cell, textAlign: 'right' }}>{Number(i.unit_value).toFixed(2)}</td><td style={{ ...cell, textAlign: 'right' }}>{(i.qty * i.unit_value).toFixed(2)}</td></tr>)}</tbody>
        <tfoot><tr><td colSpan={6} style={{ ...cell, textAlign: 'right' }}><b>Total declared value</b></td><td style={{ ...cell, textAlign: 'right' }}><b>{total.toFixed(2)} {s.currency}</b></td></tr></tfoot>
      </table>
      <div style={{ marginTop: 8 }}>Pieces: {s.pieces} · Gross weight: {s.weight} kg · Chargeable: {s.chargeable_weight} kg{s.length ? ` · Dims ${s.length}×${s.width}×${s.height} cm` : ''}{s.dangerous_goods ? ' · Contains dangerous goods (DG declaration attached)' : ''}</div>
      <div style={{ marginTop: 18 }}>I declare that the information on this invoice is true and correct and that the contents are as stated.</div>
      <div style={{ marginTop: 28, display: 'flex', justifyContent: 'space-between' }}><span>Signature: ____________________</span><span>Name: {s.shipper_name}</span><span>Date: {dOnly(s.created_at)}</span></div>
    </div>
  );
}
