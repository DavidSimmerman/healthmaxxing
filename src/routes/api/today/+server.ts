import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { dailyLog, foods, settings } from '$lib/server/db/schema';
import { asc, eq } from 'drizzle-orm';
import { requireApiToken } from '$lib/server/auth';
import { loggedToday, todayLabel } from '$lib/server/day';
import { deficitDays } from '$lib/server/deficit';
import { fillBmrGaps } from '$lib/server/projections';

export async function GET({ request }) {
	requireApiToken(request);

	const entries = await db
		.select({
			id: dailyLog.id,
			loggedAt: dailyLog.loggedAt,
			servings: dailyLog.servings,
			calories: dailyLog.calories,
			proteinG: dailyLog.proteinG,
			carbsG: dailyLog.carbsG,
			fatG: dailyLog.fatG,
			foodName: foods.name
		})
		.from(dailyLog)
		.innerJoin(foods, eq(dailyLog.foodId, foods.id))
		.where(loggedToday())
		.orderBy(asc(dailyLog.loggedAt));

	const [s] = await db.select().from(settings).where(eq(settings.id, 1));

	const [day] = fillBmrGaps(await deficitDays(todayLabel(), todayLabel()));
	const burnedKcal = day?.burnedKcal ?? null;

	// Widget/app deficit: if still under the calorie goal, assume they'll eat up
	// to it (so the number doesn't look rosy mid-morning); if over, use actual
	// intake. Computed here so the widget and the app's drift check agree.
	const calSum = entries.reduce((sum, e) => sum + e.calories, 0);
	const calTarget = s?.calorieTarget ?? 2100;
	const deficit =
		burnedKcal != null ? Math.round(burnedKcal - Math.max(calSum, calTarget)) : null;

	return json({
		date: todayLabel(),
		entries,
		targets: s ?? null,
		burnedKcal,
		deficit
	});
}
