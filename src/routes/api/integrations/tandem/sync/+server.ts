import { json, error } from '@sveltejs/kit';
import { requireApiToken } from '$lib/server/auth';
import { authEnabled, sessionValid, SESSION_COOKIE } from '$lib/server/session';
import { tandemEnabled, syncInsulin, peekInsulin } from '$lib/server/tandem';

// Pull the Tandem insulin trace (basal + boluses) via the Python sidecar. Hit by
// a cron with the API token. The pump uploads via the phone app every few minutes
// when in range, so hourly is plenty:
//   0 * * * * curl -fsS -X POST -H "Authorization: Bearer $API_TOKEN" \
//     https://<host>/api/integrations/tandem/sync
// Body is optional JSON:
//   {"days": N}      backfill today + the previous N days (default 3, max 30)
//   {"debug": true}  return the RAW sidecar trace instead of writing — use once
//                    after connecting to confirm the data against your account.
export async function POST({ request, cookies }) {
	// Same gate as the Dexcom sync: a logged-in browser session when app auth is
	// enabled, otherwise the bearer token (the session is forgeable otherwise).
	if (!(authEnabled() && sessionValid(cookies.get(SESSION_COOKIE)))) {
		requireApiToken(request);
	}
	if (!tandemEnabled()) throw error(503, 'Not configured (set TANDEM_ENC_KEY).');

	let days = 3;
	let debug = false;
	try {
		const body = await request.json();
		if (body && typeof body.days === 'number' && Number.isFinite(body.days)) {
			days = Math.min(Math.max(Math.floor(body.days), 1), 30);
		}
		debug = !!(body && body.debug);
	} catch {
		// No/!JSON body (a bare cron curl) — use defaults.
	}

	try {
		return json(debug ? { debug: await peekInsulin(days) } : await syncInsulin(days));
	} catch (e) {
		console.error('tandem sync failed:', e);
		throw error(502, e instanceof Error ? e.message : 'Sync failed.');
	}
}
