// Device features: barcode render, camera barcode scanner, signature pad, photo capture, GPS, PWA install.
import { useEffect, useRef, useState } from 'react';
import JsBarcode from 'jsbarcode';

export function Barcode({ value, height = 60, width = 2, fontSize = 14 }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current && value) JsBarcode(ref.current, value, { format: 'CODE128', height, width, fontSize, margin: 4, displayValue: true });
  }, [value, height, width, fontSize]);
  return <svg ref={ref} role="img" aria-label={`Barcode ${value}`} />;
}

const FORMATS = ['code_128', 'code_39', 'ean_13', 'qr_code', 'data_matrix', 'itf'];

/**
 * Camera scanner. Uses the native BarcodeDetector (Android Chrome) and falls back to ZXing (iOS Safari, desktop).
 * Calls onScan(text) with a 1.5 s de-duplication window.
 */
export function CameraScanner({ onScan, active = true }) {
  const videoRef = useRef(null);
  const [err, setErr] = useState(null);
  const last = useRef({ text: '', at: 0 });

  useEffect(() => {
    if (!active) return undefined;
    let stream; let stop = false; let zxingControls; let raf;
    const emit = (text) => {
      const now = Date.now();
      if (text && (text !== last.current.text || now - last.current.at > 1500)) {
        last.current = { text, at: now };
        onScan(text.trim());
      }
    };
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera not available on this device/browser (HTTPS required)');
        if ('BarcodeDetector' in window) {
          const supported = await window.BarcodeDetector.getSupportedFormats();
          const detector = new window.BarcodeDetector({ formats: FORMATS.filter((f) => supported.includes(f)) });
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
          if (stop) return;
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
          const tick = async () => {
            if (stop) return;
            try {
              const codes = await detector.detect(videoRef.current);
              if (codes[0]) emit(codes[0].rawValue);
            } catch { /* frame not ready */ }
            raf = setTimeout(tick, 180);
          };
          tick();
        } else {
          const { BrowserMultiFormatReader } = await import('@zxing/browser');
          const reader = new BrowserMultiFormatReader();
          zxingControls = await reader.decodeFromVideoDevice(undefined, videoRef.current, (res) => res && emit(res.getText()));
        }
      } catch (e) {
        setErr(e.message || 'Unable to start camera');
      }
    })();
    return () => {
      stop = true;
      clearTimeout(raf);
      zxingControls?.stop();
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [active, onScan]);

  if (err) return <div className="alert warn small">{err}. Use a hardware scanner or type the AWB.</div>;
  return (
    <div className="scanner">
      <video ref={videoRef} muted playsInline />
      <div className="frame" aria-hidden="true" />
    </div>
  );
}

export function SignaturePad({ onChange }) {
  const ref = useRef(null);
  const drawing = useRef(false);
  const dirty = useRef(false);
  useEffect(() => {
    const c = ref.current;
    const ratio = window.devicePixelRatio || 1;
    c.width = c.offsetWidth * ratio;
    c.height = c.offsetHeight * ratio;
    const ctx = c.getContext('2d');
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.strokeStyle = '#0f172a';
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  }, []);
  const pos = (e) => { const r = ref.current.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const down = (e) => { drawing.current = true; ref.current.setPointerCapture(e.pointerId); const ctx = ref.current.getContext('2d'); ctx.beginPath(); ctx.moveTo(...pos(e)); };
  const move = (e) => { if (!drawing.current) return; const ctx = ref.current.getContext('2d'); ctx.lineTo(...pos(e)); ctx.stroke(); dirty.current = true; };
  const up = () => { if (!drawing.current) return; drawing.current = false; if (dirty.current) onChange(ref.current.toDataURL('image/png')); };
  const clear = () => {
    const c = ref.current; const ctx = c.getContext('2d');
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.restore();
    dirty.current = false; onChange(null);
  };
  return (
    <div className="stack" style={{ gap: 6 }}>
      <canvas ref={ref} className="sig" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={up} aria-label="Signature pad" />
      <div className="row between"><span className="tiny muted">Receiver signs above</span><button type="button" className="btn sm" onClick={clear}>Clear</button></div>
    </div>
  );
}

/** Photo capture -> downscaled JPEG data URL (max 1280px, ~200-400 KB). */
export function PhotoInput({ onChange, label = 'Take photo' }) {
  const [preview, setPreview] = useState(null);
  const pick = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const img = await createImageBitmap(f);
    const scale = Math.min(1, 1280 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const url = c.toDataURL('image/jpeg', 0.72);
    setPreview(url); onChange(url);
  };
  return (
    <div className="stack" style={{ gap: 6 }}>
      <label className="btn block">📷 {label}<input type="file" accept="image/*" capture="environment" onChange={pick} hidden /></label>
      {preview && <img src={preview} alt="Proof of delivery" style={{ width: '100%', borderRadius: 10 }} />}
    </div>
  );
}

/** One-shot GPS fix (resolves null if unavailable/denied, never rejects). */
export function getPosition(timeout = 8000) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout, maximumAge: 30000 },
    );
  });
}

/**
 * Background-ish GPS tracker for drivers: watchPosition, send at most every `everyMs`,
 * buffer while offline and flush in batches.
 */
export function useGpsTracker(api, enabled, everyMs = 30000) {
  const [state, setState] = useState({ status: 'off', last: null, queued: 0 });
  useEffect(() => {
    if (!enabled || !navigator.geolocation) { setState((s) => ({ ...s, status: navigator.geolocation ? 'off' : 'unsupported' })); return undefined; }
    let buf = [];
    let lastSent = 0;
    const flush = async () => {
      if (!buf.length || !navigator.onLine) return;
      const batch = buf.slice(0, 100);
      try { await api.post('/api/driver/location', { points: batch }); buf = buf.slice(batch.length); lastSent = Date.now(); } catch { /* retry later */ }
      setState((s) => ({ ...s, queued: buf.length }));
    };
    const id = navigator.geolocation.watchPosition(
      (p) => {
        const pt = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy ?? undefined,
          speed: p.coords.speed ?? undefined, heading: Number.isFinite(p.coords.heading) ? p.coords.heading : undefined, recorded_at: new Date(p.timestamp).toISOString() };
        setState((s) => ({ ...s, status: 'on', last: pt }));
        if (Date.now() - lastSent >= everyMs || !buf.length) { buf.push(pt); flush(); }
      },
      () => setState((s) => ({ ...s, status: 'denied' })),
      { enableHighAccuracy: true, maximumAge: 15000, timeout: 30000 },
    );
    const t = setInterval(flush, everyMs);
    window.addEventListener('online', flush);
    return () => { navigator.geolocation.clearWatch(id); clearInterval(t); window.removeEventListener('online', flush); };
  }, [api, enabled, everyMs]);
  return state;
}

export function registerSW() {
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

/** Feedback for scanners: beep + vibrate. */
export function feedback(ok) {
  try {
    navigator.vibrate?.(ok ? 60 : [120, 60, 120]);
    const ctx = feedback.ctx || (feedback.ctx = new (window.AudioContext || window.webkitAudioContext)());
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.frequency.value = ok ? 1250 : 320; o.type = ok ? 'sine' : 'square';
    g.gain.value = 0.08; o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + (ok ? 0.09 : 0.3));
  } catch { /* audio unavailable */ }
}
