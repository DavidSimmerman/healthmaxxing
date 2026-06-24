import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { keycloakEnabled } from '$lib/server/keycloak';

// First-party dashboard session cookie — stateless, no DB session table. Two
// formats coexist:
//   v1 (legacy):  `v1.<issuedAt>`           signed with a key derived from MCP_AUTH_PASSWORD
//   v2 (Keycloak): `v2.<sub>.<issuedAt>`    signed with a key derived from SESSION_SECRET
// Which one we issue depends on whether Keycloak is configured. Validation
// accepts whichever format matches the active auth mode.

export const SESSION_COOKIE = 'hd_session';
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days, in seconds

// Auth is enforced when EITHER Keycloak is configured (preferred) or the legacy
// app password is set. Unset both = open app (dev convenience).
export function authEnabled(): boolean {
	return keycloakEnabled() || !!env.MCP_AUTH_PASSWORD;
}

// ── Signing keys ──────────────────────────────────────────────────────────────
// Each session format binds to its own secret. Rotating that secret invalidates
// all existing sessions of that format, which is the behavior we want.
function legacySigningKey(): Buffer {
	return createHmac('sha256', 'hd-session-key-v1')
		.update(env.MCP_AUTH_PASSWORD ?? '')
		.digest();
}

// v2 (Keycloak) sessions REQUIRE a configured SESSION_SECRET. Throwing here is
// deliberate: an empty secret would derive a publicly-reproducible signing key,
// letting anyone forge an hd_session and bypass login. issueUserSession()
// surfaces this loudly at login time; sessionValid() catches it and denies, so
// the app fails closed rather than accepting forged cookies.
function userSigningKey(): Buffer {
	const secret = env.SESSION_SECRET;
	if (!secret) {
		throw new Error('SESSION_SECRET must be set when Keycloak (KEYCLOAK_ISSUER) is configured');
	}
	return createHmac('sha256', 'hd-session-key-v2').update(secret).digest();
}

function sign(key: Buffer, payload: string): string {
	return createHmac('sha256', key).update(payload).digest('base64url');
}

function signatureMatches(key: Buffer, payload: string, sig: string): boolean {
	const a = Buffer.from(sig);
	const b = Buffer.from(sign(key, payload));
	return a.length === b.length && timingSafeEqual(a, b);
}

function notExpired(issuedRaw: string): boolean {
	const issued = Number(issuedRaw);
	if (!Number.isFinite(issued)) return false;
	return Date.now() - issued <= SESSION_MAX_AGE * 1000;
}

// ── Issue ─────────────────────────────────────────────────────────────────────
// Legacy password login (v1).
export function issueSession(): string {
	const payload = `v1.${Date.now()}`;
	return `${payload}.${sign(legacySigningKey(), payload)}`;
}

// Keycloak login (v2) — carries the user's Keycloak subject.
export function issueUserSession(sub: string): string {
	// sub can't contain a dot in practice, but encode defensively so the
	// payload/signature split stays unambiguous.
	const payload = `v2.${encodeURIComponent(sub)}.${Date.now()}`;
	return `${payload}.${sign(userSigningKey(), payload)}`;
}

// ── Validate ──────────────────────────────────────────────────────────────────
export function sessionValid(value: string | undefined | null): boolean {
	if (!value) return false;
	const lastDot = value.lastIndexOf('.');
	if (lastDot < 0) return false;
	const payload = value.slice(0, lastDot);
	const sig = value.slice(lastDot + 1);

	if (payload.startsWith('v2.')) {
		const parts = payload.split('.');
		if (parts.length !== 3) return false;
		// userSigningKey() throws when SESSION_SECRET is unset — deny rather than
		// validate against an empty-string-derived (forgeable) key.
		let key: Buffer;
		try {
			key = userSigningKey();
		} catch {
			return false;
		}
		if (!signatureMatches(key, payload, sig)) return false;
		return notExpired(parts[2]);
	}

	if (payload.startsWith('v1.')) {
		const parts = payload.split('.');
		if (parts.length !== 2) return false;
		// v1 (legacy) sessions are only trustworthy when MCP_AUTH_PASSWORD is set —
		// otherwise legacySigningKey() derives from an empty password and is publicly
		// forgeable (same failure the v2/SESSION_SECRET guard above prevents). Deny
		// rather than validate against a reproducible key, so a Keycloak-only or
		// no-auth deployment can't be bypassed by a hand-crafted v1 cookie.
		if (!env.MCP_AUTH_PASSWORD) return false;
		if (!signatureMatches(legacySigningKey(), payload, sig)) return false;
		return notExpired(parts[1]);
	}

	return false;
}
