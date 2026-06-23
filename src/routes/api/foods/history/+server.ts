import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { foods, dailyLog } from '$lib/server/db/schema';
import { eq, sql, desc, isNull } from 'drizzle-orm';
import { bolusableCarbsPerServing } from '$lib/netCarbs';
import { getFiberMode } from '$lib/server/prefs';

// GET /api/foods/history
// Every food in the catalog the capture sheet can offer — including ones that were
// meal-prepped but never logged (LEFT JOIN, so they still appear with a null
// lastLoggedAt). Archived (deleted-from-search) foods are excluded. Carries the
// per-serving macros plus freshness signals for the "popular" list and the recipe
// fields the detail view needs. Session-gated like the rest of /api/* — browser-only.
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
			nutrients: foods.nutrients,
			categories: foods.categories,
			ingredients: foods.ingredients,
			makesServings: foods.makesServings,
			totalGrams: foods.totalGrams,
			lastLoggedAt: sql<string | null>`max(${dailyLog.loggedAt})`,
			countTotal: sql<number>`(count(${dailyLog.id}))::int`,
			count14d: sql<number>`(count(${dailyLog.id}) filter (where ${dailyLog.loggedAt} >= now() - interval '14 days'))::int`
		})
		.from(foods)
		.leftJoin(dailyLog, eq(dailyLog.foodId, foods.id))
		.where(isNull(foods.archivedAt))
		.groupBy(foods.id)
		// Sort by most recent activity — last logged, or when prepped/edited if never logged.
		.orderBy(desc(sql`coalesce(max(${dailyLog.loggedAt}), ${foods.updatedAt})`));

	// Decorate each food with derived per-serving bolusable (net glycemic) carbs.
	const fiberMode = await getFiberMode();
	const withBolusable = rows.map((r) => {
		const b = bolusableCarbsPerServing(r, { fiberMode });
		return { ...r, bolusableCarbsG: b.bolusableCarbsG, bolusableLowConfidence: b.lowConfidence };
	});

	return json({ foods: withBolusable });
}
