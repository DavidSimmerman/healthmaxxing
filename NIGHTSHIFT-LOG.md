# 🌙 Nightshift log — deep review + fixes (2026-07-09 overnight) — ✅ DONE

Branch: **`feat/deep-review`** (worktree `.claude/worktrees/deep-review`). **NOT pushed**
(Auto Deploy is on; merging + pushing main deploys — your call in the morning).
Full fix report + feature ideas are in the chat message; this file is the on-disk summary.

## What happened

7 read-only review agents swept the codebase (db, domain logic, integrations,
auth/security, API correctness, UI, sidecar/deploy) → findings triaged → fixed in
batches by 4 parallel implementation agents + me → verified centrally → codex-reviewed
(2 rounds, 3 findings, all fixed).

## The 10 commits (oldest first)

- `f3cf122` chore: prettier across repo; ignore ios/ + keycloak/
- `942c993` fix: food input hardening, deficit window off-by-one, O(n·m) hot loops, day-page 404s
- `6120c27` fix: migration advisory lock, oauth code purge, categories search, pinned dev PG
- `20d210b` fix: sidecar abort+restart, non-root image, MCP read-only token scope, deploy hygiene
- `d100630` fix: capture-sheet state wipes, chat reveal truncation, double-tap logging, sheet a11y
- `cf3b217` fix: route validation via shared lib, uuid guards, ingest dedupe, parallel loaders
- `22266de` fix: integration resilience — token rotation guard, loud failures, timeouts, encrypted tokens
- `23826b6` test: repair two e2e suites (broken on main: renamed label + fresh-DB semantics)
- `c1d8120` fix: codex-review round — garbage amount 400s, quick actions surface failures

## Verification evidence (all on the final tree)

- `pnpm check` 0 errors · `pnpm lint` green · `vitest` ✓ · `pnpm build` ✓
- 10/10 standalone selfchecks ✓ · agent `npm run check` ✓
- Playwright e2e **7/7** (keycloak-login excluded — needs the compose Keycloak, not running here)
- Live pokes vs preview: negative/NaN/string macros→400, servings 0→400, string amount→400,
  bogus uuid→404, past scheduleAt→400, /api/today 200, valid paths unchanged
- Docker image builds (Coolify-style build args) and **boots as `node`**, migrations apply,
  /api/health 200; failed-DB boot exits the container (healthcheck gate works)
- codex review: round 1 → 2 P2s (fixed + live-verified), round 2 → 1 P3 (fixed); clean logic after

## Morning checklist

1. Skim the branch: `git -C .claude/worktrees/deep-review log --oneline main..HEAD`
2. Merge when happy: `git merge feat/deep-review` on main, push → Coolify deploys.
3. **New optional env on Coolify (app resource):** `MCP_SERVICE_TOKEN_RO` + `MCP_TOKEN_RO`
   (read-only MCP scope for chat — falls back to the existing tokens until set, nothing breaks).
4. Nothing else changes operationally. Fitbit/Dexcom tokens encrypt themselves on next rotation.

## Deliberately NOT done (calibrated, revisit when it matters)

- daily_log stored local-date column + index (real seq scans, but ~5k rows/yr and APP_TZ
  is env-driven → backfill/trigger carries rolling-deploy corruption risk; not worth it yet)
- tz-day SQL helper consolidation (12 hand-copies across 7 files — clean refactor for a
  calm daytime session, not a 3am one); pg_trgm name index / barcode canonical column;
  foods/history rollup; oauth_tokens purge; svelte.config csrf deprecation migration;
  goals.ts streak-loop refactor. Details + reasoning in the chat report.
