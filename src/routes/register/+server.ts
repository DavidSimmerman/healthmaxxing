import { json, error } from '@sveltejs/kit';
import { registerClient } from '$lib/server/oauth';

// POST /register — OAuth 2.0 Dynamic Client Registration (RFC 7591).
// Claude.ai self-registers here before starting the auth-code flow. We issue a
// public client_id (no secret); PKCE is the proof-of-possession.
export async function POST({ request }) {
	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'invalid JSON');
	}

	const redirectUris = body.redirect_uris;
	if (
		!Array.isArray(redirectUris) ||
		redirectUris.length === 0 ||
		!redirectUris.every((u) => typeof u === 'string' && isAbsoluteUrl(u))
	) {
		throw error(400, 'redirect_uris must be a non-empty array of absolute URLs');
	}

	const clientName = typeof body.client_name === 'string' ? body.client_name : null;
	const { clientId } = await registerClient({ clientName, redirectUris: redirectUris as string[] });

	return json(
		{
			client_id: clientId,
			client_name: clientName ?? undefined,
			redirect_uris: redirectUris,
			token_endpoint_auth_method: 'none',
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			client_id_issued_at: Math.floor(Date.now() / 1000)
		},
		{ status: 201 }
	);
}

function isAbsoluteUrl(u: string): boolean {
	try {
		const url = new URL(u);
		return url.protocol === 'https:' || url.protocol === 'http:';
	} catch {
		return false;
	}
}
