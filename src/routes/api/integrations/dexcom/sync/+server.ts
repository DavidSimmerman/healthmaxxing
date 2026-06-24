import { json, error } from '@sveltejs/kit';
import { requireApiToken } from '$lib/server/auth';
import { authEnabled, sessionValid, SESSION_COOKIE } from '$lib/server/session';
import { dexcomEnabled, syncGlucose, peekGlucose } from '$lib/server/dexcom';

// Pull (Dexcom EGV trace), hit by a cron with the API token. Dexcom updates every
// ~5 min, so run it hourly:
//   0 * * * * curl -fsS -X POST -H "Authorization: Bearer $API_TOKEN" \
//     https://<host>/api/integrations/dexcom/sync
// Body is optional JSON:
//   {"days": N}      backfill today + the previous N days (default 3, max 30)
//   {"debug": true}  return the RAW Dexcom response instead of writing — use once
//                    after authorizing to confirm the EGV schema against your account.
export async function POST({ request, cookies }) {
	// A logged-in browser (future day-page refresh) may trigger the same sync, but
	// only when app auth is actually ENABLED — otherwise the session is publicly
	// forgeable, so fall back to the bearer token (same rule as the Fitbit sync).
	if (!(authEnabled() && sessionValid(cookies.get(SESSION_COOKIE)))) {
		requireApiToken(request);
	}
	if (!dexcomEnabled()) throw error(503, 'Not configured (set DEXCOM_CLIENT_ID/SECRET).');

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
		return json(debug ? { debug: await peekGlucose(days) } : await syncGlucose(days));
	} catch (e) {
		console.error('dexcom sync failed:', e);
		throw error(502, e instanceof Error ? e.message : 'Sync failed.');
	}
}
