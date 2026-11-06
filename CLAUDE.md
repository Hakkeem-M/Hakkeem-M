# CLAUDE.md — Working Rules (Hakkeem M)

These are the standing instructions for Claude in this repository.

## 1. Understand and act
- Follow the latest instruction closely; read short messages and typos from context.
- "Fix it", "take access", "help me", "do it" = perform the work. Start promptly; continue until done or genuinely blocked.

## 2. Keep answers short
- Result first. Default 2–5 short lines or bullets.
- "Short", "quick", "urgent" → shortest useful response.
- No long intros, repeated explanations, generic warnings, or unnecessary options. Add detail only when asked or essential.

## 3. Do the work yourself
- Use the available, authorised tools (terminal, files, browser, connectors) to inspect, act, and verify.
- Don't hand back manual work you can do. Don't stop at a plan or keep asking whether to continue.
- Never fake access or claim completion without evidence. If blocked, state the exact blocker and the minimum action needed from me.

## 4. Minimise questions
- Check context, files, memory, and tools before asking. Assume sensibly for routine, reversible choices.
- Ask one focused question only when it materially affects target, permissions, cost, privacy, or an irreversible outcome — and keep working on other parts meanwhile.

## 5. Respect authorisation
- "Approved", "go ahead", "take access", "do it" authorise the described work within its scope. No special phrases; don't re-ask.
- Keep backups/rollback for consequential changes. Seek new approval only for material risk outside the authorised scope.
- Follow platform/organisation/tool requirements; explain any real restriction briefly and complete the permitted parts.

## 6. Clear steps when my action is needed
- Numbered steps with exact starting point, menu, button, command, value, and expected result.
- Pause only for a real dependency (result, login, MFA, decision). Request screenshots only to resolve a specific uncertainty.

## 7. Work accurately
- Verify device, account, tenant, environment, permissions, and paths by inspection where possible.
- Minimal changes; preserve unrelated work.
- Code: complete files/functions, verification steps, expected results, rollback.
- Diagnose errors before changing approach. Never blindly repeat failed commands or call untested work verified.

## 8. Memory and continuity
- Read this file and the checkpoint below when resuming; don't make me repeat myself.
- Keep notes concise: completed work, exact paths, versions, verification, blockers, next action. Update stale info; remove duplication.
- Never store credentials. Never invent missing context. Approvals stay tied to their original scope.

## 9. Protect information
- Keep personal, ABC Cargo, and lab work separate. Minimum necessary access.
- Protect confidential data and credentials.
- Modify financial, audit, or evidence records only when explicitly authorised.
- Official documents: approved branding and accurate corporate facts only.

## 10. Report results
- Briefly state what was done, how it was verified, and any remaining blocker.
- Challenge mistaken assumptions; recommend the strongest workable alternative.
- For substantial tasks, end with a compact **STATE** block: decisions, file versions, open issues, next action.

---

## Project checkpoint

- **Repo:** `hakkeem-m/hakkeem-m` — GitHub profile README (personal scope; keep separate from ABC Cargo/lab work).
- **Files:** `README.md` (privacy-safe professional profile), `CLAUDE.md` (this file).
- **Last update:** 2026-11-05 — added CLAUDE.md working rules.
- **Open issues:** GitHub push returns 403 (Claude app has no access to `Hakkeem-M/*`).
- **Next action:** once access is fixed, push this branch and open a draft PR.

## Crown Lanka Garage ERP (separate project)

- **Target repo:** `Hakkeem-M/CrownLanka-Auto-Garage-Project` (not attached yet, access denied).
- **Prototype v1 (2026-11-05):** a single-file HTML app, published as private artifact https://claude.ai/artifact/Dvg4MXCEbo4ivnizREuyNS. Sources were built in a session scratchpad (`garage-erp/src/*`, assembled into `index.html`). Push them to the target repo once access works.
- **Modules:** dashboard, job cards (services, parts, inspection, photos, voice notes), task board, technician/bay schedule, bookings, vehicle history, POS, invoices + VAT, CRM, WhatsApp/SMS/email messaging, inventory, purchase orders, reports, P&L and chart of accounts, attendance and payroll, customer app, role-based access.
- **v2 (2026-11-05):** lighter background with moving colour blobs; frosted-glass sidebar, top bar and phone tab bar; Machines module (gate camera plate reads, diagnostic scanner, aligner, battery tester, AC station, dyno, balancer, lift sensors; readings attach to job cards; calibration alerts on dashboard).
- **v3–v6 (2026-11-05):** opens in light theme by default (moon/sun toggle); Crown Lanka logo, background removed, in sidebar, invoice and customer app; subtle animations, switched off under reduced-motion; logo red #b8141b and gold #a87418 as main colours; sign-in screen with 5 demo users (one per role) and sign-out. The sign-in check runs in the browser only, so this is not real security.
- **Verified:** headless Chromium click-through of all 18 screens with no errors, no horizontal overflow at 390 px, light and dark themes.
- **v7:** red and white only; the 6-colour palette is backed up as `head.v6.bak`.
- **Cloudflare demo (2026-11-06):** Worker `crownlanka-garage-erp-demo` on account `1586ab21…`, live at https://crownlanka-garage-erp-demo.crownlankadxb.workers.dev/ and the custom domain https://erp.crownlanka.ae (Worker custom domain, zone `crownlanka.ae`, auto DNS record and certificate, added 2026-11-06). The API token is an account-owned token saved as a session network secret; it is checked at `/accounts/{id}/tokens/verify`, not `/user/tokens/verify`. Redeploy with `cf-worker/deploy.sh` (scratchpad). The demo is public, noindex, sample data only.
- **v8–v12 (2026-11-06):** login now opens first on every visit, with a cinematic garage scene (orange/blue neon), dynamic island and liquid glass; app is black and white with liquid glass and a dynamic island in the top bar; workers.dev route disabled; Super admin module (users, roles & permissions matrix, branches, modules on/off, security policy, audit log, backup/restore/reset). An empty sign-in opens Super admin (`admin`). Footer: "Developed by Hakkeem".
- **Limits:** sample data, stored only in the browser's localStorage. No backend, no logins, no messaging or payment gateways.
- **Next:** pick the production stack (backend + DB + auth) and port modules.
