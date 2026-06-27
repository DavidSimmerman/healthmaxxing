import { json } from '@sveltejs/kit';
import { requireApiToken } from '$lib/server/auth';
import { authEnabled, sessionValid, SESSION_COOKIE } from '$lib/server/session';
import { dexcomEnabled, syncGlucose } from '$lib/server/dexcom';
import { tandemEnabled, syncInsulin } from '$lib/server/tandem';
import { googleHealthEnabled, syncHealth } from '$lib/server/fitbit';

// One-shot backfill across every connected source. Each source's sync already
// takes a day window; this just fans out to all of them so you don't curl three
// endpoints. Default 14 days ("2 weeks"), capped at 30 (the per-source max).
//
//   curl -fsS -X POST -H "Authorization: Bearer $API_TOKEN" \
//     -H 'Content-Type: application/json' -d '{"days":14}' \
//     https://<host>/api/integrations/backfill
//
// A source that isn't configured is skipped; one that errors (e.g. not yet
// authorized) is reported but doesn't stop the others.
export async function POST({ request, cookies }) {
	// Same gate as the per-source syncs: a logged-in session, else the API token.
	if (!(authEnabled() && sessionValid(cookies.get(SESSION_COOKIE)))) {
		requireApiToken(request);
	}

	let days = 14;
	try {
		const body = await request.json();
		if (body && typeof body.days === 'number' && Number.isFinite(body.days)) {
			days = Math.min(Math.max(Math.floor(body.days), 1), 30);
		}
	} catch {
		// No/!JSON body — use the 14-day default.
	}

	const results: Record<string, unknown> = {};
	const run = async (name: string, enabled: boolean, fn: (d: number) => Promise<unknown>) => {
		if (!enabled) {
			results[name] = { skipped: 'not configured' };
			return;
		}
		try {
			results[name] = await fn(days);
		} catch (e) {
			results[name] = { error: e instanceof Error ? e.message : 'sync failed' };
		}
	};

	await Promise.all([
		run('dexcom', dexcomEnabled(), syncGlucose),
		run('tandem', tandemEnabled(), syncInsulin),
		run('fitbit', googleHealthEnabled(), syncHealth)
	]);

	return json({ days, ...results });
}
