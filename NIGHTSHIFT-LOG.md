# 🌙 Nightshift log — AI chat feature

Branch: `feat/ai-chat` (worktree `.claude/worktrees/ai-chat`). NOT pushed (Auto Deploy is on;
leaving for morning review/merge).

## Task
Turn the AI food feature into a **full streaming chat**:
- Talk to it, assistant text **streamed** back.
- Multi-turn conversation with context ("going to Costco, what fits my macros today?").
- Send **barcode/label photos** mid-conversation; it reads + sums them (e.g. a recipe).
- On the user's **green light**, it **tracks food / adds a recipe / schedules for later**.
- Every action shows a **confirmation card in the UI with the final macros** before it commits.

Plus standing rule captured: **all Coolify config must be zero-downtime** (see MEMORY.md + DEPLOY.md).

## Design decisions (autonomous)
- **Streaming = SSE** over `fetch` POST (need POST for history+images; EventSource can't POST).
- **Conversation state lives in the client** (browser holds message history, sends each turn).
  No DB table for chats — YAGNI for v1. Revisit if persistence is wanted.
- **Green-light gate is structural, not trust-based:** the chat sidecar gets **read-only**
  MCP tools (get_nutrition, get_day_log, list_foods, lookup_barcode, lookup_fdc) + a custom
  **`propose_action`** tool. It has **NO write tools**, so it *cannot* mutate anything itself.
  When it calls `propose_action`, the sidecar emits an SSE `action_proposed` event; the UI
  renders a confirmation card (final macros) with Confirm/Cancel. Only on Confirm does the
  **app** execute the write via existing `createAndLogFood`/`prepFood` (track/recipe/schedule).
- **Sidecar reached via its Coolify proxy domain + AGENT_SECRET bearer** (zero-downtime; no
  custom container name / host port map). `/health` is the only unauthenticated route.

## Status
- [x] Workspace + memory rule + log
- [x] Research: Agent SDK streaming (partial messages, custom tool, multi-turn via `resume`)
- [x] Explore: app internals for track/recipe/schedule shapes + entry point
- [x] Sidecar `POST /chat` — SSE stream (session/delta/action/done/error), read tools + propose_action
- [x] App `POST /api/chat` — SSE proxy (session-gated, forwards client abort)
- [x] App `POST /api/chat/confirm` — execute confirmed proposal, return authoritative macros
- [x] Chat UI (`ChatSheet.svelte`) + streaming + image attach + confirmation cards + floating launcher
- [x] Verify: typecheck (0 err) + build ✓ + Playwright against mock sidecar + REAL Postgres write ✓
- [x] Update DEPLOY.md / agent README for zero-downtime + /chat env
- [x] codex review + addressed all 4 findings (re-verified); final re-review running

## Codex findings — all addressed
- P1 (commit ≠ card): confirm now logs the **displayed** proposal macros as 1 serving. Proved with
  a divergent-payload test (payload said BOGUS/999cal/servings:2 → logged row was 150/5/27/3, srv=1).
- P1 (servings double-count): same fix — servings forced to 1, macros are the shown totals.
- P2 (stale dashboard): `invalidateAll()` after track/schedule + `/api/chat/confirm` added to the
  iOS widget reload hook.
- P2 (zod peer): bumped agent `zod` to ^4 (SDK peer-deps zod@^4); tool constructs verified.

## Codex round 2 — all addressed + verified (400s/200 via curl)
- schedule w/o `scheduleAt` → 400 (was: silently logged now).
- negative macros → 400; recipe requires ingredients + `makesServings > 0`.
- recipe card previews per-serving macros (ingredients ÷ makesServings) = what's saved.
- sidecar aborts the Claude run on SSE client disconnect (AbortController on `res` close).

## Codex round 3 — all addressed + verified
- Proposals carry a `nutrients` bag (fiber etc.); confirm → prepFood's sanitizeNutrients keeps
  net-carb/bolus accuracy. Verified: fiberG 6 → bolusable 21 of 27 carbs; food row stores it.
- scheduleAt validated (exported `parseScheduleAt`) BEFORE any write → invalid/past = 400 with
  ZERO orphan food rows (verified).
- Schedule cards show the resolved time so a wrong offset is catchable before confirm.
- Removed a duplicate nutrient sanitizer — reuse the app's canonical `sanitizeNutrients`.

Total: 3 review rounds, 9 findings (2 P1 + 7 P2) all fixed + verified. A final round is running.

## Deploy status (for morning)
- Chat is on `feat/ai-chat`, NOT pushed/merged. The live app is still the describe/report build
  the user was mid-deploying. Morning path: (1) finish sidecar Coolify setup using the NEW
  zero-downtime approach (give sidecar a **domain**, set app `AGENT_URL` to it — no custom
  container name); (2) merge `feat/ai-chat` → main to ship chat too; (3) set `BODY_SIZE_LIMIT=10M`
  on the app for photo uploads.
- The sidecar↔Claude live path needs the real `CLAUDE_CODE_OAUTH_TOKEN` on Coolify to exercise;
  everything app-side is verified here against a mock sidecar + real Postgres.

## Verification evidence
- Playwright drove: open chat → send → streaming assistant text → `Track now` card → Confirm →
  `✓ Logged` + authoritative macros. Screenshots in `/tmp/hm-verify/*.png` (ephemeral).
- Real DB writes confirmed via psql: track (pending=f), schedule (pending=t), recipe (per-serving
  = sum/makesServings = 125/6.5/19.5/2.5). Bad kind → 400.
- Ran against a mock sidecar (`/tmp/hm-verify/mock-agent.mjs`) emitting the real SSE protocol —
  no Claude token needed. The sidecar↔Claude path is verified by construction/boot only (needs the
  Max token on Coolify to exercise live).
- **Streaming is incremental** (not buffered): `curl -N` through the app proxy showed
  `event: session` then `delta` events arriving at ~40ms spacing (matching the mock cadence).
  Confirms adapter-node passes the SSE ReadableStream straight through token-by-token.

## How to run / verify
- App dev: `pnpm dev` (needs Postgres: `pnpm db:start` via docker, then `pnpm db:push`).
- Sidecar local: `cd agent && AGENT_SECRET=x CLAUDE_CODE_OAUTH_TOKEN=x node server.mjs`.
- Sidecar self-check: `cd agent && npm run check`.
- Playwright: mock the sidecar with a tiny local SSE stub so the chat UI + confirm flow can be
  driven without a real Claude token.

## Resume pointer
If compacted: re-read this file + the Task above. Continue at the first unchecked box.
Core novel piece is the sidecar `/chat` SSE + `propose_action`; everything else reuses
existing food logic. Don't restart — the food describe/report feature already shipped on `main`.
