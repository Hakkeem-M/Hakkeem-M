# ABC Cargo & Courier — ERP + Mobile Apps (UAE · UK · KSA · India)

International air courier, air cargo and **sea cargo (door-to-door, per CBM)** first; domestic courier & logistics second.
**Four regions, one platform:** each region (UAE, UK, KSA, India) is its own company with its own currency
(AED / GBP / SAR / INR), VAT/GST (5 % / 20 % / 15 % / 18 %), rate cards, packing price list, branches and users.
Regional users log in to their region and only ever see its data; group users (head office) can switch region or view all.
One Node.js API serves four applications:

| App | URL | Users | Highlights |
|---|---|---|---|
| **ERP** (desktop web) | `/erp` | Admin, Ops, Finance, Sales, Warehouse | International exports & customs, air manifests (MAWB), CRM, billing, pickup routing & live GPS, reports, audit |
| **Driver Billing App** (PWA) | `/driver` | Couriers | Route-ordered run sheet, Google Maps navigation, pickup with on-spot billing & receipt, POD (signature + photo) with COD, failed attempts, walk-in bookings, wallet, live GPS |
| **Hub / Warehouse Scanner** (PWA) | `/warehouse` | Warehouse staff | IN scan, OUT scan → air manifest / courier / transfer / return, camera or handheld scanner, offline queue with idempotent sync |
| **Customer App** (PWA) | `/customer` | Public & business customers | Worldwide rates with duty estimate, tracking, booking with commercial invoice, labels, online payment hook, support tickets |

## Feature map

**International (primary)**
- 31 destination countries in zones Z1–Z6 (GCC, Indian subcontinent, Asia Pacific, Europe, Americas, Africa/RoW), editable duty %, import VAT %, de-minimis, gateway airport
- Services: International Express (air courier), International Economy, Air Freight Cargo (6000 volumetric divisor + minimum charge)
- Commercial invoice lines (description, HS code, qty, value, origin) → customs status `PENDING / DOCS_OK / SUBMITTED / HOLD / CLEARED`
- DDP (duties billed to shipper) vs DAP (receiver pays, estimate shown); exports zero-rated for UAE VAT; dangerous-goods surcharge and DG → air cargo only
- Air manifests: scan-to-consolidate with checks (destination match, hub stock, docs complete, DG), flight + MAWB, close → depart → arrive → clear (with holds) → hand over to overseas agent → agent POD; printable cargo manifest and CSV pre-alert (formula-injection safe)
- Milestone tracking: Booked → Picked up → At hub → Manifested → Departed → Arrived → Customs cleared → With partner → Delivered

**Regions & bookings (UK-ERP parity)**
- Regional login on every app; region-bound accounts are refused in other regions; group admins pick a region or 🌐 all
- Multi-box bookings: per box actual/volume/bill weight, CBM, packing type & charge, category; items per box; handling, other, discount, AWB/documentation charges
- Quotations: price → send (WhatsApp / email / print) → accept → convert to booking (auto-creates the customer on first booking)
- Saved receivers (address book) per customer; KYC: sender/receiver ID type, number, expiry + front/back images (staff only, views audited)
- Sea consolidation manifests (vessel, voyage, container, bill of lading); regional sea/air gateways

**Domestic & logistics (secondary)**
- UAE LOCAL/DOMESTIC zones, Same Day / Express / Standard, COD with fee
- Pickup routing: **auto** (cheapest-insertion VRP + 2-opt, driver capacity, live GPS or depot start) with preview → commit, and **manual** (pick stops, re-order, or optimise) — live fleet map, routes log
- Driver GPS pings (batched, offline-buffered); geofence check flags pickups/deliveries confirmed > 0.5 km from the pin
- Warehouse inventory by bin, ageing, transfers, returns

**CRM** — leads & kanban pipeline (weighted value, win rate), activities & follow-ups, lead → customer conversion, contacts, Customer 360 (revenue, AR, credit available, tickets), support tickets with SLA, internal notes hidden from customers.

**Finance** — tax invoices (cash at pickup, prepaid, monthly account billing runs), payments, receivables & overdue, driver cash settlement (must match counted cash), COD remittance to shippers, rate cards, settings.

**Security** — JWT with per-user token version (deactivate / role change / password change revokes sessions), RBAC on every route, customer data isolation, rate-limited login & public endpoints, Helmet CSP, Permissions-Policy (camera & geolocation self only), zod validation, parameterised SQL, audit log, demo payments disabled in production.

## Run locally

```bash
cd abc-cargo-platform
```
```bash
npm run install:all
```
```bash
npm run build
```
```bash
npm run seed
```
```bash
npm start
```
Open http://localhost:4000. For hot reload: `npm run dev:api` and `npm run dev:web` (http://localhost:5173).

Demo logins (fictional data, password `Demo@2026`, domain `@abccargo.demo`) — choose the region on the login screen:

| Region | Users |
|---|---|
| 🌐 Group | `admin@` (all regions) |
| 🇦🇪 UAE | `ops@`, `finance@`, `sales@`, `warehouse@`, `driver1@`, `customer@`, `shop@` |
| 🇬🇧 UK | `admin.uk@`, `ops.uk@`, `finance.uk@`, `sales.uk@`, `warehouse.uk@`, `driver.uk@`, `customer.uk@` |
| 🇸🇦 KSA | same pattern with `.ksa` |
| 🇮🇳 India | same pattern with `.india` |

## Tests
```bash
npm test
```
20 API tests (7 for regions: login rules, data isolation, multi-box sea pricing, regional VAT/GST, quotations, receivers & KYC, sea manifests) plus: pricing/duties/air-cargo maths, routing heuristics, RBAC, PII-safe tracking, domestic lifecycle (book → route → pickup → scan → POD/COD → settle → remit), driver on-spot billing, account billing, prepaid/online pay, CRM & tickets, session revocation, and the full international flow (book with commercial invoice → hub IN → manifest scan → close/depart/arrive/clear → agent POD).

## Deploy (production)
```bash
cp .env.example .env
```
Edit `.env` (strong `JWT_SECRET`, first admin), then:
```bash
docker compose up -d --build
```
Put it behind HTTPS (camera scanning, GPS and PWA install require HTTPS). Data lives in the `abc-data` volume (SQLite, WAL) — back it up daily. See `docs/ARCHITECTURE.md` for scaling to PostgreSQL, payment gateway, customs/airline and agent integrations.

Rollback: `git revert` the release commit (or redeploy the previous image tag); the schema is additive (`CREATE TABLE IF NOT EXISTS`).

> This public repository contains only sanitized, fictional demo data. Company TRN/phone/email in Settings are placeholders — set the real values in production, never commit them.
