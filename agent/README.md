# Claude sandbox (agent sidecar)

A locked-down container that runs Claude Code on **your Max subscription** (no API
billing) so the app can describe food, read nutrition labels, and write reports
without you opening a Claude chat. The app calls it over the private network; it is
never exposed publicly.

```
[healthmaxxing app] --POST /describe|/report--> [this sidecar]
      |  (public, :3000)                              |  CLAUDE_CODE_OAUTH_TOKEN (your Max plan)
      |                                               |  internet + WebSearch/WebFetch (reports only)
      └──────────── /mcp (Bearer MCP_SERVICE_TOKEN) ◄─┘  reads/writes your data
```

Two endpoints, both Bearer-auth'd with `AGENT_SECRET`:

- `POST /describe` `{image?, mediaType?, text?}` → per-serving food JSON. **Vision
  only — no tools, no MCP, no internet.**
- `POST /report` `{period?, from?, to?, instruction?}` → Claude reads your data via
  `/mcp`, analyzes it, and calls `save_report`. Web search/fetch allowed.

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
- **No public domain** — leave domains empty. It only needs to be reachable from the
  app on the project's internal network (Coolify service hostname, e.g.
  `http://<sidecar-service>:8787`).
- Healthcheck: `GET /health`.
- Env:

| Variable                  | Required | Notes                                                            |
| ------------------------- | -------- | ---------------------------------------------------------------- |
| `CLAUDE_CODE_OAUTH_TOKEN` | ✅       | From `claude setup-token`. Your Max subscription — no API cost.  |
| `AGENT_SECRET`            | ✅       | Shared secret; must match the app's `AGENT_SECRET`.              |
| `APP_MCP_URL`             | reports  | The app's internal MCP URL, e.g. `http://<app-service>:3000/mcp`.|
| `MCP_TOKEN`               | reports  | Must equal the app's `MCP_SERVICE_TOKEN`.                        |
| `PORT`                    |          | Defaults to `8787`.                                              |

Then set on the **app**: `AGENT_URL` = `http://<sidecar-service>:8787`, plus
`AGENT_SECRET` and `MCP_SERVICE_TOKEN` as above. If `AGENT_URL` is unset the feature is
simply off (the ✨ buttons return a clear "not configured" error).

## Local check

```
npm install
npm run check     # parseFood validation self-check
```

`/describe` and `/report` need a real `CLAUDE_CODE_OAUTH_TOKEN` to exercise end-to-end.
