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

## Deploy on Coolify

Add a second **Application** in the same Coolify project as the app:

- Build pack: **Dockerfile**, base directory `/agent`, pointed at this repo.
- **Ports Exposes: `8787`.** Healthcheck: `GET /health` (the image ships `curl` for it).
- **Give it a domain** (General → Generate Domain). The app reaches it at that
  `https://…` URL; `AGENT_SECRET` gates every request, so proxy-exposed is safe.
  Prefer this over an internal container-name hostname: a custom container name would
  disable Coolify's zero-downtime rolling deploys (see `DEPLOY.md` §3a).
- **Don't** set a Custom Container Name or host Port Mappings (both kill rolling updates).
- Env:

| Variable                  | Required     | Notes                                                           |
| ------------------------- | ------------ | --------------------------------------------------------------- |
| `CLAUDE_CODE_OAUTH_TOKEN` | ✅           | From `claude setup-token`. Your Max subscription — no API cost. |
| `AGENT_SECRET`            | ✅           | Shared secret; must match the app's `AGENT_SECRET`.             |
| `APP_MCP_URL`             | reports/chat | The app's MCP URL, e.g. `https://health.example.com/mcp`.       |
| `MCP_TOKEN`               | reports/chat | Must equal the app's `MCP_SERVICE_TOKEN`.                       |
| `PORT`                    |              | Defaults to `8787`.                                             |

Then set on the **app**: `AGENT_URL` = the sidecar's `https://…` domain, plus
`AGENT_SECRET` and `MCP_SERVICE_TOKEN` as above. If `AGENT_URL` is unset the feature is
simply off (the ✨ chat + buttons return a clear "not configured" error).

## Local check

```
npm install
npm run check     # parseFood validation self-check
```

`/describe` and `/report` need a real `CLAUDE_CODE_OAUTH_TOKEN` to exercise end-to-end.
