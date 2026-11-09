# ABC Cargo platform — working notes for Claude

- Scope: ABC Cargo business app. Public repo → fictional demo data only; never commit real customer, employee, financial data or credentials.
- Priority order (owner decision 2026-11-09): **international air courier & air cargo first**, then domestic & logistics; full CRM; auto + manual GPS pickup routing.
- Stack: Node 22 (`node:sqlite`, Express 5, zod) in `server/`; React 18 + Vite multi-page in `web/` (ERP + driver/warehouse/customer PWAs).
- Verify before claiming done: `npm --prefix server test` (13 tests) and `npm --prefix web run build`; browser smoke via Playwright (all ERP pages + 3 apps, 0 console errors on last run).
- Demo: `npm run seed && npm start` → http://localhost:4000, logins `*@abccargo.demo` / `Demo@2026`.

## Checkpoint (2026-11-09)
- Done: API (RBAC, audit), international module (zones, customs, DDP/DAP, manifests/MAWB, agents, pre-alert), domestic lifecycle, routing (auto/manual, GPS, geofence), CRM, finance, 4 frontends, Docker, CI.
- Not done / next: real payment gateway, customs/airline/agent API integrations, SMS/WhatsApp notifications, PostgreSQL migration, object storage for POD images, native store wrappers (Capacitor), DAST scan (HawkScan needs `HAWK_API_KEY`).
- Note: lives in the personal profile repo branch `claude/abc-cargo-erp-mobile-mdwam7`; recommended to move to an @abccargoIT org repo.
