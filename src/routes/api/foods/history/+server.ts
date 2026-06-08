import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { foods, dailyLog } from '$lib/server/db/schema';
import { eq, sql, desc } from 'drizzle-orm';

// GET /api/foods/history
// Every distinct food you've ever logged, with per-serving macros plus the
// freshness signals the capture sheet needs: when it was last logged, how many
// times total, and how many times in the last 14 days (for the "popular" list).
// Session-gated like the rest of /api/* — browser-only, no Bearer token.
export async function GET() {
	const rows = await db
		.select({
			foodId: foods.id,
			name: foods.name,
			brand: foods.brand,
			servingSize: foods.servingSize,
			servingGrams: foods.servingGrams,
			calories: foods.calories,
			proteinG: foods.proteinG,
			carbsG: foods.carbsG,
			fatG: foods.fatG,
			categories: foods.categories,
			lastLoggedAt: sql<string>`max(${dailyLog.loggedAt})`,
			countTotal: sql<number>`(count(*))::int`,
			count14d: sql<number>`(count(*) filter (where ${dailyLog.loggedAt} >= now() - interval '14 days'))::int`
		})
		.from(dailyLog)
		.innerJoin(foods, eq(dailyLog.foodId, foods.id))
		.groupBy(foods.id)
		.orderBy(desc(sql`max(${dailyLog.loggedAt})`));

	return json({ foods: rows });
}
