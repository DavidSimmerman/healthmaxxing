import { fail, redirect } from '@sveltejs/kit';
import { verifyConsentPassword } from '$lib/server/oauth';
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

export const load: PageServerLoad = async ({ url, cookies }) => {
	// Nothing to log into if auth is off, or already signed in.
	if (!authEnabled() || sessionValid(cookies.get(SESSION_COOKIE))) {
		redirect(303, safeTarget(url.searchParams.get('redirect')));
	}
	return { redirectTo: safeTarget(url.searchParams.get('redirect')) };
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
