# Securing an MCP server with Keycloak on Coolify

A step-by-step guide to putting a remote **MCP server** behind **Keycloak** as the
OAuth 2.0 authorization server, so the Claude.ai connector can authenticate users
before calling your tools. Deployed on **Coolify**.

This is stack-agnostic — your MCP server can be Node, Python, Go, whatever. The
only requirement is that it can serve a couple of JSON endpoints and verify a JWT.

---

## How the pieces fit

Three actors:

1. **Claude.ai** — the MCP _client_. It discovers how to authenticate, registers
   itself, logs the user in, and then calls your MCP server with a Bearer token.
2. **Your MCP server** — the OAuth _resource server_. It does **not** issue
   tokens. It only (a) advertises which authorization server guards it, and
   (b) validates the JWT on each request.
3. **Keycloak** — the OAuth _authorization server_. It handles dynamic client
   registration, the login UI, and token issuance.

The flow when a user connects the MCP server in Claude:

```
Claude → GET /mcp                      → 401 + WWW-Authenticate: resource_metadata=...
Claude → GET /.well-known/oauth-protected-resource (on your server)
                                        → { authorization_servers: [KEYCLOAK_REALM] }
Claude → Keycloak discovery + Dynamic Client Registration (RFC 7591)
Claude → Keycloak login (user authenticates) + auth-code/PKCE
Keycloak → issues JWT  (aud = https://mcp.example.com/mcp, scope = mcp ...)
Claude → POST /mcp  with  Authorization: Bearer <jwt>
Your server → verifies JWT signature (Keycloak JWKS) + issuer + audience → 200
```

The crucial details that make Claude's connector work:

- **Anonymous Dynamic Client Registration** — Claude self-registers, so Keycloak
  must allow anonymous registration from `claude.ai` (a **Trusted Hosts** policy).
- **Audience** — the token's `aud` claim must exactly equal your MCP server's URL,
  achieved with an **Audience protocol mapper** on a client scope.

---

## Part 1 — Deploy Keycloak on Coolify

You need Keycloak + a Postgres database for it.

### 1.1 Postgres

In Coolify, add a **PostgreSQL** resource (or reuse an existing one and create a
`keycloak` database). Note the host, db name, user, password.

### 1.2 Keycloak service

Add a new **Docker Image** resource: `quay.io/keycloak/keycloak:26.3`.

