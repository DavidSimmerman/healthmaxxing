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
- [x] UI: multi-item "log another" flow + final confirm (CaptureSheet) — stage items, review
      screen with running bolus total, "+ Log another" + "Log N items to today" commit. Banner
      in browse mode to return to review. `pnpm check` 0 errors.
- [x] UI: show Total + Bolusable carbs when adding (capture detail + review) and in history
      (today list + day view totals/per-entry); lowConfidence ⚠︎ surfaced everywhere.
- [x] UI: settings fiber-mode toggle (Subtract all fiber / Half over 5g) + clinical note.
- [~] EditEntrySheet: deliberately NOT showing bolusable (it edits a portion; would need
      client-side fiberMode plumbing). The list/day/capture surfaces cover it.
- [ ] Seed local DB + Playwright drive the flow (capture sheet empty on fresh DB)
- [x] Audited LIVE data (read-only, via MCP). 61 catalog foods + 122 logged entries (2 wks,
      106 with fiber). All 8 recipes store TOTAL carbs (stored/serv == ingredient-sum/serv).
      No hand-logged high-carb food has suspiciously low carbsG. **One anomaly to review (not
      auto-fixed — it's medical/dosing data):** the *Chocolate PB Ninja Creami* recipe has
      per-serving fiber 5.2g > total carbs 4.5g, which is impossible if carbsG is true total —
      likely an ingredient (fiber syrup / allulose) whose carbs were entered net while fiber is
      also recorded. Impact is tiny (a ~0-carb dessert; the per-ingredient max(0,…) clamp makes
      bolusable ≈ 0, never negative), but David should eyeball that recipe's ingredients. The
      other two Creami recipes (Vanilla 4.5, Butterscotch 9.0) are fine.
- [x] Verify: unit checks GREEN (`npx tsx src/lib/netCarbs.check.ts`), `pnpm check` 0 errors,
      Playwright drove the full multi-log flow + screenshots (/tmp/hm-shots), live API math
      confirmed in both fiber modes.
- [x] Adversarial review: **codex was QUOTA-BLOCKED** tonight (OpenAI usage limit, resets ~7:17am
      — re-run `codex review --base feat/mcp-back-correct` later). Substituted an independent
      review subagent that ran the checks + svelte-check and found ONE substantive issue:
      recipe + half_over_5 made the pre-log preview (ingredient-level) and the logged history
      (flat) diverge, in the less-safe direction. **FIXED**: `bolusableForLoggedEntry` is now
      recipe-aware (ingredient-level × servings, capped at snapshot total) — preview and history
      now agree (verified live: both read 33 under half_over_5 for the test burrito). Other note:
      a network-throw double-log window in /api/log is PRE-EXISTING (same as the old single-item
      path), not a regression; safe fix would be a client idempotency token (out of scope).
- [x] Final commit + wake-up message — DONE. 4 commits on `feat/bolusable-carbs`.

## ✅ FINAL STATUS — COMPLETE
Both asks shipped: (1) multi-item "log another" meal flow with a running bolus total + one
final confirm; (2) total AND bolusable carbs shown when adding (capture detail + meal review)
and in history (today list + day view, per-entry and daily totals), plus the MCP tool replies.
Derivation lives in one place (`src/lib/netCarbs.ts`), configurable fiber mode (default 'full'),
sugar-alcohol at conservative 0.5×, low-confidence flag when fiber data is missing, recipes
rolled up at the ingredient level. Total carbs always stay visible; uncertainty errs toward
HIGHER carbs.

### To run locally
`cd ~/dev/healthmaxxing` → `pnpm dev` (needs local Postgres `healthdash`, which is seeded).
The app normally requires login; I ran the dev server with `MCP_AUTH_PASSWORD='' KEYCLOAK_ISSUER=''`
only for headless testing (now stopped). Screenshots of the flow: `/tmp/hm-shots/*.png`.
Tests: `npx tsx src/lib/netCarbs.check.ts` and `pnpm check` (0 errors).

### Two things for David to glance at
1. **Stash** `stash@{0}` holds the unrelated Fitbit/Google-Health WIP — restore with
   `git switch feat/mcp-back-correct && git stash pop`.
2. **Data**: the *Chocolate PB Ninja Creami* recipe has per-serving fiber (5.2g) > total carbs
   (4.5g), which shouldn't happen if carbs is the true total — likely an ingredient whose carbs
   were entered net. Impact is tiny (≈0-carb dessert; bolusable clamps to ≥0), but worth a look.
   Everything else in the live data checks out (carbsG = total).

### Deploy note
The MCP server (live Health Dashboard) still runs the OLD code — these changes are committed on
the branch, NOT deployed/pushed (nightshift doesn't push). Merge + deploy when ready. The migration
0012 (settings.fiberMode) needs to run on deploy; it conflicts in number with the stashed Fitbit
0012 — resolve when both land.

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
