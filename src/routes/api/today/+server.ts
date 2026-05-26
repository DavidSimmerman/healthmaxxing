import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { dailyLog, foods, settings } from '$lib/server/db/schema';
import { and, asc, eq, gte, lt } from 'drizzle-orm';
import { requireApiToken } from '$lib/server/auth';

export async function GET({ request }) {
	requireApiToken(request);
	const start = new Date();
	start.setHours(0, 0, 0, 0);
	const end = new Date(start);
	end.setDate(end.getDate() + 1);

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
		.where(and(gte(dailyLog.loggedAt, start), lt(dailyLog.loggedAt, end)))
		.orderBy(asc(dailyLog.loggedAt));

	const [s] = await db.select().from(settings).where(eq(settings.id, 1));

	return json({
		date: start.toISOString().slice(0, 10),
		entries,
		targets: s ?? null
	});
}
