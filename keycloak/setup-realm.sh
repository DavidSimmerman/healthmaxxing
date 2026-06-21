#!/usr/bin/env bash
# Idempotent-ish Keycloak realm bootstrap for the health-dashboard.
#
# Creates the `health` realm with:
#   - confidential web client `health-dashboard-web` (auth-code + PKCE) for the
#     dashboard login
#   - an `mcp` client scope whose Audience mapper stamps tokens with the /mcp
#     resource URL, set as a realm default so dynamically-registered MCP clients
#     (Claude.ai) inherit it
#   - an anonymous Dynamic Client Registration "Trusted Hosts" policy that lets
#     Claude.ai self-register (RFC 7591)
#   - a dev user
#
# Run INSIDE the running keycloak container:
#   docker compose exec -T keycloak /opt/keycloak/data/import/setup-realm.sh
#
# Override any of these via env before running:
KC="${KC:-/opt/keycloak/bin/kcadm.sh}"
KC_SERVER="${KC_SERVER:-http://localhost:8080}"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASS:-admin}"
REALM="${REALM:-health}"
WEB_CLIENT_ID="${WEB_CLIENT_ID:-health-dashboard-web}"
WEB_CLIENT_SECRET="${WEB_CLIENT_SECRET:-dev-web-secret-change-me}"
# The app's public origin. The web redirect/logout URIs and the MCP audience are
# derived from it. For production, pass APP_ORIGIN=https://health.example.com.
APP_ORIGIN="${APP_ORIGIN:-http://localhost:5173}"
MCP_AUDIENCE="${APP_ORIGIN}/mcp"
# Trusted hosts allowed to perform anonymous client registration. claude.ai is
# the Claude web connector; localhost/127.0.0.1 cover local MCP Inspector.
TRUSTED_HOSTS="${TRUSTED_HOSTS:-claude.ai,localhost,127.0.0.1}"
DEV_USER="${DEV_USER:-david}"
DEV_PASS="${DEV_PASS:-dev-password}"
DEV_EMAIL="${DEV_EMAIL:-david@simmerman.tech}"

set -euo pipefail

echo "→ Authenticating to $KC_SERVER as $ADMIN_USER"
"$KC" config credentials --server "$KC_SERVER" --realm master --user "$ADMIN_USER" --password "$ADMIN_PASS"

# ── Realm ─────────────────────────────────────────────────────────────────────
if "$KC" get "realms/$REALM" >/dev/null 2>&1; then
	echo "→ Realm $REALM already exists — skipping create"
else
	echo "→ Creating realm $REALM"
	"$KC" create realms -s realm="$REALM" -s enabled=true -s sslRequired=external
fi

