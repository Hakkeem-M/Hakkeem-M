// Geo utilities + route optimisation (cheapest-insertion VRP heuristic with 2-opt refinement).
// Pure functions, no external map API required. Distances are great-circle × road factor.

export const CITY_CENTROIDS = {
  Dubai: [25.2048, 55.2708],
  'Abu Dhabi': [24.4539, 54.3773],
  'Al Ain': [24.2075, 55.7447],
  Sharjah: [25.3463, 55.4209],
  Ajman: [25.4052, 55.5136],
  'Umm Al Quwain': [25.5647, 55.5552],
  'Ras Al Khaimah': [25.8007, 55.9762],
  Fujairah: [25.1288, 56.3265],
};

const ROAD_FACTOR = 1.35; // city road network vs straight line
export const AVG_SPEED_KMH = 32;
export const SERVICE_MIN_PER_STOP = 8;

export function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
export const roadKm = (a, b) => haversineKm(a, b) * ROAD_FACTOR;

export function cityPoint(city) {
  const c = CITY_CENTROIDS[city];
  return c ? { lat: c[0], lng: c[1] } : null;
}

export const validPoint = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng) &&
  Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;

/** Total length of a path start -> stops[0..n] (open route, no return to depot). */
export function pathKm(start, stops) {
  let d = 0;
  let prev = start;
  for (const s of stops) { d += roadKm(prev, s); prev = s; }
  return d;
}

/** 2-opt improvement of an open path with fixed start. */
export function twoOpt(start, stops, maxIter = 50) {
  if (stops.length < 3) return stops.slice();
  let best = stops.slice();
  let bestLen = pathKm(start, best);
  for (let iter = 0; iter < maxIter; iter++) {
    let improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let k = i + 1; k < best.length; k++) {
        const cand = best.slice(0, i).concat(best.slice(i, k + 1).reverse(), best.slice(k + 1));
        const len = pathKm(start, cand);
        if (len + 1e-9 < bestLen) { best = cand; bestLen = len; improved = true; }
      }
    }
    if (!improved) break;
  }
  return best;
}

/** Nearest-neighbour ordering then 2-opt. Used for manual "optimise this driver's route". */
export function optimiseSequence(start, stops) {
  const left = stops.slice();
  const out = [];
  let cur = start;
  while (left.length) {
    let bi = 0;
    let bd = Infinity;
    left.forEach((s, i) => { const d = roadKm(cur, s); if (d < bd) { bd = d; bi = i; } });
    cur = left.splice(bi, 1)[0];
    out.push(cur);
  }
  return twoOpt(start, out);
}

/**
 * Auto-routing. Assign stops to drivers and sequence them.
 * @param {Array<{id, lat, lng}>} stops
 * @param {Array<{id, lat, lng, capacity, existing?: Array}>} drivers  lat/lng = current GPS or depot
 * @param {{maxRouteKm?: number}} opts
 * @returns {{routes: Array<{driver_id, stops, distance_km, duration_min}>, unassigned: Array}}
 */
export function autoRoute(stops, drivers, { maxRouteKm = 250 } = {}) {
  const routes = drivers.map((d) => ({
    driver: d,
    seq: (d.existing || []).slice(),
    cap: Math.max(0, (d.capacity ?? 25) - (d.existing || []).length),
  }));
  const pending = stops.filter(validPoint).slice();
  const unassigned = stops.filter((s) => !validPoint(s));

  // Cheapest insertion: repeatedly insert the (stop, route, position) with least added distance.
  while (pending.length) {
    let best = null;
    for (let si = 0; si < pending.length; si++) {
      const s = pending[si];
      for (const r of routes) {
        if (r.cap <= 0) continue;
        const pts = [r.driver, ...r.seq];
        for (let pos = 0; pos <= r.seq.length; pos++) {
          const a = pts[pos];
          const b = pts[pos + 1];
          const add = roadKm(a, s) + (b ? roadKm(s, b) - roadKm(a, b) : 0);
          if (!best || add < best.add) best = { add, si, r, pos };
        }
      }
    }
    if (!best) break; // no capacity left
    const s = pending.splice(best.si, 1)[0];
    best.r.seq.splice(best.pos, 0, s);
    best.r.cap--;
    if (pathKm(best.r.driver, best.r.seq) > maxRouteKm) { best.r.seq.splice(best.pos, 1); best.r.cap++; unassigned.push(s); }
  }
  unassigned.push(...pending);

  return {
    routes: routes.filter((r) => r.seq.length).map((r) => {
      const seq = twoOpt(r.driver, r.seq);
      const km = pathKm(r.driver, seq);
      return {
        driver_id: r.driver.id,
        stops: seq,
        distance_km: Math.round(km * 10) / 10,
        duration_min: Math.round((km / AVG_SPEED_KMH) * 60 + seq.length * SERVICE_MIN_PER_STOP),
      };
    }),
    unassigned,
  };
}

/** Deterministic jitter around a city centre — used when an address has no pin yet. */
export function approxPoint(city, seed = 0) {
  const c = cityPoint(city);
  if (!c) return null;
  const r1 = Math.sin(seed * 12.9898) * 43758.5453;
  const r2 = Math.sin(seed * 78.233) * 12345.6789;
  return { lat: c.lat + ((r1 - Math.floor(r1)) - 0.5) * 0.08, lng: c.lng + ((r2 - Math.floor(r2)) - 0.5) * 0.08 };
}
