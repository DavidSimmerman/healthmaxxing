import { fail, redirect } from '@sveltejs/kit';
import { verifyConsentPassword } from '$lib/server/oauth';
import { buildLoginRedirect, keycloakEnabled } from '$lib/server/keycloak';
import {
	SESSION_COOKIE,
	SESSION_MAX_AGE,
	authEnabled,
	issueSession,
	sessionValid
} from '$lib/server/session';
import type { Actions, PageServerLoad } from './$types';

// Only allow redirects to local paths (block open-redirect via //evil.com).
function safeTarget(target: string | null | undefined): string {
	if (target && target.startsWith('/') && !target.startsWith('//')) return target;
	return '/';
}

// Short-lived cookies that carry the PKCE verifier + state + post-login target
// across the round trip to Keycloak. Consumed (and cleared) by /auth/callback.
const TEMP_COOKIE_OPTS = (secure: boolean) =>
	({ path: '/', httpOnly: true, sameSite: 'lax', secure, maxAge: 600 }) as const;

export const load: PageServerLoad = async ({ url, cookies }) => {
	const target = safeTarget(url.searchParams.get('redirect'));

	// Already signed in — nothing to do.
	if (sessionValid(cookies.get(SESSION_COOKIE))) redirect(303, target);

	// Keycloak mode: kick off the OIDC auth-code flow by redirecting to Keycloak.
	// The password form below is never rendered in this mode.
	if (keycloakEnabled()) {
		const {
			url: kcUrl,
			codeVerifier,
			state
		} = await buildLoginRedirect(`${url.origin}/auth/callback`);
		const opts = TEMP_COOKIE_OPTS(url.protocol === 'https:');
		cookies.set('kc_verifier', codeVerifier, opts);
		cookies.set('kc_state', state, opts);
		cookies.set('kc_redirect', target, opts);
		redirect(303, kcUrl);
	}

	// Legacy password mode: nothing to log into if auth is off entirely.
	if (!authEnabled()) redirect(303, target);

	return { redirectTo: target };
};

export const actions: Actions = {
	default: async ({ request, cookies, url }) => {
		const form = await request.formData();
		const password = String(form.get('password') ?? '');
		const redirectTo = safeTarget(
			String(form.get('redirect') ?? '') || url.searchParams.get('redirect')
		);

		if (!verifyConsentPassword(password)) {
			return fail(401, { error: 'Incorrect password.' });
		}

		cookies.set(SESSION_COOKIE, issueSession(), {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: url.protocol === 'https:',
			maxAge: SESSION_MAX_AGE
		});
		redirect(303, redirectTo);
	}
};
