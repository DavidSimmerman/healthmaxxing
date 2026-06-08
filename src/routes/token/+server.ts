import { json } from '@sveltejs/kit';
import {
	consumeAuthCode,
	verifyPkce,
	issueTokens,
	rotateRefreshToken,
	type IssuedTokens
} from '$lib/server/oauth';

// OAuth errors are JSON bodies with a 400 (RFC 6749 §5.2), never thrown HTML.
function oauthError(error: string, description?: string, status = 400) {
	return json(
		{ error, ...(description ? { error_description: description } : {}) },
		{ status, headers: { 'Cache-Control': 'no-store' } }
	);
}

function tokenResponse(t: IssuedTokens, scope: string | null) {
	return json(
		{
			access_token: t.accessToken,
			token_type: 'Bearer',
			expires_in: t.expiresIn,
			refresh_token: t.refreshToken,
			...(scope ? { scope } : {})
		},
		{ headers: { 'Cache-Control': 'no-store' } }
	);
}

// Accept both application/x-www-form-urlencoded (the OAuth default) and JSON.
async function readBody(request: Request): Promise<Record<string, string>> {
	const ct = request.headers.get('content-type') ?? '';
	if (ct.includes('application/json')) {
		try {
			const j = await request.json();
			return Object.fromEntries(Object.entries(j).map(([k, v]) => [k, v == null ? '' : String(v)]));
		} catch {
			return {};
		}
	}
	const form = await request.formData();
	const out: Record<string, string> = {};
	for (const [k, v] of form.entries()) out[k] = String(v);
	return out;
}

// POST /token — RFC 6749 token endpoint. Supports authorization_code (+PKCE)
// and refresh_token grants.
export async function POST({ request }) {
	const body = await readBody(request);
	const grantType = body.grant_type;

	if (grantType === 'authorization_code') {
		const { code, redirect_uri, client_id, code_verifier } = body;
		if (!code || !code_verifier) {
			return oauthError('invalid_request', 'code and code_verifier required');
		}

		// Single-use consume; replay or expiry → invalid_grant.
		const row = await consumeAuthCode(code);
		if (!row) return oauthError('invalid_grant', 'code is invalid, expired, or already used');

		if (client_id && client_id !== row.clientId) {
			return oauthError('invalid_grant', 'client_id mismatch');
		}
		if (redirect_uri && redirect_uri !== row.redirectUri) {
			return oauthError('invalid_grant', 'redirect_uri mismatch');
		}
		if (!verifyPkce(code_verifier, row.codeChallenge, row.codeChallengeMethod)) {
			return oauthError('invalid_grant', 'PKCE verification failed');
		}

		const tokens = await issueTokens({
			clientId: row.clientId,
			scope: row.scope,
			resource: row.resource
		});
		return tokenResponse(tokens, row.scope);
	}

	if (grantType === 'refresh_token') {
		const { refresh_token } = body;
		if (!refresh_token) return oauthError('invalid_request', 'refresh_token required');
		const tokens = await rotateRefreshToken(refresh_token);
		if (!tokens) return oauthError('invalid_grant', 'refresh_token is invalid or revoked');
		return tokenResponse(tokens, null);
	}

	return oauthError('unsupported_grant_type', `unsupported grant_type: ${grantType ?? '(none)'}`);
}
