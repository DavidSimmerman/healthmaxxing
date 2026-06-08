import { error, fail, redirect } from '@sveltejs/kit';
import {
	getClient,
	createAuthCode,
	verifyConsentPassword,
	consentConfigured
} from '$lib/server/oauth';
import type { Actions, PageServerLoad } from './$types';

type OAuthParams = {
	clientId: string;
	redirectUri: string;
	codeChallenge: string;
	codeChallengeMethod: string;
	state: string;
	scope: string;
	resource: string;
};

function readParams(url: URL): Record<keyof OAuthParams, string> {
	return {
		clientId: url.searchParams.get('client_id') ?? '',
		redirectUri: url.searchParams.get('redirect_uri') ?? '',
		codeChallenge: url.searchParams.get('code_challenge') ?? '',
		codeChallengeMethod: url.searchParams.get('code_challenge_method') ?? 'S256',
		state: url.searchParams.get('state') ?? '',
		scope: url.searchParams.get('scope') ?? '',
		resource: url.searchParams.get('resource') ?? ''
	};
}

// Build a redirect back to the client carrying an OAuth error (used only once
// we've confirmed the redirect_uri is genuinely registered for the client).
function errorRedirect(
	redirectUri: string,
	state: string,
	code: string,
	description: string
): never {
	const u = new URL(redirectUri);
	u.searchParams.set('error', code);
	if (description) u.searchParams.set('error_description', description);
	if (state) u.searchParams.set('state', state);
	redirect(303, u.toString());
}

// Validate the client + redirect_uri pairing. Returns the matched redirect_uri.
// Throws a render-able error (NOT a redirect) when we can't trust the target.
async function validateClient(clientId: string, redirectUri: string): Promise<void> {
	if (!clientId) throw error(400, 'missing client_id');
	const client = await getClient(clientId);
	if (!client) throw error(400, 'unknown client_id');
	if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
		throw error(400, 'redirect_uri does not match a registered URI for this client');
	}
}

export const load: PageServerLoad = async ({ url }) => {
	const p = readParams(url);
	const responseType = url.searchParams.get('response_type');

	// Client/redirect failures can't be safely redirected — render an error.
	await validateClient(p.clientId, p.redirectUri);

	if (!consentConfigured()) {
		throw error(503, 'Authorization is not configured (MCP_AUTH_PASSWORD unset).');
	}

	// From here the redirect_uri is trusted; param errors go back to the client.
	if (responseType !== 'code') {
		errorRedirect(p.redirectUri, p.state, 'unsupported_response_type', 'only code is supported');
	}
	if (!p.codeChallenge || p.codeChallengeMethod !== 'S256') {
		errorRedirect(p.redirectUri, p.state, 'invalid_request', 'PKCE S256 challenge required');
	}

	return {
		clientName: (await getClient(p.clientId))?.clientName ?? null,
		params: p,
		// The form posts to `?/authorize`, which would otherwise drop these query
		// params; carrying them in the action keeps them present when `load`
		// re-runs to render a wrong-password error.
		search: url.search
	};
};

export const actions: Actions = {
	// User approved — verify the password, mint a code, bounce back to the client.
	authorize: async ({ request }) => {
		const form = await request.formData();
		const p: OAuthParams = {
			clientId: String(form.get('client_id') ?? ''),
			redirectUri: String(form.get('redirect_uri') ?? ''),
			codeChallenge: String(form.get('code_challenge') ?? ''),
			codeChallengeMethod: String(form.get('code_challenge_method') ?? 'S256'),
			state: String(form.get('state') ?? ''),
			scope: String(form.get('scope') ?? ''),
			resource: String(form.get('resource') ?? '')
		};
		const password = String(form.get('password') ?? '');

		// Re-validate against the DB — never trust the hidden fields alone.
		await validateClient(p.clientId, p.redirectUri);
		if (!p.codeChallenge || p.codeChallengeMethod !== 'S256') {
			errorRedirect(p.redirectUri, p.state, 'invalid_request', 'PKCE S256 challenge required');
		}

		if (!verifyConsentPassword(password)) {
			return fail(401, { error: 'Incorrect password.' });
		}

		const code = await createAuthCode({
			clientId: p.clientId,
			redirectUri: p.redirectUri,
			codeChallenge: p.codeChallenge,
			codeChallengeMethod: p.codeChallengeMethod,
			scope: p.scope || null,
			resource: p.resource || null
		});

		const u = new URL(p.redirectUri);
		u.searchParams.set('code', code);
		if (p.state) u.searchParams.set('state', p.state);
		redirect(303, u.toString());
	},

	// User declined.
	deny: async ({ request }) => {
		const form = await request.formData();
		const redirectUri = String(form.get('redirect_uri') ?? '');
		const clientId = String(form.get('client_id') ?? '');
		const state = String(form.get('state') ?? '');
		await validateClient(clientId, redirectUri);
		errorRedirect(redirectUri, state, 'access_denied', 'user denied the request');
	}
};
