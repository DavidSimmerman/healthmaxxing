import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';

// First-party dashboard auth: a signed, stateless session cookie proving the
// visitor knew the app password (MCP_AUTH_PASSWORD — the same secret that gates
// the Claude consent screen). No DB session table; the cookie carries an
// issued-at timestamp and an HMAC over it.

export const SESSION_COOKIE = 'hd_session';
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days, in seconds

// Auth is only enforced when a password is configured. Unset = open app
// (dev convenience, matches the API_TOKEN-unset behavior).
export function authEnabled(): boolean {
	return !!env.MCP_AUTH_PASSWORD;
}

// Stable signing key derived from the app password. Rotating the password
// invalidates all existing sessions, which is the behavior we want.
function signingKey(): Buffer {
	return createHmac('sha256', 'hd-session-key-v1')
		.update(env.MCP_AUTH_PASSWORD ?? '')
		.digest();
}

function sign(payload: string): string {
	return createHmac('sha256', signingKey()).update(payload).digest('base64url');
}

export function issueSession(): string {
	const payload = `v1.${Date.now()}`;
	return `${payload}.${sign(payload)}`;
}

export function sessionValid(value: string | undefined | null): boolean {
	if (!value) return false;
	const lastDot = value.lastIndexOf('.');
	if (lastDot < 0) return false;
	const payload = value.slice(0, lastDot);
	const sig = value.slice(lastDot + 1);

	const expected = sign(payload);
	const a = Buffer.from(sig);
	const b = Buffer.from(expected);
	if (a.length !== b.length || !timingSafeEqual(a, b)) return false;

	const [version, issuedRaw] = payload.split('.');
	if (version !== 'v1') return false;
	const issued = Number(issuedRaw);
	if (!Number.isFinite(issued)) return false;
	return Date.now() - issued <= SESSION_MAX_AGE * 1000;
}
