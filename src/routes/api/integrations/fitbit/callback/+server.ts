import { error } from '@sveltejs/kit';
import { exchangeCode, googleHealthEnabled, oauthState, safeEqual } from '$lib/server/fitbit';

// Google redirects here after consent. We verify the state (an HMAC of the API
// token, so a forged callback can't inject someone else's account), exchange the
// code for tokens, and persist the refresh token.
export async function GET({ url }) {
	if (!googleHealthEnabled()) throw error(503, 'Not configured.');
	const err = url.searchParams.get('error');
	if (err) throw error(400, `Fitbit authorization failed: ${err}`);
	const code = url.searchParams.get('code');
	if (!code) throw error(400, 'Missing authorization code.');
	if (!safeEqual(url.searchParams.get('state') ?? '', oauthState())) {
		throw error(401, 'Invalid state.');
	}
	const redirectUri = `${url.origin}/api/integrations/fitbit/callback`;
	try {
		await exchangeCode(code, redirectUri);
	} catch (e) {
		console.error('fitbit callback exchange failed:', e);
		throw error(502, 'Could not complete Fitbit authorization.');
	}
	return new Response('Fitbit connected. You can close this tab.', {
		headers: { 'Content-Type': 'text/plain' }
	});
}
