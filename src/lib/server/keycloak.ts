import { env } from '$env/dynamic/private';
import * as client from 'openid-client';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

// ── Single-IdP integration ────────────────────────────────────────────────────
// When KEYCLOAK_ISSUER is set, Keycloak is the identity provider for BOTH the
// first-party dashboard login (browser auth-code + PKCE flow handled here) and
// the Claude.ai MCP connector (Claude talks to Keycloak directly; /mcp only
// VALIDATES the resulting JWT — see validateMcpToken). When it's unset the app
// falls back to the legacy homegrown password/AS flow.

export function keycloakEnabled(): boolean {
	return !!env.KEYCLOAK_ISSUER;
}

function issuerUrl(): URL {
	const v = env.KEYCLOAK_ISSUER;
	if (!v) throw new Error('KEYCLOAK_ISSUER is not set');
	return new URL(v);
}

// Scopes requested for the browser login. openid is mandatory for OIDC.
export const LOGIN_SCOPE = 'openid profile email';

// ── Discovery (cached) ────────────────────────────────────────────────────────
// discovery() hits Keycloak's .well-known/openid-configuration once; the
// resulting Configuration is reused for every request. Cached as a promise so
// concurrent callers share a single in-flight fetch.
let configPromise: Promise<client.Configuration> | null = null;

export function getOidcConfig(): Promise<client.Configuration> {
	if (!configPromise) {
		const clientId = env.KEYCLOAK_CLIENT_ID;
		const clientSecret = env.KEYCLOAK_CLIENT_SECRET;
		if (!clientId || !clientSecret) {
			throw new Error('KEYCLOAK_CLIENT_ID / KEYCLOAK_CLIENT_SECRET are not set');
		}
		const issuer = issuerUrl();
		// openid-client v6 refuses http: by default. A local Keycloak is served
		// over http://localhost — opt into insecure requests ONLY for an http
		// issuer so the dev flow works while production (https) stays strict.
		const options =
			issuer.protocol === 'http:' ? { execute: [client.allowInsecureRequests] } : undefined;
		configPromise = client
			.discovery(issuer, clientId, clientSecret, undefined, options)
			.catch((e) => {
				// Don't cache a failed discovery — let the next request retry.
				configPromise = null;
				throw e;
			});
	}
	return configPromise;
}

// ── Browser login: build the redirect to Keycloak ─────────────────────────────
export type AuthRequest = {
	url: string;
	codeVerifier: string;
	state: string;
};

export async function buildLoginRedirect(redirectUri: string): Promise<AuthRequest> {
	const config = await getOidcConfig();
	const codeVerifier = client.randomPKCECodeVerifier();
	const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
	// PKCE binds the code to this user-agent; state additionally defends the
	// callback against login-CSRF. We keep both in short-lived signed cookies.
	const state = client.randomState();

	const url = client.buildAuthorizationUrl(config, {
		redirect_uri: redirectUri,
		scope: LOGIN_SCOPE,
		code_challenge: codeChallenge,
		code_challenge_method: 'S256',
		state
	});

	return { url: url.href, codeVerifier, state };
}

// ── Browser login: exchange the callback for the user's identity ──────────────
export type AuthedUser = {
	sub: string;
	username: string | null;
	email: string | null;
	name: string | null;
};

export async function exchangeCallback(
	currentUrl: URL,
	codeVerifier: string,
	expectedState: string
): Promise<AuthedUser> {
	const config = await getOidcConfig();
	const tokens = await client.authorizationCodeGrant(config, currentUrl, {
		pkceCodeVerifier: codeVerifier,
		expectedState
	});
	const claims = tokens.claims();
	if (!claims?.sub) throw new Error('ID token missing sub claim');
	return {
		sub: claims.sub,
		username: typeof claims.preferred_username === 'string' ? claims.preferred_username : null,
		email: typeof claims.email === 'string' ? claims.email : null,
		name: typeof claims.name === 'string' ? claims.name : null
	};
}

// ── Browser logout: RP-initiated end-session URL ──────────────────────────────
export async function buildLogoutRedirect(postLogoutRedirectUri: string): Promise<string> {
	const config = await getOidcConfig();
	// No id_token_hint stored, so we rely on client_id + a registered
	// post_logout_redirect_uri (openid-client adds client_id automatically).
	const url = client.buildEndSessionUrl(config, {
		post_logout_redirect_uri: postLogoutRedirectUri
	});
	return url.href;
}

// ── MCP resource server: validate a Keycloak-issued access token ──────────────
// Claude.ai obtains this token directly from Keycloak (dynamic registration +
// auth-code/PKCE). We're the resource server: verify the JWT signature against
// Keycloak's JWKS, the issuer, and that the audience targets THIS /mcp resource.
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks(): ReturnType<typeof createRemoteJWKSet> {
	if (!jwks) {
		// RFC 8414 jwks_uri for a Keycloak realm.
		jwks = createRemoteJWKSet(
			new URL(`${issuerUrl().href.replace(/\/$/, '')}/protocol/openid-connect/certs`)
		);
	}
	return jwks;
}

export async function validateMcpToken(
	token: string,
	expectedAudience: string
): Promise<JWTPayload | null> {
	try {
		const { payload } = await jwtVerify(token, getJwks(), {
			issuer: env.KEYCLOAK_ISSUER,
			audience: expectedAudience
		});
		return payload;
	} catch {
		return null;
	}
}
