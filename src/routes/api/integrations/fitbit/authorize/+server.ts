import { redirect, error } from '@sveltejs/kit';
import { authorizeUrl, googleHealthEnabled, ownerTokenOk } from '$lib/server/fitbit';

// One-time owner kickoff. Open this in a browser with ?token=<API_TOKEN>; it
// redirects to Google's consent screen (Google Health API). Google then calls
// /callback. The browser can't set an Authorization header on a top-level
// navigation, so the owner gate is the ?token query param (constant-time compared).
export function GET({ url }) {
	if (!googleHealthEnabled())
		throw error(503, 'Not configured (set GOOGLE_HEALTH_CLIENT_ID/SECRET).');
	if (!ownerTokenOk(url.searchParams.get('token') ?? '')) throw error(401, 'Unauthorized');
	const redirectUri = `${url.origin}/api/integrations/fitbit/callback`;
	throw redirect(302, authorizeUrl(redirectUri));
}
