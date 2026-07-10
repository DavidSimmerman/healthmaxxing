# 🌙 Nightshift log — assistant reports + features (2026-07-10) — ✅ DONE

Branch: **`feat/assistant-reports`** (worktree `.claude/worktrees/deep-review`), stacked on
**`feat/deep-review`** (night 1). **Neither is pushed/merged** — Auto Deploy is armed.
Merging `feat/assistant-reports` brings both nights' work.

## What shipped tonight

1. **Scheduled AI report chats** (daily / weekly / monthly) — real chat rows you can reply to.
2. **Chat memory bug FIXED** + cross-conversation awareness.
3. **Chat has internet** + a verify-then-double-check macro policy.
4. Feature ideas 1, 2, 4, 5, 6 from last night's report.
5. 🔴 **Found + fixed a silent production bug: the assistant could never read your data.**

## The big find (commit 7ade25c)

Driving the real sidecar against a real Claude token, the model said _"the health MCP tools
aren't available to me in this session."_ The MCP handshake was perfect (initialize 200,
`tools/list` returned all 19 tools) — the CLI just never showed them to the model.

**Cause:** tools from an **external http MCP server are deferred behind the built-in
`ToolSearch` meta-tool.** Restricting `options.tools` drops ToolSearch → every
`mcp__health__*` tool is invisible. **In-process SDK MCP servers (our `proposer`) are NOT
deferred** — which is exactly why this hid: chat could still _propose_ food, it just
couldn't _read_ anything. The shipped `/chat` (`tools: []`) has never been able to read the
dashboard. `/report` was fine (it never restricted `tools`).

Fixed for `/chat` + `/insight`, and added to `REPORT_TOOLS` so a future SDK that gates
ToolSearch through `canUseTool` can't regress `/report` the same way. Saved to memory
(`agent-sdk-toolsearch-gotcha.md`). Proven by 4-way probe: `tools:[]` and
`tools:['WebSearch','WebFetch']` FAIL; `tools` omitted and `tools:[…,'ToolSearch']` PASS.

## Commits (oldest first)

- `ead76c2` schema: chats.kind/unread/dateLabel + partial unique idempotency index,
  settings report prompts, sync_status table (migration 0023)
- `ddd1215` chat history replay + web tools + macro-accuracy policy + `/insight`
- `a926e1c` report engine + in-app scheduler + `/api/reports/run` + settings PUT
- `b99796b` MCP read tools: list_chats, get_chat, get_goal_report; documented GMI/TIR
- `dba9616` allulose end-to-end, Atwater `macroCheck`, glucose-control trends card, sync_status writes
- `c02ed01` assistant UI: unread dots/chips, nav badge, editable schedule time, health card, prompt editors
- `5ba72bb` two real eslint errors (earlier runs never reached eslint — prettier short-circuited)
- `7ade25c` **the ToolSearch fix** (see above)
- `31e6f4b` codex review: Settings→Notes now reach reports; reading a chat no longer reorders the list

## How the pieces work

- **A report is a chat row** (`kind='daily'|'weekly'|'monthly'`). Replying uses the normal
  chat path, so the assistant answers with the report in context.
- **Idempotency:** the generator _claims_ `(kind, dateLabel)` via a partial unique index
  before spending a token. Two containers → one report. Crashed claims swept after 15 min.
- **Wake detection:** daily fires when today's sleep row lands (Fitbit polled ≤1×/20 min
  from 05:00), with a **noon fallback** so a day is never skipped. Weekly Sun ≥04:00,
  monthly 1st ≥04:00, all APP_TZ.
- **Memory fix:** `/api/chat` ships the persisted transcript as `history`; the sidecar
  resumes its SDK session _only if the session file actually exists on disk_, else replays
  history. Reopened chats and redeploys now genuinely remember.
- **Prompts:** three editable textareas in Settings (blank = built-in default). Reports also
  receive your Settings→Notes and your last 2 same-kind reports **plus your replies**, with
  an explicit "don't repeat yourself, follow up on what they said" instruction.

## Verified (evidence, not vibes)

- `pnpm check` 0 errors · `pnpm lint` 0 errors · vitest ✓ · build ✓ · 10/10 selfchecks ✓ ·
  netCarbs check ✓ (new allulose wrapper cases) · agent syntax ✓ · **e2e 7/7**
- **Live, real Claude token:** daily report generated in ~20s, **data-grounded** (cites goal
  grade/scores; flags the CGM gap as the T1D-critical issue) — previously it said "I can't
  see your data".
- **Memory proof:** reply with `chatId` recalls the report's top-priority action;
  **control** — same question without `chatId` → correctly no memory.
- **The scheduler generated a report by itself** (`[scheduler] daily report: created`,
  noon-fallback rule) while two app instances ran — exactly one row: idempotency held under
  real concurrency.
- API: bad kind → 400, second run → `exists`, PATCH `{unread:false}` → 200, `{unread:true}` → 400,
  unknown id → 404, identical re-save leaves `updatedAt` untouched, new message bumps it.
- Playwright (390×844): nav badge "1", Daily chip, unread dot, report opens as a replyable
  chat bubble, settings prompt editors render with defaults as placeholders, 0 page errors.
- codex review: 2 P2 findings, both fixed + re-verified live.

## Morning checklist

1. Merge `feat/assistant-reports` → main (contains night 1), push → Coolify deploys.
2. **The ToolSearch fix is the one to care about** — after deploy, ask the chat "what did I
   eat yesterday?" It should actually answer now.
3. Optional envs (already fall back safely): `MCP_SERVICE_TOKEN_RO` + `MCP_TOKEN_RO`.
4. Reports need `AGENT_URL`/`AGENT_SECRET`/`CLAUDE_CODE_OAUTH_TOKEN`/`APP_MCP_URL`/`MCP_TOKEN`
   set (they already are, for chat/describe). The scheduler starts itself at boot.
5. First daily report will appear the morning after deploy (wake-detected, or noon fallback).

## Decisions worth a glance

- Reports live in `chats`, not the old `reports` table — that table + `/reports/[id]` markdown
  view are untouched (`save_report` still works from `/report`).
- Report text is plain conversational text, no markdown renderer in the chat bubble.
- Scheduler is in-process (`setInterval`, `!building`-guarded) rather than a new cron
  dependency — the existing host cron only hits sync routes.
- `wait: false` on `generateReportChat` is implemented but unused; `/api/reports/run` returns
  202 fire-and-forget by default (Cloudflare's ~100s proxy timeout), `?wait=1` for testing.
