# Deploying to Coolify

The app ships as a Docker image (`@sveltejs/adapter-node`). Migrations run
automatically on container start; uploads live on a mounted volume.

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
| `BODY_SIZE_LIMIT`   |          | Raise above adapter-node's 512K default so label-photo uploads succeed, e.g. `10M`.                                                                                                                 |
| `UPLOAD_DIR`        |          | Absolute path for uploaded images, e.g. `/data/uploads`. Defaults to `./uploads` (ephemeral). Set this and mount a volume.                                                                          |

## 3. Persistent volume

Mount a volume so uploaded images survive redeploys, then set `UPLOAD_DIR` to
its path:

- Volume mount: `/data`
- `UPLOAD_DIR=/data/uploads`

## 4. Healthcheck

Point Coolify's healthcheck at `GET /api/health` (returns 200 when the app and
its DB are up, 503 otherwise).

## 5. Migrations

The container runs `node migrate.mjs` before `node build` on every start, so
the schema is brought up to date automatically. No manual step.

## 6. Connect Claude (the MCP connector)

Once deployed and reachable over HTTPS:

1. In the Claude.ai app → **Settings → Connectors → Add custom connector**.
2. URL: `https://health.example.com/mcp`
3. Claude registers itself, then redirects you to the consent screen — enter
   your `MCP_AUTH_PASSWORD` and approve.
4. In any Claude conversation (incl. iOS), enable the connector and say what you
   ate (text, photo, or barcode). It calls the `log_food` tool and writes to
   your dashboard.

## 7. Desktop `/log-food` (optional, unchanged)

The Claude Code slash command still works without the connector. Set:

```bash
export HEALTH_APP_URL="https://health.example.com"
export HEALTH_API_TOKEN="<your API_TOKEN>"
```
