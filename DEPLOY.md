# Deploying to Coolify

The app ships as a Docker image (`@sveltejs/adapter-node`). Migrations run
automatically on container start.

## 1. Create the resources

- **Postgres** — provision one in Coolify (or point at an existing instance).
- **Application** — "Dockerfile" build pack, pointed at this repo. Coolify builds
  the included `Dockerfile`. The server listens on **port 3000**.

## 2. Environment variables

| Variable            | Required         | Notes                                                                                                                                                                                                                                                            |
| ------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`      | ✅               | The Coolify Postgres connection string.                                                                                                                                                                                                                          |
| `MCP_AUTH_PASSWORD` | ✅               | Password the `/authorize` consent screen requires before issuing an MCP token. Pick something strong — anyone with it can connect Claude to your data. Unset = `/authorize` refuses to mint tokens.                                                              |
| `ORIGIN`            | ✅               | Public URL, e.g. `https://health.example.com`. adapter-node needs it behind the proxy for form actions, CSRF, and the OAuth metadata documents.                                                                                                                  |
| `API_TOKEN`         |                  | Bearer token for the `/api/*` endpoints used by the desktop `/log-food` slash command. Leave unset to disable that auth (not recommended in prod).                                                                                                               |
| `APP_TZ`            |                  | IANA timezone whose calendar day defines "today" for the dashboard and `/api/today`. Defaults to `America/New_York`. Set to your timezone so the day doesn't roll over at midnight UTC.                                                                          |
| `AGENT_URL`         |                  | URL of the Claude sandbox sidecar (its Coolify proxy domain, e.g. `https://agent.example.com` — see zero-downtime note below). Unset = the in-app ✨ describe/scan, report-generate, and **AI chat** features are off. See [`agent/README.md`](agent/README.md). |
| `AGENT_SECRET`      | with AGENT_URL   | Shared bearer the app uses to call the sidecar. Must match the sidecar's `AGENT_SECRET`.                                                                                                                                                                         |
| `MCP_SERVICE_TOKEN` | for reports/chat | Strong static bearer that lets the trusted sidecar call `/mcp` without the interactive OAuth flow. Must match the sidecar's `MCP_TOKEN`. Reports and chat's read tools need it. Unset = only OAuth tokens are accepted.                                          |
| `BODY_SIZE_LIMIT`   | for photos       | adapter-node's max request body (default **512KB**). Food-scan / chat photo uploads exceed that, so set e.g. `10M`. Without it, image uploads fail (the origin resets the connection → a 502 at the proxy).                                                      |

The Claude sandbox is a **separate Coolify application** — see [`agent/README.md`](agent/README.md)
for its setup (subscription token, deploy, env).

## 3. Healthcheck

Point Coolify's healthcheck at `GET /api/health` (returns 200 when the app and
its DB are up, 503 otherwise). A working healthcheck is also what lets Coolify do
**rolling (zero-downtime) deploys** — see below.

## 3a. Zero-downtime deploys (do this for every service)

Coolify does a rolling update by default (start new container → wait for its
healthcheck → swap → remove old). Two settings **disable** that and force a
"remove old, then start new" window of downtime on every redeploy — avoid both:

- **No host Port Mappings.** Let the Coolify proxy route to the container; don't
  map a host port. (`Ports Exposes` is fine — that's the container's own port.)
- **No Custom Container Name** (Advanced → Container Names). It also disables
  rolling updates.

So for **service-to-service** calls (the app → the sidecar), don't reach the
sidecar by a custom container name. Instead give the sidecar its **own Coolify
domain** (General → Generate Domain) and point `AGENT_URL` at that `https://…`
URL. The `AGENT_SECRET` bearer gates every sidecar request (only `/health` is
open), so a proxy-exposed sidecar is safe, and both services keep zero-downtime
rolling deploys.

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
