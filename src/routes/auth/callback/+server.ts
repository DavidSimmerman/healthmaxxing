import { error, redirect } from '@sveltejs/kit';
import { exchangeCallback } from '$lib/server/keycloak';
import { SESSION_COOKIE, SESSION_MAX_AGE, issueUserSession } from '$lib/server/session';
import type { RequestHandler } from './$types';

// OIDC redirect target for the dashboard login. Keycloak sends the user back
// here with ?code&state; we exchange the code (PKCE) and mint our own session.
const TEMP_COOKIES = ['kc_verifier', 'kc_state', 'kc_redirect'];

function safeTarget(target: string | null | undefined): string {
	if (target && target.startsWith('/') && !target.startsWith('//')) return target;
	return '/';
}

export const GET: RequestHandler = async ({ url, cookies }) => {
	const codeVerifier = cookies.get('kc_verifier');
	const state = cookies.get('kc_state');
	const target = safeTarget(cookies.get('kc_redirect'));
	// One-shot: clear the temp cookies regardless of outcome.
	for (const c of TEMP_COOKIES) cookies.delete(c, { path: '/' });

	// Keycloak signalled an error (e.g. user cancelled at the login screen).
	const oauthError = url.searchParams.get('error');
	if (oauthError) {
		throw error(401, url.searchParams.get('error_description') ?? `Login failed: ${oauthError}`);
	}

	if (!codeVerifier || !state) {
		throw error(400, 'Login session expired or invalid. Please try signing in again.');
	}

	let user;
	try {
		// Verifies state, exchanges the code with PKCE, validates the ID token.
		user = await exchangeCallback(url, codeVerifier, state);
	} catch {
		throw error(401, 'Sign-in could not be completed. Please try again.');
	}

	cookies.set(SESSION_COOKIE, issueUserSession(user.sub), {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: url.protocol === 'https:',
		maxAge: SESSION_MAX_AGE
	});

	redirect(303, target);
};
