import { redirect } from '@sveltejs/kit';
import { SESSION_COOKIE } from '$lib/server/session';

// POST /logout — clear the session cookie and bounce to the login page.
export function POST({ cookies }) {
	cookies.delete(SESSION_COOKIE, { path: '/' });
	redirect(303, '/login');
}
