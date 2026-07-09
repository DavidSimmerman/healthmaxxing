import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { bodyComp, settings } from '$lib/server/db/schema';
import { requireApiToken } from '$lib/server/auth';
import { desc, eq } from 'drizzle-orm';

// Read-only profile for external integrations (e.g. the WalkingPad bridge) that need the
// CURRENT body weight to estimate calories, so they don't hardcode a value that goes stale
// as weight changes. Bearer API_TOKEN, same auth as the other /api/integrations endpoints.
// weightKg is the latest weigh-in; the rest are profile fields future HR-based estimators want.
export async function GET({ request }) {
	requireApiToken(request);

	const [latestRows, settingsRows] = await Promise.all([
		db
			.select({
				weightKg: bodyComp.weightKg,
				measuredAt: bodyComp.measuredAt,
				leanMassKg: bodyComp.leanMassKg
			})
			.from(bodyComp)
			.orderBy(desc(bodyComp.measuredAt))
			.limit(1),
		db
			.select({ heightCm: settings.heightCm, sex: settings.sex, birthDate: settings.birthDate })
			.from(settings)
			.where(eq(settings.id, 1))
	]);

	const latest = latestRows[0];
	if (!latest) throw error(404, 'no body-weight measurement yet');
	const s = settingsRows[0];

	return json({
		weightKg: latest.weightKg,
		weightMeasuredAt: latest.measuredAt,
		leanMassKg: latest.leanMassKg ?? null,
		heightCm: s?.heightCm ?? null,
		sex: s?.sex ?? null,
		birthDate: s?.birthDate ?? null
	});
}
