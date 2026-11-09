export const STATUS = {
  BOOKED: { label: 'Booked', tone: 'info' },
  PICKUP_ASSIGNED: { label: 'Pickup assigned', tone: 'info' },
  PICKED_UP: { label: 'Picked up', tone: 'accent' },
  IN_WAREHOUSE: { label: 'At hub', tone: 'accent' },
  IN_TRANSIT: { label: 'In transit (UAE)', tone: 'accent' },
  MANIFESTED: { label: 'Manifested', tone: 'info' },
  DEPARTED: { label: 'Departed (flight)', tone: 'info' },
  ARRIVED: { label: 'Arrived destination', tone: 'accent' },
  CUSTOMS_HOLD: { label: 'Customs hold', tone: 'bad' },
  CUSTOMS_CLEARED: { label: 'Customs cleared', tone: 'ok' },
  WITH_AGENT: { label: 'With delivery partner', tone: 'accent' },
  OUT_FOR_DELIVERY: { label: 'Out for delivery', tone: 'warn' },
  DELIVERED: { label: 'Delivered', tone: 'ok' },
  DELIVERY_FAILED: { label: 'Attempted', tone: 'bad' },
  RETURNED: { label: 'Returned', tone: 'muted' },
  CANCELLED: { label: 'Cancelled', tone: 'muted' },
  // invoices / tickets / leads
  UNPAID: { label: 'Unpaid', tone: 'warn' }, PARTIAL: { label: 'Partial', tone: 'info' }, PAID: { label: 'Paid', tone: 'ok' }, VOID: { label: 'Void', tone: 'muted' },
  OPEN: { label: 'Open', tone: 'warn' }, IN_PROGRESS: { label: 'In progress', tone: 'info' }, WAITING_CUSTOMER: { label: 'Waiting customer', tone: 'muted' },
  RESOLVED: { label: 'Resolved', tone: 'ok' }, CLOSED: { label: 'Closed', tone: 'muted' },
  NEW: { label: 'New', tone: 'info' }, CONTACTED: { label: 'Contacted', tone: 'info' }, QUALIFIED: { label: 'Qualified', tone: 'accent' },
  PROPOSAL: { label: 'Proposal', tone: 'accent' }, NEGOTIATION: { label: 'Negotiation', tone: 'warn' }, WON: { label: 'Won', tone: 'ok' }, LOST: { label: 'Lost', tone: 'muted' },
  NOT_REQUIRED: { label: 'n/a', tone: 'muted' }, DOCS_OK: { label: 'Docs OK', tone: 'ok' }, SUBMITTED: { label: 'Declared', tone: 'info' },
  HOLD: { label: 'Hold', tone: 'bad' }, CLEARED: { label: 'Cleared', tone: 'ok' }, DEPARTED_M: { label: 'Departed', tone: 'info' },
  OK: { label: 'OK', tone: 'ok' }, WARNING: { label: 'Warning', tone: 'warn' }, EXCEPTION: { label: 'Exception', tone: 'bad' },
  URGENT: { label: 'Urgent', tone: 'bad' }, HIGH: { label: 'High', tone: 'warn' }, MEDIUM: { label: 'Medium', tone: 'info' }, LOW: { label: 'Low', tone: 'muted' },
};

export const SERVICES = {
  INTL_EXPRESS: 'Intl Express (Air Courier)', INTL_ECONOMY: 'Intl Economy', AIR_CARGO: 'Air Freight Cargo',
  SAME_DAY: 'Same Day (UAE)', EXPRESS: 'Domestic Express', STANDARD: 'Domestic Standard',
};
export const INTL_SERVICES = ['INTL_EXPRESS', 'INTL_ECONOMY', 'AIR_CARGO'];
export const isIntl = (s) => s && s.dest_country && s.dest_country !== 'AE';
export const UAE_CITIES = ['Dubai', 'Abu Dhabi', 'Al Ain', 'Sharjah', 'Ajman', 'Umm Al Quwain', 'Ras Al Khaimah', 'Fujairah'];

const nf = new Intl.NumberFormat('en-AE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const aed = (n) => `AED ${nf.format(Number(n) || 0)}`;
export const num = (n) => new Intl.NumberFormat('en-AE').format(Number(n) || 0);

// Server stores UTC "YYYY-MM-DD HH:MM:SS" or ISO strings.
export const toDate = (s) => (s ? new Date(/Z|[+-]\d\d:\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`) : null);
export const dt = (s) => { const d = toDate(s); return d ? d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'; };
export const dOnly = (s) => { const d = toDate(s); return d ? d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'; };
export const ago = (s) => {
  const d = toDate(s);
  if (!d) return '—';
  const m = Math.round((Date.now() - d.getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} d ago`;
};

export const mapsLink = (lat, lng, label) =>
  lat && lng ? `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(label || '')}`;
export const telLink = (p) => `tel:${String(p || '').replace(/[^\d+]/g, '')}`;
export const waLink = (p, text) => `https://wa.me/${String(p || '').replace(/[^\d]/g, '')}?text=${encodeURIComponent(text || '')}`;
