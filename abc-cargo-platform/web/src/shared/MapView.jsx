// Leaflet map (bundled — no CDN). Tiles default to OpenStreetMap; set VITE_TILE_URL to use a commercial provider.
import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const TILE = import.meta.env.VITE_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const ROUTE_COLORS = ['#1456c4', '#f97316', '#15803d', '#9333ea', '#dc2626', '#0891b2', '#ca8a04', '#db2777'];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * markers: [{ id, lat, lng, kind: 'pickup'|'drop'|'driver'|'depot', label, color, popup, onClick }]
 * lines:   [{ points: [[lat,lng],...], color, dashed }]
 * pick:    (lat,lng) => void   — click to drop a pin (address pinning)
 */
export default function MapView({ markers = [], lines = [], height = 420, pick, fitKey, center = [25.2048, 55.2708], zoom = 11 }) {
  const el = useRef(null);
  const map = useRef(null);
  const layer = useRef(null);
  const fitted = useRef(null);
  const pickRef = useRef(pick);
  pickRef.current = pick;

  useEffect(() => {
    map.current = L.map(el.current, { zoomControl: true, attributionControl: true }).setView(center, zoom);
    L.tileLayer(TILE, { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map.current);
    layer.current = L.layerGroup().addTo(map.current);
    map.current.on('click', (e) => pickRef.current?.(e.latlng.lat, e.latlng.lng));
    const ro = new ResizeObserver(() => map.current?.invalidateSize());
    ro.observe(el.current);
    return () => { ro.disconnect(); map.current.remove(); map.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const g = layer.current;
    if (!g) return;
    g.clearLayers();
    const bounds = [];
    for (const ln of lines) {
      if (ln.points.length < 2) continue;
      L.polyline(ln.points, { color: ln.color || '#1456c4', weight: 4, opacity: 0.85, dashArray: ln.dashed ? '6 8' : null }).addTo(g);
    }
    for (const m of markers) {
      if (!Number.isFinite(m.lat) || !Number.isFinite(m.lng)) continue;
      const color = m.color || (m.kind === 'drop' ? '#15803d' : m.kind === 'depot' ? '#0f172a' : '#1456c4');
      const html = m.kind === 'driver'
        ? `<div class="truck" style="background:${color};opacity:${m.dim ? 0.45 : 1}">🚚</div>`
        : `<div class="pin" style="background:${color}"><span>${esc(m.label ?? '')}</span></div>`;
      const icon = L.divIcon({ html, className: '', iconSize: m.kind === 'driver' ? [30, 30] : [26, 26], iconAnchor: m.kind === 'driver' ? [15, 15] : [13, 26] });
      const mk = L.marker([m.lat, m.lng], { icon, title: m.title || '' }).addTo(g);
      if (m.popup) mk.bindPopup(m.popup); // popup strings are built by callers with esc()
      if (m.onClick) mk.on('click', m.onClick);
      bounds.push([m.lat, m.lng]);
    }
    // fitKey lets callers refit only when the dataset changes, not on every live poll.
    const key = fitKey === undefined ? Symbol('always') : fitKey;
    if (bounds.length && map.current && key !== fitted.current) {
      map.current.fitBounds(bounds, { padding: [30, 30], maxZoom: 14 });
      fitted.current = key;
    }
  }, [markers, lines, fitKey]);

  return <div ref={el} className="map" style={{ height }} />;
}

export { esc };
