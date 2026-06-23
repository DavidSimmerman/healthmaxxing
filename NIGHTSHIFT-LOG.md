# 🌙 Nightshift Log — Bolusable (net glycemic) carbs

**Task:** (1) Multi-item "log another" flow when logging to today (build up a meal total,
one final confirm). (2) Show BOTH total carbs and bolusable (net glycemic) carbs when
adding items and in history. Derive bolusable carbs as a computed field via one shared
formula (fiber + sugar-alcohol/polyol adjustments), configurable fiber mode, low-confidence
flagging. David is T1D and doses insulin off this number — correctness & transparency matter.

**Branch:** `feat/bolusable-carbs` (off `feat/mcp-back-correct` HEAD).
**Project root:** `~/dev/healthmaxxing` (SvelteKit + TS + Drizzle/Postgres). This app backs
the "Health Dashboard" MCP server.

## ⚠️ IMPORTANT — preserved human WIP
Before starting I stashed the human's unrelated in-progress **Fitbit/Google Health sync**
work (was uncommitted on `feat/mcp-back-correct`). To restore it:
```
git switch feat/mcp-back-correct && git stash pop   # stash@{0}
```
Do NOT discard `stash@{0}`. It touches schema.ts, mcp/+server.ts, drizzle/0012*, fitbitParse*, period*.

## Status
- [x] Locate project, set up branch, stash human WIP, write log skeleton
- [ ] Explore: data model + derivation surface + UI flows (subagents)
- [x] Pure derivation module `netCarbs()` + tests (TDD) — `src/lib/netCarbs.ts` + `.check.ts` GREEN
- [x] Wire derived `bolusableCarbsG` into read/serialization layer — DONE: history endpoint,
      today loader, day loader, /api/today, /api/log, /api/foods POST, nutrition report +
      logEntries, MCP log_food/prep_food/list_foods/get_day_log/get_nutrition. `pnpm check` 0 errors.
- [x] Fiber-mode setting: `settings.fiberMode` column + migration 0012 + /api/settings validation +
      `getFiberMode()` reader. UI toggle = part of settings UI task below.
- [ ] UI: multi-item "log another" flow + final confirm (CaptureSheet)
- [ ] UI: show Total + Bolusable carbs when adding and in history; surface lowConfidence
- [ ] UI: settings fiber-mode toggle + clinical-calibration note
- [ ] Seed local DB + Playwright drive the flow (capture sheet empty on fresh DB)
- [ ] Audit existing logged/catalog entries: confirm carbsG = TOTAL everywhere (via MCP live data)
- [ ] Verify (tests green, Playwright flow, codex review --uncommitted)
- [ ] Final commit + wake-up message

## Decisions (autonomous)
- Stashed unrelated Fitbit WIP and branched fresh, to keep this feature's diff clean and
  not clobber the human's work.
- bolusableCarbsG is a **computed/derived** field (read layer), not a stored column — matches
  the plan and avoids a migration collision with the stashed Fitbit drizzle migration.
- **No existing net-carb logic found in code** — `carbsG` already holds TOTAL carbs everywhere.
  The plan's worry about historically baked-in net carbs is mostly moot. Will still spot-check
  live data via MCP `get_day_log`/`list_foods`.
- **Polyol typing isn't in the data model** — `nutrients` is a flat jsonb bag with a single
  `sugarAlcoholG` (no per-polyol type, no `alluloseG`). So the pure function implements the
  full POLYOL_FACTOR table (correct + tested for erythritol/maltitol/etc.), but the live
  serialization always passes `polyolType: 'unknown'` → 0.5 factor (the plan's safe default,
  errs toward HIGHER carbs). Per-food polyol tagging = future scope (YAGNI now).
- **Single derivation: `bolusableCarbsPerServing(food, {fiberMode})`** → recipes sum at the
  ingredient level ÷ makesServings (correct under the nonlinear half_over_5 fiber rule);
  simple foods use flat per-serving values. Any quantity = perServing × servings (linear).
  API returns per-serving `bolusableCarbsG` + `bolusableLowConfidence`; UI multiplies.
- **fiberMode** stored as a new `settings.fiberMode` column (codebase convention; single-row
  settings table). Default `'full'` (David's standing rule). Migration will be 0012 on this
  branch — note: stashed Fitbit work also adds a 0012; that's a normal merge conflict to
  resolve when both branches land, not a tonight problem.

## Data contract (the one source of truth)
- `src/lib/netCarbs.ts` — pure: `netCarbs(input, {fiberMode})`, `bolusableCarbsPerServing(food, {fiberMode})`.
- Serialized food/entry gains: `bolusableCarbsG` (per serving for foods; entry total for log
  entries) and `bolusableLowConfidence` (carbs present but fiber data missing).
- `totalCarbsG` = existing `carbsG` (unchanged, always shown alongside).

## How to run / verify
- Dev server: `pnpm dev` (SvelteKit). Tests: `pnpm test` / Playwright `pnpm test:e2e` (TBC).
- Self-check libs convention: `*.selfcheck.ts` / `*.check.ts` in `src/lib`.

## Resume pointer
If context is thin: re-read the task brief + this log. Continue from the first unchecked box.
Exploration findings will be appended below as they land.
