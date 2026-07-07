# Deploying to Coolify

The app ships as a Docker image (`@sveltejs/adapter-node`). Migrations run
automatically on container start.

## 1. Create the resources

- **Postgres** — provision one in Coolify (or point at an existing instance).
- **Application** — "Dockerfile" build pack, pointed at this repo. Coolify builds
  the included `Dockerfile`. The server listens on **port 3000**.

## 2. Environment variables

| Variable            | Required | Notes                                                                                                                                                                                               |
| ------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`      | ✅       | The Coolify Postgres connection string.                                                                                                                                                             |
| `MCP_AUTH_PASSWORD` | ✅       | Password the `/authorize` consent screen requires before issuing an MCP token. Pick something strong — anyone with it can connect Claude to your data. Unset = `/authorize` refuses to mint tokens. |
| `ORIGIN`            | ✅       | Public URL, e.g. `https://health.example.com`. adapter-node needs it behind the proxy for form actions, CSRF, and the OAuth metadata documents.                                                     |
| `API_TOKEN`         |          | Bearer token for the `/api/*` endpoints used by the desktop `/log-food` slash command. Leave unset to disable that auth (not recommended in prod).                                                  |
| `APP_TZ`            |          | IANA timezone whose calendar day defines "today" for the dashboard and `/api/today`. Defaults to `America/New_York`. Set to your timezone so the day doesn't roll over at midnight UTC.             |
| `AGENT_URL`         |          | Internal URL of the Claude sandbox sidecar, e.g. `http://<sidecar-service>:8787`. Unset = the in-app ✨ describe/scan and report-generate features are off. See [`agent/README.md`](agent/README.md).  |
| `AGENT_SECRET`      | with AGENT_URL | Shared bearer the app uses to call the sidecar. Must match the sidecar's `AGENT_SECRET`.                                                                                                     |
| `MCP_SERVICE_TOKEN` |          | Strong static bearer that lets the trusted sidecar call `/mcp` without the interactive OAuth flow. Must match the sidecar's `MCP_TOKEN`. Unset = only OAuth tokens are accepted (feature-neutral).   |

The Claude sandbox is a **separate Coolify application** — see [`agent/README.md`](agent/README.md)
for its setup (subscription token, deploy, env).

## 3. Healthcheck

Point Coolify's healthcheck at `GET /api/health` (returns 200 when the app and
its DB are up, 503 otherwise).

## 4. Migrations

The container runs `node migrate.mjs` before `node build` on every start, so
the schema is brought up to date automatically. No manual step.

## 5. Connect Claude (the MCP connector)

Once deployed and reachable over HTTPS:

1. In the Claude.ai app → **Settings → Connectors → Add custom connector**.
2. URL: `https://health.example.com/mcp`
3. Claude registers itself, then redirects you to the consent screen — enter
   your `MCP_AUTH_PASSWORD` and approve.
4. In any Claude conversation (incl. iOS), enable the connector and say what you
   ate (text, photo, or barcode). It calls the `log_food` tool and writes to
   your dashboard.

## 6. Desktop `/log-food` (optional, unchanged)

The Claude Code slash command still works without the connector. Set:

```bash
export HEALTH_APP_URL="https://health.example.com"
export HEALTH_API_TOKEN="<your API_TOKEN>"
```
