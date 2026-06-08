import { db } from '$lib/server/db';
import { oauthClients, oauthCodes, oauthTokens } from '$lib/server/db/schema';
import { and, eq, gt } from 'drizzle-orm';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';

const ACCESS_TTL_SECONDS = 60 * 60; // 1 hour
const CODE_TTL_SECONDS = 5 * 60; // 5 minutes

function base64url(buf: Buffer): string {
	return buf.toString('base64url');
}

export function sha256(input: string): string {
	return createHash('sha256').update(input).digest('hex');
}

export function randomToken(bytes = 32): string {
	return base64url(randomBytes(bytes));
}

// ── PKCE ────────────────────────────────────────────────────────────────────
export function verifyPkce(verifier: string, challenge: string, method = 'S256'): boolean {
	if (method === 'plain') return safeEqualStr(verifier, challenge);
	if (method !== 'S256') return false;
	const computed = base64url(createHash('sha256').update(verifier).digest());
	return safeEqualStr(computed, challenge);
}

function safeEqualStr(a: string, b: string): boolean {
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ab.length !== bb.length) return false;
	return timingSafeEqual(ab, bb);
}

// ── Consent gate ──────────────────────────────────────────────────────────────
// The single shared password the user types on /authorize. Without it set, the
// authorization server refuses to mint codes (fail closed).
export function consentConfigured(): boolean {
	return !!env.MCP_AUTH_PASSWORD;
}

export function verifyConsentPassword(provided: string): boolean {
	const expected = env.MCP_AUTH_PASSWORD;
	if (!expected) return false;
	// Compare fixed-length digests so the timing-safe check can't leak the
	// password length (raw strings differ in length and short-circuit).
	const a = createHash('sha256').update(provided).digest();
	const b = createHash('sha256').update(expected).digest();
	return timingSafeEqual(a, b);
}

// ── Clients (RFC 7591 dynamic registration) ──────────────────────────────────
export async function registerClient(input: {
	clientName?: string | null;
	redirectUris: string[];
}): Promise<{ clientId: string }> {
	const clientId = `mcp_${randomToken(16)}`;
	await db.insert(oauthClients).values({
		clientId,
		clientName: input.clientName ?? null,
		redirectUris: input.redirectUris
	});
	return { clientId };
}

export async function getClient(clientId: string) {
	const [row] = await db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId));
	return row ?? null;
}

// ── Authorization codes ───────────────────────────────────────────────────────
export async function createAuthCode(input: {
	clientId: string;
	redirectUri: string;
	codeChallenge: string;
	codeChallengeMethod: string;
	scope?: string | null;
	resource?: string | null;
}): Promise<string> {
	const code = randomToken(32);
	await db.insert(oauthCodes).values({
		code: sha256(code),
		clientId: input.clientId,
		redirectUri: input.redirectUri,
		codeChallenge: input.codeChallenge,
		codeChallengeMethod: input.codeChallengeMethod,
		scope: input.scope ?? null,
		resource: input.resource ?? null,
		expiresAt: new Date(Date.now() + CODE_TTL_SECONDS * 1000)
	});
	return code;
}

// Atomically consume a code: marks it used and returns the row only if it was
// unconsumed and unexpired. Replay attempts get null.
export async function consumeAuthCode(code: string) {
	const [row] = await db
		.update(oauthCodes)
		.set({ consumed: true })
		.where(
			and(
				eq(oauthCodes.code, sha256(code)),
				eq(oauthCodes.consumed, false),
				gt(oauthCodes.expiresAt, new Date())
			)
		)
		.returning();
	return row ?? null;
}

// ── Tokens ────────────────────────────────────────────────────────────────────
export type IssuedTokens = {
	accessToken: string;
	refreshToken: string;
	expiresIn: number;
};

export async function issueTokens(input: {
	clientId: string;
	scope?: string | null;
	resource?: string | null;
}): Promise<IssuedTokens> {
	const accessToken = randomToken(32);
	const refreshToken = randomToken(32);
	await db.insert(oauthTokens).values({
		accessTokenHash: sha256(accessToken),
		refreshTokenHash: sha256(refreshToken),
		clientId: input.clientId,
		scope: input.scope ?? null,
		resource: input.resource ?? null,
		accessExpiresAt: new Date(Date.now() + ACCESS_TTL_SECONDS * 1000)
	});
	return { accessToken, refreshToken, expiresIn: ACCESS_TTL_SECONDS };
}

// Validate a presented Bearer access token. Returns the token row or null.
export async function validateAccessToken(accessToken: string) {
	const [row] = await db
		.select()
		.from(oauthTokens)
		.where(
			and(
				eq(oauthTokens.accessTokenHash, sha256(accessToken)),
				eq(oauthTokens.revoked, false),
				gt(oauthTokens.accessExpiresAt, new Date())
			)
		);
	return row ?? null;
}

// Rotate a refresh token: revoke the old token row, issue a fresh pair.
// Returns null if the refresh token is unknown/revoked.
export async function rotateRefreshToken(refreshToken: string): Promise<IssuedTokens | null> {
	return db.transaction(async (tx) => {
		const [old] = await tx
			.update(oauthTokens)
			.set({ revoked: true })
			.where(
				and(eq(oauthTokens.refreshTokenHash, sha256(refreshToken)), eq(oauthTokens.revoked, false))
			)
			.returning();
		if (!old) return null;

		const accessToken = randomToken(32);
		const newRefresh = randomToken(32);
		await tx.insert(oauthTokens).values({
			accessTokenHash: sha256(accessToken),
			refreshTokenHash: sha256(newRefresh),
			clientId: old.clientId,
			scope: old.scope,
			resource: old.resource,
			accessExpiresAt: new Date(Date.now() + ACCESS_TTL_SECONDS * 1000)
		});
		return { accessToken, refreshToken: newRefresh, expiresIn: ACCESS_TTL_SECONDS };
	});
}
