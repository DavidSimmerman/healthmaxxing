# 🌙 Nightshift log — healthmaxxing

Run started: 2026-06-24. Branch: `feat/nightshift-reports` (off `main`).

## How to run / verify
- Build + restart: `pnpm build && sudo systemctl restart healthmaxxing` (port 5184, prod build).
- Typecheck: `pnpm check` (must be 0 errors).
- Migrations: edit schema.ts → `set -a && . ./.env && set +a && pnpm drizzle-kit generate` → `pnpm db:migrate`.
- Selfchecks: `npx tsx src/lib/<name>.selfcheck.ts`.
- Screenshots: Playwright + minted `hd_session` cookie → localhost:5184/<page>.
- Live: https://healthmaxxing.simmerman.cc

## Status / task list
### A. Quick fixes
- [ ] A1 — sleepInsights: remove alcohol references, neutral notes + selfcheck
- [ ] A2 — delete Data sources (/data routes, home link, dataSources.ts)
### B. Pull-to-refresh
- [ ] B — reusable pullToRefresh action, applied to home/sleep/day/trends/deficit/settings/reports
- [ ] B — /sleep refresh triggers Fitbit sync first (session-gated), then reload
### C. More sleep insights
- [ ] C — awakenings, bedtime/wake consistency, sleep debt, RHR/HRV trend, social jetlag + selfcheck
### D. Claude data review & reports
- [ ] D1 — export_data MCP tool (period-scoped, category registry, reuse existing fns)
- [ ] D2 — settings.notes column + textarea + PUT + include in export
- [ ] D3 — reports table + save_report/list_reports/get_report MCP tools + /reports page
- [ ] D4 — routine prompt in final summary (do NOT create the schedule)

## Decisions (autonomous calls + why)
- Work directly on `main` (user brief explicitly frames a main-based flow: "On main… push when done & verified"). Small commits; push only when green.
- export_data: `{category -> async(from,to)=>data}` registry in new `src/lib/server/healthExport.ts`, reusing healthReview/nutritionReport+logEntries/bodyInsights/deficitDays. `vitals` = healthReview metrics minus sleep_* (so a future daily_metrics key like blood_glucose flows in with zero changes). Categories: nutrition, sleep, vitals, activity, workouts, body, energy. `all` bundles every category + settings.notes.
- Reports markdown: render server-side in `+page.server.ts` with `marked` + `sanitize-html` (added deps) → {@html}. Markdown render+sanitize is the "don't hand-roll security" exception to ponytail.
- Pull-to-refresh: one Svelte action `use:pullToRefresh` (injects its own spinner). Default handler = invalidateAll(); /sleep handler POSTs sync first. I do this cross-cutting step last (touches all pages) to avoid collisions with the parallel agents.
- Home header: removed /data link, added /reports link (consolidated all home-header edits here).
- Plan: foundation (A2 + schema/migration) inline → parallel Agent-C (A1+C, owns sleep* + sleepInsights*) and Agent-D (D1/D2/D3, owns mcp/+server.ts, healthExport, reports routes, settings) → inline B last.

## Resume pointer
Read this log + the task brief. Continue from first unchecked item. Core files:
src/routes/mcp/+server.ts, src/lib/server/db/schema.ts, src/lib/sleepInsights.ts,
src/routes/sleep/*, src/lib/server/healthMetrics.ts.
