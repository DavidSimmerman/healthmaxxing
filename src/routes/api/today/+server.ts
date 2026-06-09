import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { dailyLog, foods, settings } from '$lib/server/db/schema';
import { asc, eq } from 'drizzle-orm';
import { requireApiToken } from '$lib/server/auth';
import { loggedToday, todayLabel } from '$lib/server/day';

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

	return json({
		date: todayLabel(),
		entries,
		targets: s ?? null
	});
}
