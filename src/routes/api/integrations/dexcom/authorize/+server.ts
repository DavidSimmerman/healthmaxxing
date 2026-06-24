import { redirect, error } from '@sveltejs/kit';
import { authorizeUrl, dexcomEnabled } from '$lib/server/dexcom';

// One-time owner kickoff: open this in the browser while logged into the
// dashboard — it redirects to Dexcom's consent screen, which then calls
// /callback. No extra token needed: the first-party auth hook already gates every
// non-public route behind a valid dashboard session (hooks.server.ts), so being
// logged in IS the owner check.
export function GET({ url }) {
	if (!dexcomEnabled()) throw error(503, 'Not configured (set DEXCOM_CLIENT_ID/SECRET).');
	const redirectUri = `${url.origin}/api/integrations/dexcom/callback`;
	throw redirect(302, authorizeUrl(redirectUri));
}
