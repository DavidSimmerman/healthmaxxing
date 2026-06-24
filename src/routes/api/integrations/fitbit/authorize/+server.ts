import { redirect, error } from '@sveltejs/kit';
import { authorizeUrl, googleHealthEnabled } from '$lib/server/fitbit';

// One-time owner kickoff: open this in the browser while logged into the
// dashboard — it redirects to Google's consent screen (Google Health API), and
// Google then calls /callback. No extra token needed: the first-party auth hook
// already gates every non-public route behind a valid dashboard session (see
// hooks.server.ts), so being logged in IS the owner check.
export function GET({ url }) {
	if (!googleHealthEnabled())
		throw error(503, 'Not configured (set GOOGLE_HEALTH_CLIENT_ID/SECRET).');
	const redirectUri = `${url.origin}/api/integrations/fitbit/callback`;
	throw redirect(302, authorizeUrl(redirectUri));
}