- **Start command:** `start --optimized`
- **Port:** container `8080` (Coolify's proxy terminates TLS in front of it)
- **Domain:** give it a domain, e.g. `https://auth.example.com`
- **Environment variables:**

```dotenv
KC_DB=postgres
KC_DB_URL=jdbc:postgresql://<pg-host>:5432/keycloak
KC_DB_USERNAME=keycloak
KC_DB_PASSWORD=<strong-password>

KC_HOSTNAME=https://auth.example.com   # public Keycloak URL
KC_HTTP_ENABLED=true                   # TLS is terminated by Coolify's proxy
KC_PROXY_HEADERS=xforwarded            # trust X-Forwarded-* from the proxy

KC_BOOTSTRAP_ADMIN_USERNAME=admin
KC_BOOTSTRAP_ADMIN_PASSWORD=<strong-admin-password>
```

Deploy. When it's up, log into the admin console at `https://auth.example.com`
with the bootstrap admin credentials.

> If `start --optimized` complains about a build, either drop `--optimized` (it
> builds on boot, slower) or set `KC_DB=postgres` as a build arg. For most Coolify
> setups, plain `start` is the path of least resistance.

---

## Part 2 — Configure the realm

You can click through the admin console, but the script below is faster and
reproducible. Run it from your laptop (it talks to Keycloak's admin REST API),
or paste the `kcadm` commands into a terminal inside the Keycloak container via
Coolify's exec.

Set these to your values first:

```bash
KC_SERVER=https://auth.example.com
REALM=mcp
ADMIN_USER=admin
ADMIN_PASS=<strong-admin-password>

# Your MCP server's PUBLIC URL and the exact path Claude calls:
MCP_RESOURCE=https://mcp.example.com/mcp
```

### 2.1 The script

Save as `setup-realm.sh` and run inside the Keycloak container
(`/opt/keycloak/bin/kcadm.sh` lives there), or install `kcadm` locally.

```bash
#!/usr/bin/env bash
set -euo pipefail
KC=/opt/keycloak/bin/kcadm.sh

$KC config credentials --server "$KC_SERVER" --realm master \
  --user "$ADMIN_USER" --password "$ADMIN_PASS"

# ── Realm ─────────────────────────────────────────────────────────────────────
$KC create realms -s realm="$REALM" -s enabled=true -s sslRequired=external \
  2>/dev/null || echo "realm exists"

# ── 'mcp' client scope with an Audience mapper ────────────────────────────────
# The Audience mapper stamps every token granted this scope with aud=$MCP_RESOURCE.
SCOPE_ID=$($KC create client-scopes -r "$REALM" \
  -s name=mcp -s protocol=openid-connect \
  -s 'attributes."include.in.token.scope"=true' \
  -s 'attributes."display.on.consent.screen"=true' -i)

$KC create "client-scopes/$SCOPE_ID/protocol-mappers/models" -r "$REALM" \
  -s name=mcp-audience -s protocol=openid-connect \
  -s protocolMapper=oidc-audience-mapper \
  -s 'config."included.custom.audience"='"$MCP_RESOURCE" \
  -s 'config."access.token.claim"=true' \
  -s 'config."id.token.claim"=false'

# Make 'mcp' a realm DEFAULT scope so Claude's dynamically-registered client
# inherits the audience automatically (it won't know to ask for it).
$KC update "realms/$REALM/default-default-client-scopes/$SCOPE_ID" -r "$REALM"

# ── Anonymous Dynamic Client Registration: Trusted Hosts policy ───────────────
# Without this, Keycloak rejects all anonymous registration (fail-closed default)
# and Claude can't connect. claude.ai is the Claude web connector.
REALM_ID=$($KC get "realms/$REALM" --fields id --format csv --noquotes)
$KC create components -r "$REALM" \
  -s name=mcp-trusted-hosts \
  -s providerId=trusted-hosts \
  -s providerType=org.keycloak.services.clientregistration.policy.ClientRegistrationPolicy \
  -s parentId="$REALM_ID" \
  -s subType=anonymous \
  -s 'config."trusted-hosts"=["claude.ai"]' \
  -s 'config."host-sending-registration-request-must-match"=["false"]' \
  -s 'config."client-uris-must-match"=["true"]'

# ── A user to log in with ─────────────────────────────────────────────────────
$KC create users -r "$REALM" -s username=alice -s enabled=true \
  -s email=alice@example.com -s emailVerified=true
$KC set-password -r "$REALM" --username alice --new-password 'change-me'

echo "Done. Realm '$REALM' is ready."
```

### 2.2 What you just created

| Item                                 | Purpose                                               |
| ------------------------------------ | ----------------------------------------------------- |
| Realm `mcp`                          | Isolated tenant for this app                          |
| Client scope `mcp` + Audience mapper | Stamps tokens with `aud=$MCP_RESOURCE`                |
| `mcp` as a default scope             | Claude's auto-registered client inherits the audience |
| Trusted Hosts policy (`claude.ai`)   | Allows Claude's anonymous self-registration           |
| User `alice`                         | Someone to log in as                                  |

You do **not** pre-create a client for Claude — it registers itself at runtime.

---

## Part 3 — Your MCP server (resource server)

Two things to add to whatever serves `/mcp`.

### 3.1 Advertise the authorization server (RFC 9728)

Serve this JSON at **`/.well-known/oauth-protected-resource`** (CORS-open, since
the Claude web app fetches it from the browser):

```json
{
	"resource": "https://mcp.example.com/mcp",
	"authorization_servers": ["https://auth.example.com/realms/mcp"]
}
```

And when `/mcp` is called **without** a valid token, return `401` with a header
pointing at that document:

```
WWW-Authenticate: Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"
```

That 401 is what kicks off the whole OAuth dance.

> CORS: also handle `OPTIONS` preflight and expose the `WWW-Authenticate` header
> (`Access-Control-Expose-Headers: WWW-Authenticate`) so the browser MCP client
> can read the challenge.

### 3.2 Validate the JWT on every `/mcp` request

Verify the Bearer token's **signature** (against Keycloak's JWKS), **issuer**, and
**audience**. Here's the canonical Node version using [`jose`](https://github.com/panva/jose):

```ts
import { createRemoteJWKSet, jwtVerify } from 'jose';

const ISSUER = 'https://auth.example.com/realms/mcp';
const AUDIENCE = 'https://mcp.example.com/mcp'; // must equal your /mcp URL
const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/protocol/openid-connect/certs`));