# ── mcp client scope + Audience mapper ────────────────────────────────────────
SCOPE_ID="$("$KC" get client-scopes -r "$REALM" --fields id,name 2>/dev/null \
	| grep -B1 '"name" : "mcp"' | grep '"id"' | head -1 | sed -E 's/.*: "([^"]+)".*/\1/' || true)"
if [ -z "${SCOPE_ID:-}" ]; then
	echo "→ Creating client scope 'mcp'"
	SCOPE_ID="$("$KC" create client-scopes -r "$REALM" \
		-s name=mcp -s protocol=openid-connect \
		-s 'attributes."include.in.token.scope"=true' \
		-s 'attributes."display.on.consent.screen"=true' \
		-s 'attributes."consent.screen.text"=Access your Healthmaxxing MCP server' \
		-i)"
	echo "→ Adding Audience mapper (aud=$MCP_AUDIENCE) to 'mcp' scope"
	"$KC" create "client-scopes/$SCOPE_ID/protocol-mappers/models" -r "$REALM" \
		-s name=mcp-audience -s protocol=openid-connect \
		-s protocolMapper=oidc-audience-mapper \
		-s 'config."included.custom.audience"='"$MCP_AUDIENCE" \
		-s 'config."access.token.claim"=true' \
		-s 'config."id.token.claim"=false' \
		-s 'config."introspection.token.claim"=true'
else
	echo "→ Client scope 'mcp' already exists ($SCOPE_ID) — skipping"
fi

echo "→ Making 'mcp' a realm default client scope"
"$KC" update "realms/$REALM/default-default-client-scopes/$SCOPE_ID" -r "$REALM" >/dev/null 2>&1 || true

# ── Web client (dashboard login) ──────────────────────────────────────────────
if "$KC" get clients -r "$REALM" -q clientId="$WEB_CLIENT_ID" --fields id | grep -q '"id"'; then
	echo "→ Web client $WEB_CLIENT_ID already exists — skipping"
else
	echo "→ Creating confidential web client $WEB_CLIENT_ID"
	"$KC" create clients -r "$REALM" \
		-s clientId="$WEB_CLIENT_ID" \
		-s name="Healthmaxxing" \
		-s enabled=true \
		-s protocol=openid-connect \
		-s publicClient=false \
		-s secret="$WEB_CLIENT_SECRET" \
		-s standardFlowEnabled=true \
		-s directAccessGrantsEnabled=false \
		-s serviceAccountsEnabled=false \
		-s 'redirectUris=["'"$APP_ORIGIN"'/auth/callback"]' \
		-s 'webOrigins=["'"$APP_ORIGIN"'"]' \
		-s 'attributes."post.logout.redirect.uris"='"$APP_ORIGIN"'/*' \
		-s 'attributes."pkce.code.challenge.method"=S256'
fi

# ── Anonymous Dynamic Client Registration: Trusted Hosts policy ────────────────
# Lets Claude.ai self-register (RFC 7591). Without a trusted host the anonymous
# registration endpoint rejects everyone (fail-closed default).
if "$KC" get "components?type=org.keycloak.services.clientregistration.policy.ClientRegistrationPolicy" -r "$REALM" \
	| grep -q '"name" : "health-trusted-hosts"'; then
	echo "→ Trusted Hosts policy already exists — skipping"
else
	echo "→ Creating anonymous Trusted Hosts client-registration policy ($TRUSTED_HOSTS)"
	REALM_ID="$("$KC" get "realms/$REALM" --fields id --format csv --noquotes)"
	# Build the trusted-hosts JSON array from the comma list (pure bash — the
	# Keycloak container image ships no awk).
	HOSTS_JSON=""
	IFS=',' read -ra _hosts <<<"$TRUSTED_HOSTS"
	for _h in "${_hosts[@]}"; do HOSTS_JSON="${HOSTS_JSON:+$HOSTS_JSON,}\"$_h\""; done
	"$KC" create components -r "$REALM" \
		-s name=health-trusted-hosts \
		-s providerId=trusted-hosts \
		-s providerType=org.keycloak.services.clientregistration.policy.ClientRegistrationPolicy \
		-s parentId="$REALM_ID" \
		-s subType=anonymous \
		-s 'config."trusted-hosts"=['"$HOSTS_JSON"']' \
		-s 'config."host-sending-registration-request-must-match"=["false"]' \
		-s 'config."client-uris-must-match"=["true"]'
fi

# ── Dev user ──────────────────────────────────────────────────────────────────
if "$KC" get users -r "$REALM" -q username="$DEV_USER" --fields id | grep -q '"id"'; then
	echo "→ Dev user $DEV_USER already exists — skipping"
else
	echo "→ Creating dev user $DEV_USER (password: $DEV_PASS)"
	"$KC" create users -r "$REALM" \
		-s username="$DEV_USER" -s enabled=true -s emailVerified=true \
		-s email="$DEV_EMAIL" -s firstName=David -s lastName=Simmerman
	"$KC" set-password -r "$REALM" --username "$DEV_USER" --new-password "$DEV_PASS"
fi

echo "✓ Realm '$REALM' configured."
