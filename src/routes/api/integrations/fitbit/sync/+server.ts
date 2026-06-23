import { json, error } from '@sveltejs/kit';
import { requireApiToken } from '$lib/server/auth';
import { googleHealthEnabled, syncHealth, peekHealth } from '$lib/server/fitbit';

// Daily pull (Fitbit data via the Google Health API), hit by a cron with the API token:
//   0 9 * * * curl -fsS -X POST -H "Authorization: Bearer $API_TOKEN" \
//     https://<host>/api/integrations/fitbit/sync
// Body is optional JSON:
//   {"days": N}   backfill today + the previous N dates (default 3)
//   {"debug": true}  return the RAW Google responses (status + body per data type)
//                    instead of writing — use once after authorizing to confirm the
//                    response schema / filter fields against your live account.
export async function POST({ request }) {
	requireApiToken(request);
	if (!googleHealthEnabled())
		throw error(503, 'Not configured (set GOOGLE_HEALTH_CLIENT_ID/SECRET).');

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
		return json(debug ? { debug: await peekHealth(days) } : await syncHealth(days));
	} catch (e) {
		console.error('fitbit/google sync failed:', e);
		throw error(502, e instanceof Error ? e.message : 'Sync failed.');
	}
}
