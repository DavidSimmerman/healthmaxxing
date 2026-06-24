import { error } from '@sveltejs/kit';
import { exchangeCode, dexcomEnabled, oauthState, safeEqual } from '$lib/server/dexcom';

// Dexcom redirects here after consent. We verify the state (an HMAC of the API
// token, so a forged callback can't inject someone else's account), exchange the
// code for tokens, and persist the refresh token.
export async function GET({ url }) {
	if (!dexcomEnabled()) throw error(503, 'Not configured.');
	const err = url.searchParams.get('error');
	if (err) throw error(400, `Dexcom authorization failed: ${err}`);
	const code = url.searchParams.get('code');
	if (!code) throw error(400, 'Missing authorization code.');
	if (!safeEqual(url.searchParams.get('state') ?? '', oauthState())) {
		throw error(401, 'Invalid state.');
	}
	const redirectUri = `${url.origin}/api/integrations/dexcom/callback`;
	try {
		await exchangeCode(code, redirectUri);
	} catch (e) {
		console.error('dexcom callback exchange failed:', e);
		throw error(502, 'Could not complete Dexcom authorization.');
	}
	return new Response('Dexcom connected. You can close this tab.', {
		headers: { 'Content-Type': 'text/plain' }
	});
}
