import { redirect } from '@sveltejs/kit';
import { SESSION_COOKIE } from '$lib/server/session';
import { buildLogoutRedirect, keycloakEnabled } from '$lib/server/keycloak';

// POST /logout — clear the local session. In Keycloak mode also perform
// RP-initiated logout so the Keycloak SSO session ends too; otherwise just
// bounce to the login page.
export async function POST({ cookies, url }) {
	cookies.delete(SESSION_COOKIE, { path: '/' });

	if (keycloakEnabled()) {
		let logoutUrl: string;
		try {
			logoutUrl = await buildLogoutRedirect(`${url.origin}/login`);
		} catch {
			// Discovery/end-session lookup failed — local logout already happened,
			// so just fall back to the login page.
			redirect(303, '/login');
		}
		redirect(303, logoutUrl);
	}

	redirect(303, '/login');
}
