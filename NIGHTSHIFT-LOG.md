# NIGHTSHIFT — health insights (weight/BF projections, day view, trends graph, MCP)

Branch: `feat/health-insights` · Worktree: `.claude/worktrees/health-insights`
(symlinked node_modules + .env; shared local Postgres). Dev server: `pnpm dev --port 5192`.

## The brief (4 tasks)
1. **Day view** — browse/look at a specific day's full breakdown (food, macros, energy ledger, weigh-in, workouts, water, metrics). Native `<input type="date">` picker.
2. **Projections** — when BMR isn't estimable, fill from surrounding days (interpolate/trend). Project future weight & body-fat at +1mo/+2mo/custom date from past trend + calorie deficits. Goal (weight or BF%) → ETA at current rate. Professional formulas.
3. **Graph** — weight + body-fat % over time, with projected future line (from prior days + deficits). Hand-rolled SVG (no chart dep — ponytail).
4. **MCP expansion** — expose energy ledger, weight/lean-mass (muscle) trends, water intake, full nutrients eaten, projections — so Claude can critique diet/nutrient gaps. Built to extend later (blood sugar, insulin, sleep…).

## Status
- [x] Worktree + log skeleton
- [x] Foundation: energy.ts projection math (pure + self-check) — `linearRegression`, `projectWeight`, `etaToGoal`, BMR gap-fill
- [x] Foundation: settings goal fields (goalWeightKg, goalBodyFatPct) + migration 0011
- [x] Foundation: `src/lib/server/projections.ts` (build on deficitDays + weigh-ins)
- [x] Task 1: `/day/[date]` page (+ links from /deficit)
- [x] Task 3: `/trends` page + SVG weight/BF chart + projections UI + goal setter (+ API to save goals)
- [x] Task 4: MCP server tools expansion
- [x] Verify: typecheck, playwright screenshots, MCP smoke, codex review
- [x] Commit + final log

## Final state (morning read)
- All 4 tasks built, type-clean (`pnpm check`: 0 errors), and verified live.
- Commits on branch `feat/health-insights` (NOT merged, NOT pushed — per nightshift rules):
  - `55e555d` projection foundation
  - `6d16df3` day view + trends + projections + MCP
  (plus `473670b` the earlier iOS sync-button fix already on main).
- **To ship:** from the main worktree `git rebase`/merge `feat/health-insights` into main, then deploy (migration 0011 runs on deploy). I left it unmerged so you can eyeball it first and because your iOS-widget WIP is live in the main tree.

## Verified (evidence)
- `npx tsx src/lib/energy.selfcheck.ts` → all assertions pass (regression, interpolation, ETA, date math).
- `pnpm check` → 0 errors (2 benign `$state`-prefill warnings on /trends, same pattern as /settings).
- Seeded realistic data (10 weigh-ins, food w/ nutrients, water, workout), screenshotted /trends (chart + rates + projections + goal ETAs), /day/<date> (all cards), /deficit (date picker + tappable rows). Then **deleted all seed data** — dev DB is back to 0 rows.
- MCP end-to-end (temp OAuth token, since cleaned): `tools/list` → 7 tools; `get_body_trends`/`get_nutrition`/`get_energy_ledger` returned correct computed summaries; bad auth → 401.
- codex review: 4 findings (3×P2, 1×P3) — ALL fixed + re-verified live (future day → 404; `/trends?window=Infinity` → 200 in 13ms, no hang; water divisor; APP_TZ weigh-in date).

## Known-minor (revisitable, not blockers)
- Deficit-implied weight rate only spans days with *logged food*; with sparse logging it reads steeper than the measured trend (it's shown as corroboration with the day count, not the primary projection).
- Active-energy on /day comes from `activity_days` (HK daily active), not from `workouts` — a logged workout won't add to "Active" unless HK also recorded active energy that day. Matches how /deficit already works.
- `get_energy_ledger`/`get_nutrition` clamp the `days` arg, but an explicit huge `from..to` span is bounded-but-slow (acceptable for a single-user, auth-gated tool).

## Decisions (autonomous calls)
- Worktree to avoid colliding with the user's live iOS-widget WIP in the main tree (mutagen-synced).
- No chart library — inline SVG line chart. Avoids a dependency for a couple of polylines.
- Weight/BF trend = least-squares linear regression over a trailing window of weigh-ins (smooths daily water-weight noise). Deficit-implied rate (avg deficit ÷ 7700 kcal/kg) shown alongside as corroboration.
- BMR gap-fill: linear interpolation between known-BMR days; carry-forward/extrapolate at the ends. Marked source `interpolated`.
- "Muscle mass" = HealthKit lean body mass (already synced as `bodyComp.leanMassKg`). No separate muscle metric exists.
- Goal ETA uses the measured regression rate (reality) not the deficit-implied rate.
- Projections page lives at `/trends`; day detail at `/day/[date]`; both linked from `/deficit` and the home nav.

## How to run / verify
- `cd .claude/worktrees/health-insights`
- DB push: `DATABASE_URL=postgres://healthdash:healthdash@127.0.0.1:5432/healthdash pnpm db:migrate`
- Dev: `pnpm dev --port 5192` → health: `curl localhost:5192/api/health`
- Auth: pages need a session cookie; mint v1 cookie from MCP_AUTH_PASSWORD (see prior session) or hit /api/* with `Authorization: Bearer $API_TOKEN`.
- Typecheck: `pnpm check`
- MCP: `POST /mcp` JSON-RPC with Bearer token (tools/list, tools/call).

## Resume pointer
If compacted: re-read this file + the brief. Foundation lives in `src/lib/energy.ts` + `src/lib/server/projections.ts`. Check the Status list for the next unchecked item; continue there. Do NOT restart.
