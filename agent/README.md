# Claude sandbox (agent sidecar)

A locked-down container that runs Claude Code on **your Max subscription** (no API
billing) so the app can describe food, read nutrition labels, write reports, and power
the in-app AI chat — without you opening a Claude chat. Every request is Bearer-gated
with `AGENT_SECRET`; only `/health` is open.

```
[healthmaxxing app] --POST /describe|/report|/chat--> [this sidecar]
      |                                                    |  CLAUDE_CODE_OAUTH_TOKEN (your Max plan)
      |                                                    |  internet + WebSearch/WebFetch (reports)
      └──────────── /mcp (Bearer MCP_SERVICE_TOKEN) ◄──────┘  reads (chat) / reads+writes (reports)
```

Endpoints, all Bearer-auth'd with `AGENT_SECRET`:

- `POST /describe` `{image?, mediaType?, text?}` → per-serving food JSON. **Vision
  only — no tools, no MCP, no internet.**
- `POST /report` `{period?, from?, to?, instruction?}` → Claude reads your data via
  `/mcp`, analyzes it, and calls `save_report`. Web search/fetch allowed.
- `POST /chat` `{message?, images?, sessionId?}` → **SSE stream** of a chat turn
  (`event: session|delta|action|error|done`). Read-only `/mcp` tools + a `propose_action`
  tool — **no write tools**, so the model can only _propose_; the app commits on confirm.
  Multi-turn via the returned `sessionId` (session `resume`).

Everything Claude Code ships that isn't on the allowlist (Bash, Write, file edits, …)
is **denied** by a `canUseTool` gate — the container plus that allowlist is the sandbox.

## One-time setup (only you can do these)

1. **Mint a subscription token** on any machine signed into your Max plan:

   ```
   claude setup-token
   ```

   Copy the printed token → the sidecar's `CLAUDE_CODE_OAUTH_TOKEN`. Re-run if it ever
   expires or is revoked. (This spends your personal Max rate limit; keep it single-user.)

2. **Pick a service token** for the sidecar → `/mcp` calls. Generate a strong random
   string (e.g. `openssl rand -hex 32`) and set it as **both**:
   - app env `MCP_SERVICE_TOKEN`
   - sidecar env `MCP_TOKEN`

3. **Pick an agent secret** the same way and set it as **both** the app's `AGENT_SECRET`
   and the sidecar's `AGENT_SECRET`.

## Deploy on Coolify (bundled in the app container)

The sidecar runs as a **second process inside the app's own container** — the root
`Dockerfile` copies `agent/`, `npm ci`s its deps, and `scripts/start.sh` launches it on
`127.0.0.1:8787` alongside the app. So there is **no separate Coolify resource, no domain,
and no cross-service networking**, and it inherits the app's zero-downtime rolling deploy.
Nothing here is reachable from outside the container.

Everything is configured with **env vars on the app resource**:

| Variable                  | Required     | Notes                                                             |
| ------------------------- | ------------ | ----------------------------------------------------------------- |
| `AGENT_URL`               | ✅           | `http://127.0.0.1:8787` — the in-container sidecar.               |
| `AGENT_SECRET`            | ✅           | Any strong random string; app + sidecar share the container env.  |
| `CLAUDE_CODE_OAUTH_TOKEN` | ✅           | From `claude setup-token`. Your Max subscription — no API cost.   |
| `MCP_SERVICE_TOKEN`       | reports/chat | Static bearer for `/mcp` (see `DEPLOY.md`).                       |
| `MCP_TOKEN`               | reports/chat | Same value as `MCP_SERVICE_TOKEN` (the sidecar reads this name).  |
| `APP_MCP_URL`             | reports/chat | `http://127.0.0.1:3000/mcp` — the app's own MCP over loopback.    |
| `BODY_SIZE_LIMIT`         | for photos   | e.g. `10M` — adapter-node default 512KB; photo uploads exceed it. |

If `AGENT_URL` is unset the AI features are simply off (the ✨ chat + buttons return a clear
"not configured" error).

## Local check

```
npm install
npm run check     # parseFood validation self-check
```

`/describe` and `/report` need a real `CLAUDE_CODE_OAUTH_TOKEN` to exercise end-to-end.
