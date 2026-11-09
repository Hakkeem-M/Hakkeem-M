# ABC Cargo platform — working notes for Claude

- Scope: ABC Cargo business app. Public repo → fictional demo data only; never commit real customer, employee, financial data or credentials.
- Priority order (owner decision 2026-11-09): **international air courier & air cargo first**, then domestic & logistics; full CRM; auto + manual GPS pickup routing.
- Regions (owner decision 2026-11-09): **UAE, UK, KSA, India** with regional user logins; group admins see all. Existing UK ERP reviewed (gap analysis kept private, not in repo) — parity items G1–G5 done.
- Stack: Node 22 (`node:sqlite`, Express 5, zod) in `server/`; React 18 + Vite multi-page in `web/` (ERP + driver/warehouse/customer PWAs).
- Verify before claiming done: `npm --prefix server test` (27 tests) and `npm --prefix web run build`; browser smoke via Playwright (all ERP pages + 3 apps, 0 console errors on last run).
- Demo: `npm run seed && npm start` → http://localhost:4000, logins `*@abccargo.demo` / `Demo@2026`.

## Checkpoint (2026-11-09)
- Done: API (RBAC, audit), international module (zones, customs, DDP/DAP, manifests/MAWB, agents, pre-alert), domestic lifecycle, routing (auto/manual, GPS, geofence), CRM, finance, 4 frontends, Docker, CI.
- Done 2026-11-09 (phase 1): regions/entities, regional login & scoping, multi-box + sea CBM, charges, quotations, saved receivers, KYC docs, sea manifests.
- Done 2026-11-09 (UI theme): UK-ERP-style crimson theme (tokens in `web/src/shared/styles.css`), Poppins self-hosted via @fontsource, `shared/Logo.jsx` (ABC circles + login art), split-screen login, maroon collapsible sidebar, ERP multi-tab workspace (sessionStorage), dashboard greeting + coloured KPI cards, red PWA icons (PNGs re-rendered with Playwright).
- Done 2026-11-09 (phase 2a): Agent inbox (`/api/inbox`, omnichannel enquiries + messages, PABX/WhatsApp/email incoming endpoint, duplicates, callback/lost/close), lead form, enquiry pipeline, COLLECTION auto-book + nearest-free-driver assign (`lib/pickups.js`), quote-from-enquiry, pickups & deliveries board (`/api/pickups`, start/collected/missed/postpone/cancel; driver start + pickup-missed). Login uses owner's red-glass + London skyline artwork (`web/public/brand/`). 24 tests.
- Done 2026-11-09: login has no region picker — domain decides (`server/src/lib/site.js`, `REGION_DOMAINS`): abccargo.ae=AE, abccargo.uk=GB, abccargogcc.com=SA, abccargo.com=GROUP (group admins only); India domain not yet given. 27 tests.
- Next (phase 2, UK-ERP gaps G6–G11): live channel connectors (PABX/WhatsApp Business/mailbox → `POST /api/inbox/incoming`), accounts module (ledger, vouchers, bank rec, P&L), agent codes & commission report, dispatch shifts/time windows/replay, vehicles & van logs, stock (packing materials), approvals, Microsoft Entra SSO, UK postcode lookup, tabbed workspace (basic version done).
- Not done / next: real payment gateway, customs/airline/agent API integrations, SMS/WhatsApp notifications, PostgreSQL migration, object storage for POD images, native store wrappers (Capacitor), DAST scan (HawkScan needs `HAWK_API_KEY`).
- Note: lives in the personal profile repo branch `claude/abc-cargo-erp-mobile-mdwam7`; recommended to move to an @abccargoIT org repo.
