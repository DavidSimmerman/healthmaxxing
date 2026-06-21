# Keycloak — single IdP for the dashboard + the Claude.ai MCP connector

When `KEYCLOAK_ISSUER` is set, the app delegates **all** authentication to
Keycloak:

- **Dashboard login** — `/login` runs an OIDC authorization-code + PKCE flow
  against the `health` realm; `/auth/callback` exchanges the code and mints the
  app's own signed session cookie (`hd_session`); `/logout` does RP-initiated
  logout.
- **Claude.ai MCP connector** — `/.well-known/oauth-protected-resource` points
  Claude at the Keycloak realm. Claude self-registers (RFC 7591 dynamic client
  registration, allowed by the realm's **Trusted Hosts** policy), runs its own
  auth-code/PKCE flow against Keycloak, and presents the resulting JWT to
  `/mcp`, which validates it against Keycloak's JWKS (issuer + `aud=<origin>/mcp`).

When `KEYCLOAK_ISSUER` is **unset**, the app falls back to the legacy homegrown
password/AS flow. The two paths are mutually exclusive and chosen at runtime.

---

## Local development

```bash
docker compose up -d            # starts postgres, keycloak-db, keycloak
```

Keycloak boots on <http://localhost:8080> (admin `admin` / `admin`) and
auto-imports `keycloak/health-realm.json` on a **fresh** volume. That realm
ships with:

| Thing             | Value                                                        |
| ----------------- | ------------------------------------------------------------ |
| Realm             | `health`                                                     |
| Web client        | `health-dashboard-web` (confidential, PKCE)                  |
| Web client secret | `dev-web-secret-change-me`                                   |
| Redirect URIs     | `http://localhost:5173/auth/callback`, `…5174…`              |
| MCP audience      | `http://localhost:5173/mcp`                                  |
| Dev user          | `david` / `dev-password`                                     |
| Anonymous DCR     | Trusted Hosts policy → `claude.ai`, `localhost`, `127.0.0.1` |

Set the matching app env (already in `.env.example`):

```dotenv
KEYCLOAK_ISSUER="http://localhost:8080/realms/health"
KEYCLOAK_CLIENT_ID="health-dashboard-web"
KEYCLOAK_CLIENT_SECRET="dev-web-secret-change-me"
SESSION_SECRET="<any long random string>"
```

Then `pnpm dev` and visit any page → you're bounced to the Keycloak login form,
and back to the dashboard after signing in.

> **Re-importing:** the realm imports only when the realm doesn't already exist
> (`IGNORE_EXISTING`). To pick up edits to `health-realm.json`, wipe and reboot:
> `docker compose rm -sf keycloak keycloak-db && docker volume rm health-dashboard_kcdata && docker compose up -d`.
> To change config on a running instance instead, use the admin console or
> re-run `keycloak/setup-realm.sh` (see below).

### Reconfiguring without a wipe

`keycloak/setup-realm.sh` is an idempotent bootstrap that creates the realm,
client, `mcp` scope + audience mapper, Trusted Hosts policy, and dev user via
`kcadm`. It's parameterized by env vars, so it doubles as the production setup:

```bash
docker compose exec -T keycloak /opt/keycloak/data/import/setup-realm.sh
```

---

## Production (Coolify)

### 1. Run Keycloak (optimized, behind the Coolify proxy)

Deploy `quay.io/keycloak/keycloak:26.3` with command `start --optimized` and:

```dotenv
KC_DB=postgres
KC_DB_URL=jdbc:postgresql://<pg-host>:5432/keycloak
KC_DB_USERNAME=keycloak
KC_DB_PASSWORD=<strong>
KC_HOSTNAME=https://auth.example.com     # public Keycloak URL
KC_HTTP_ENABLED=true                     # TLS terminates at Coolify's proxy
KC_PROXY_HEADERS=xforwarded              # trust X-Forwarded-* from the proxy
KC_BOOTSTRAP_ADMIN_USERNAME=admin
KC_BOOTSTRAP_ADMIN_PASSWORD=<strong>
```

Point Coolify's reverse proxy at container port 8080.

### 2. Create the realm for the production origin

Do **not** import the dev `health-realm.json` as-is — its redirect URIs and MCP
audience are `localhost`. Instead run the setup script against the running
container with production values:

```bash
APP_ORIGIN=https://health.example.com \
WEB_CLIENT_SECRET=<strong-random> \
KC_SERVER=https://auth.example.com \
ADMIN_USER=admin ADMIN_PASS=<strong> \
  bash setup-realm.sh
```

This registers `https://health.example.com/auth/callback`, sets the MCP audience
to `https://health.example.com/mcp`, and keeps `claude.ai` in Trusted Hosts.
Create your real user(s) in the admin console (or via the script's `DEV_USER`).

### 3. App env (Coolify, the SvelteKit service)

```dotenv
ORIGIN=https://health.example.com
KEYCLOAK_ISSUER=https://auth.example.com/realms/health
KEYCLOAK_CLIENT_ID=health-dashboard-web
KEYCLOAK_CLIENT_SECRET=<the strong secret from step 2>
SESSION_SECRET=<long random string>
```

`openid-client` enforces HTTPS in production automatically (HTTP is only allowed
for `http://localhost` issuers in dev).

### 4. Connect Claude.ai

In Claude's connector settings add the MCP server URL
`https://health.example.com/mcp`. Claude will:

1. hit `/mcp`, get a `401` whose `WWW-Authenticate` points at
   `/.well-known/oauth-protected-resource`;
2. read that doc → `authorization_servers: ["https://auth.example.com/realms/health"]`;
3. discover Keycloak's metadata and **dynamically register** (allowed because
   `claude.ai` is a trusted host);
4. run auth-code/PKCE — you log in at Keycloak;
5. receive a JWT with `aud=https://health.example.com/mcp` and the `mcp` scope,
   which `/mcp` validates against Keycloak's JWKS.

---

## Gotchas / checklist

- **MCP audience must equal `<ORIGIN>/mcp` exactly.** If the realm's `mcp` scope
  audience mapper doesn't match the app's public origin, `/mcp` rejects every
  Claude token (`aud` mismatch). The setup script derives it from `APP_ORIGIN`.
- **Trusted Hosts must include `claude.ai`**, or anonymous dynamic client
  registration is rejected (fail-closed default) and Claude can't connect.
- **`mcp` is a realm _default_ client scope**, so dynamically-registered clients
  inherit the audience without Claude asking for it explicitly.
- **Rotating `SESSION_SECRET`** invalidates all existing dashboard sessions
  (expected). Rotating the Keycloak client secret breaks login until the app env
  is updated to match.
- The legacy `MCP_AUTH_PASSWORD` is ignored while `KEYCLOAK_ISSUER` is set.
