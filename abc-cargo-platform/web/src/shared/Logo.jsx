/** ABC Cargo & Courier wordmark: three red circles (A · B · C) + "CARGO & COURIER". */
export default function Logo({ size = 30, invert = false, sub = 'CARGO & COURIER', caption }) {
  return (
    <span className={`logo ${invert ? 'invert' : ''}`} style={{ '--ls': `${size}px` }} aria-label="ABC Cargo & Courier">
      <span className="circles" aria-hidden="true"><span>A</span><span>B</span><span>C</span></span>
      {sub && <span className="wm"><b>{sub}</b>{caption && <small>{caption}</small>}</span>}
    </span>
  );
}

/** Original line-art illustration for the login hero: skyline, globe route and aircraft. */
export function LoginArt() {
  return (
    <svg className="art" viewBox="0 0 560 300" role="img" aria-label="Aircraft flying over a city skyline">
      <defs>
        <linearGradient id="la-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff" stopOpacity=".16" /><stop offset="1" stopColor="#fff" stopOpacity="0" /></linearGradient>
      </defs>
      <circle cx="420" cy="92" r="64" fill="url(#la-sky)" />
      <path d="M40 210 C 160 60, 360 40, 500 120" fill="none" stroke="#fff" strokeOpacity=".7" strokeWidth="2.5" strokeDasharray="6 9" />
      <circle cx="40" cy="210" r="7" fill="#fff" /><circle cx="500" cy="120" r="7" fill="#fff" />
      <g transform="translate(300 62) rotate(12)" fill="#fff">
        <path d="M-46 0 L40 -4 Q56 0 40 4 Z" />
        <path d="M-6 -2 L-26 -34 L-14 -34 L14 -2 Z" /><path d="M-6 2 L-26 34 L-14 34 L14 2 Z" />
        <path d="M-40 -1 L-50 -16 L-43 -16 L-30 -1 Z" />
      </g>
      <g fill="#fff" fillOpacity=".9">
        <rect x="20" y="230" width="34" height="70" /><rect x="58" y="200" width="26" height="100" /><rect x="88" y="244" width="40" height="56" />
        <rect x="132" y="180" width="22" height="120" /><path d="M136 180 L143 150 L150 180 Z" /><rect x="158" y="222" width="36" height="78" />
        <rect x="198" y="196" width="30" height="104" /><rect x="232" y="250" width="44" height="50" /><rect x="280" y="210" width="26" height="90" />
        <path d="M312 300 V214 Q328 186 344 214 V300 Z" /><rect x="350" y="236" width="38" height="64" /><rect x="392" y="188" width="24" height="112" />
        <path d="M394 188 L404 120 L414 188 Z" /><rect x="420" y="226" width="40" height="74" /><rect x="464" y="204" width="28" height="96" /><rect x="496" y="240" width="44" height="60" />
      </g>
      <g fill="#c8102e" fillOpacity=".55">
        {[0, 1, 2, 3, 4].map((r) => [0, 1].map((c) => <rect key={`${r}${c}`} x={62 + c * 10} y={210 + r * 16} width="5" height="8" />))}
        {[0, 1, 2, 3].map((r) => [0, 1].map((c) => <rect key={`b${r}${c}`} x={203 + c * 12} y={208 + r * 18} width="6" height="9" />))}
        {[0, 1, 2, 3].map((r) => <rect key={`c${r}`} x={400} y={200 + r * 20} width="8" height="10" />)}
      </g>
    </svg>
  );
}
