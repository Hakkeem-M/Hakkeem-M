// Tiny fetch client. Each app keeps its own session (token) under its own storage key.
export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const safeStore = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } },
};
export { safeStore };

export function createApi(appKey) {
  const key = `abc.${appKey}.token`;
  const rkey = `abc.${appKey}.region`;
  let token = safeStore.get(key);
  let region = safeStore.get(rkey); // AE | GB | SA | IN | null (all regions, group users only)
  let onUnauthorized = () => {};

  async function request(method, url, body) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    if (region) headers['X-Entity'] = region;
    let res;
    try {
      res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new ApiError(0, 'Network unavailable — check your connection');
    }
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
    if (!res.ok) {
      if (res.status === 401 && token) { token = null; safeStore.set(key, null); onUnauthorized(); }
      const fieldErr = data?.details?.fieldErrors && Object.entries(data.details.fieldErrors).map(([f, m]) => `${f}: ${m[0]}`).join('; ');
      throw new ApiError(res.status, fieldErr ? `${data.error} — ${fieldErr}` : (data?.error || `Request failed (${res.status})`), data?.details);
    }
    return data;
  }

  return {
    get: (u) => request('GET', u),
    post: (u, b = {}) => request('POST', u, b),
    put: (u, b) => request('PUT', u, b),
    patch: (u, b) => request('PATCH', u, b),
    del: (u) => request('DELETE', u),
    setToken(t) { token = t; safeStore.set(key, t); },
    get token() { return token; },
    setRegion(r) { region = r || null; safeStore.set(rkey, region); },
    get region() { return region; },
    onUnauthorized(fn) { onUnauthorized = fn; },
  };
}

export const qs = (o) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};