export async function validateMcpToken(token: string) {
	try {
		const { payload } = await jwtVerify(token, JWKS, {
			issuer: ISSUER,
			audience: AUDIENCE
		});
		return payload; // valid — payload.sub is the Keycloak user id
	} catch {
		return null; // invalid/expired/wrong-audience → treat as unauthenticated
	}
}
```

Python equivalent: `PyJWT` + `PyJWKClient` (`jwt.decode(token, signing_key,
algorithms=['RS256'], audience=AUDIENCE, issuer=ISSUER)`), or `authlib`.

In your `/mcp` handler:

```ts
const auth = request.headers.get('authorization') ?? '';
const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
if (!token || !(await validateMcpToken(token))) {
	return unauthorized(); // the 401 + WWW-Authenticate from 3.1
}
// ...handle the JSON-RPC MCP request...
```

That's the entire server side. You never touch `/authorize`, `/token`, or
`/register` — Keycloak owns all of them.

---

## Part 4 — Deploy the MCP server on Coolify

Deploy your MCP server as its own Coolify resource with its own domain
(`https://mcp.example.com`). Set its env to match the realm:

```dotenv
OAUTH_ISSUER=https://auth.example.com/realms/mcp
MCP_RESOURCE=https://mcp.example.com/mcp
```

---

## Part 5 — Connect Claude.ai

1. In Claude, go to **Settings → Connectors → Add custom connector**.
2. Enter the MCP server URL: `https://mcp.example.com/mcp`.
3. Claude discovers the auth server, registers, and shows a login button.
4. Log in as your Keycloak user (`alice`). Approve.
5. Claude is connected and can call your tools.

---

## Gotchas (the things that actually break)

- **Audience must match exactly.** The `mcp` scope's Audience mapper value and
  your server's `AUDIENCE` must both be the _exact_ public `/mcp` URL — scheme,
  host, path, no trailing slash mismatch. A mismatch = every token rejected with
  no obvious error. This is the #1 cause of "it logs in but tools don't work."
- **Trusted Hosts must include `claude.ai`.** Otherwise anonymous registration is
  rejected (fail-closed) and Claude can't even start the flow.
- **`mcp` must be a _default_ client scope.** Claude's auto-registered client
  doesn't know to request a custom scope, so the audience has to come by default.
- **Everything is HTTPS in production.** Keycloak behind Coolify needs
  `KC_PROXY_HEADERS=xforwarded` and a correct `KC_HOSTNAME`, or redirect URIs and
  token issuer URLs come out wrong.
- **Verify the token claims** if stuck: temporarily enable Direct Access Grants on
  a test client, grab a token (`grant_type=password ... scope="openid mcp"`), and
  decode it — confirm `iss` and `aud` are what your server expects before blaming
  the server.

---

## Quick local test before going to prod

You can rehearse the whole thing locally with Docker before touching Coolify:

```yaml
# compose.yaml
services:
  keycloak-db:
    image: postgres
    environment: { POSTGRES_USER: keycloak, POSTGRES_PASSWORD: keycloak, POSTGRES_DB: keycloak }
    volumes: [kcdata:/var/lib/postgresql]
  keycloak:
    image: quay.io/keycloak/keycloak:26.3
    command: start-dev
    depends_on: [keycloak-db]
    ports: ['8080:8080']
    environment:
      KC_BOOTSTRAP_ADMIN_USERNAME: admin
      KC_BOOTSTRAP_ADMIN_PASSWORD: admin
      KC_DB: postgres
      KC_DB_URL: jdbc:postgresql://keycloak-db:5432/keycloak
      KC_DB_USERNAME: keycloak
      KC_DB_PASSWORD: keycloak
      KC_HOSTNAME_STRICT: 'false'
volumes: { kcdata: {} }
```

`docker compose up -d`, then run the Part 2 script against `http://localhost:8080`
with `MCP_RESOURCE=http://localhost:<your-mcp-port>/mcp`. (Note: Claude.ai can't
reach `localhost`, so end-to-end with the real Claude connector only works once
deployed — but you can test discovery, registration, and token issuance locally
with the [MCP Inspector](https://github.com/modelcontextprotocol/inspector).)

```

```
