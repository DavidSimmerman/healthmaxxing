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
- [ ] Research: Agent SDK streaming (partial messages, custom tool, multi-turn input)
- [ ] Explore: app internals for track/recipe/schedule shapes + entry point
- [ ] Sidecar `POST /chat` — SSE stream (text deltas + action_proposed), read tools + propose_action
- [ ] App `POST /api/chat` — SSE proxy (session-gated), passes history+images
- [ ] App `POST /api/chat/confirm` — execute confirmed proposal, return final macros
- [ ] Chat UI route + streaming + image attach + confirmation cards
- [ ] Verify: typecheck, build, unit self-checks, Playwright (mock sidecar SSE), codex review
- [ ] Update DEPLOY.md / agent README for zero-downtime + /chat env

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
