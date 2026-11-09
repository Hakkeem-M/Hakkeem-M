// Domain-based regions: each regional site only admits that region's accounts; the group site admits group users.
//   abccargo.ae → UAE · abccargo.uk → UK · abccargogcc.com → KSA · abccargo.com → group (global) admin
// Override with REGION_DOMAINS="abccargo.ae=AE,abccargo.uk=GB,abccargogcc.com=SA,abccargo.in=IN,abccargo.com=GROUP".
export const DEFAULT_REGION_DOMAINS = 'abccargo.ae=AE,abccargo.uk=GB,abccargogcc.com=SA,abccargo.com=GROUP';

export function parseRegionDomains(spec = DEFAULT_REGION_DOMAINS) {
  return String(spec).split(',').map((s) => s.trim()).filter(Boolean).map((pair) => {
    const [domain, code] = pair.split('=').map((x) => x.trim());
    return { domain: domain.toLowerCase().replace(/^www\./, ''), code: (code || '').toUpperCase() };
  }).filter((d) => d.domain && /^([A-Z]{2}|GROUP)$/.test(d.code));
}

/** Region for the request's host (sub-domains such as erp.abccargo.uk included), or null on other hosts (dev, demo). */
export function siteRegion(req) {
  const host = String(req.hostname || '').toLowerCase();
  const list = req.config?.regionDomains || parseRegionDomains();
  const hit = list.find((d) => host === d.domain || host.endsWith(`.${d.domain}`));
  return hit?.code ?? null;
}

/** Sign-in domain for a region code, for "sign in at …" messages. */
export function domainFor(req, code) {
  return (req.config?.regionDomains || parseRegionDomains()).find((d) => d.code === code)?.domain ?? null;
}
