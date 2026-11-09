/** ABC Cargo & Courier wordmark: three red circles (A · B · C) + "CARGO AND COURIER" (brand icon artwork). */
export default function Logo({ size = 30, invert = false, sub = 'CARGO AND COURIER', caption, stacked = false }) {
  return (
    <span className={`logo ${invert ? 'invert' : ''} ${stacked ? 'stacked' : ''}`} style={{ '--ls': `${size}px` }} aria-label="ABC Cargo and Courier">
      <span className="circles" aria-hidden="true"><span>A</span><span>B</span><span>C</span></span>
      {sub && <span className="wm"><b>{sub}</b>{caption && <small>{caption}</small>}</span>}
    </span>
  );
}
