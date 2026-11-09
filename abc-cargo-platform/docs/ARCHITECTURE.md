# Architecture

```
            ┌──────────── HTTPS (reverse proxy) ────────────┐
 Browsers / │  /erp   /driver   /warehouse   /customer   /api │
 PWAs       └───────────────────────┬────────────────────────┘
                                    │
                    Node 22 · Express 5 (server/src)
   routes/  auth · public · shipments · international · warehouse · driver
            routing · crm · finance · customer · admin · reports
   lib/     pricing (zones, duties, VAT) · shipments (domain) · geo (VRP) · auth · schemas
                                    │
                      SQLite (node:sqlite, WAL)  ← swap for PostgreSQL at scale
```

## Shipment lifecycle

International: `BOOKED → PICKUP_ASSIGNED → PICKED_UP → IN_WAREHOUSE (hub IN-scan) → MANIFESTED (OUT-scan to manifest) → DEPARTED → ARRIVED → CUSTOMS_CLEARED | CUSTOMS_HOLD → WITH_AGENT → OUT_FOR_DELIVERY → DELIVERED`

Domestic: `BOOKED → PICKUP_ASSIGNED → PICKED_UP → IN_WAREHOUSE → OUT_FOR_DELIVERY → DELIVERED | DELIVERY_FAILED → (IN-scan) → … | RETURNED`

Every transition writes a `shipment_events` row (public or internal) and sensitive actions write `audit_log`.

## Pricing
`chargeable = max(actual, L×W×H×pieces / divisor)` rounded up to 0.5 kg (divisor 5000 courier, 6000 air cargo).
Freight = max(min_charge, base + extra kg × per_kg) + fuel surcharge (intl/domestic %) + COD fee (domestic) + DG surcharge + DDP duties.
Duties: if customs value > de-minimis → duty = (value + freight) × duty %, import tax = (value + freight + duty) × import VAT %. Documents are duty-free. UAE VAT 5 % domestic; exports 0 %.

## Routing
`lib/geo.js` — haversine × road factor 1.35; auto routing uses cheapest-insertion across drivers (capacity & max-km limits) then 2-opt per route; drivers start from their live GPS fix if seen in the last 10 minutes, else their depot branch. Manual routes keep the dispatcher's order or run nearest-neighbour + 2-opt. Swap in a road-network matrix (OSRM / Google Distance Matrix) by replacing `roadKm`.

## Integration points (production next steps)
| Area | Where | Notes |
|---|---|---|
| Online payments | `routes/customer.js` `POST /invoices/:id/pay` | Replace demo with provider checkout + signed webhook |
| Customs (UAE export declaration) | `routes/international.js` `/shipments/:id/customs` | Submit via customs broker / single-window API, store declaration no. in `customs_ref` |
| Airline / e-AWB | manifest close/depart | Send FWB/FHL messages, pull flight status to auto-depart/arrive |
| Overseas agents | `/shipments/:id/agent-event` | Expose per-agent API keys or ingest partner tracking webhooks |
| Notifications | `addEvent` | Hook SMS / WhatsApp / email on milestones |
| Maps | `VITE_TILE_URL`, `MAP_TILE_HOSTS` | Commercial tile provider for production volume |
| Native store apps | `web/` PWAs | Wrap with Capacitor for Play Store / App Store if required |

## Scaling
- Move to PostgreSQL (SQL is positional-parameter ANSI; replace `db.js`), add Redis for rate limits & sessions when running >1 instance.
- Store POD images in object storage (S3/R2) instead of the `shipments` row.
- Run reports from a read replica.
