import { sql, eq, and, gte, lte } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { dailyLog, foods, dailyMetrics } from '$lib/server/db/schema';
import { APP_TZ } from '$lib/server/day';
import { scaleNutrients, sumNutrients, NUTRIENT_KEYS, type Nutrients } from '$lib/nutrients';

// Aggregate everything eaten over a date range, for the read-only MCP nutrition
// tool. Macros come from the cached per-entry totals on dailyLog (servings
// already applied at log time), while extended nutrients live per-serving on
// foods.nutrients and are scaled by each entry's servings before summing. Water
// comes from the HealthKit daily_metrics rows. Extended nutrients are only as
// complete as what's been logged per food, so a key is omitted entirely when no
// logged food carried it.

export type NutritionTotals = {
	calories: number;
	proteinG: number;
	carbsG: number;
	fatG: number;
	waterL: number;
} & Partial<Record<keyof Nutrients, number>>;

export type NutritionReport = {
	from: string;
	to: string;
	calendarDays: number;
	loggedDays: number;
	totals: NutritionTotals;
	dailyAvg: NutritionTotals;
};

function round1(n: number): number {
	return Math.round(n * 10) / 10;
}

// Aggregate intake for [from, to] inclusive (YYYY-MM-DD, APP_TZ local dates).
export async function nutritionReport(from: string, to: string): Promise<NutritionReport> {
	// Bucket each entry to its local calendar day, same expression deficit.ts uses.
	const logDate = sql<string>`(${dailyLog.loggedAt} at time zone 'UTC' at time zone ${APP_TZ})::date`;

	const [entries, waterRows] = await Promise.all([
		db
			.select({
				date: sql<string>`${logDate}::text`,
				servings: dailyLog.servings,
				calories: dailyLog.calories,
				proteinG: dailyLog.proteinG,
				carbsG: dailyLog.carbsG,
				fatG: dailyLog.fatG,
				nutrients: foods.nutrients
			})
			.from(dailyLog)
			.innerJoin(foods, eq(dailyLog.foodId, foods.id))
			.where(sql`${logDate} between ${from}::date and ${to}::date`),
		db
			.select({ date: dailyMetrics.date, value: dailyMetrics.value })
			.from(dailyMetrics)
			.where(
				and(
					eq(dailyMetrics.metric, 'water_l'),
					gte(dailyMetrics.date, from),
					lte(dailyMetrics.date, to)
				)
			)
	]);

	// Macro totals: dailyLog macros are entry totals — sum directly.
	let calories = 0;
	let proteinG = 0;
	let carbsG = 0;
	let fatG = 0;
	const loggedDates = new Set<string>();
	const scaledNutrients: (Partial<Nutrients> | null)[] = [];
	for (const e of entries) {
		calories += e.calories ?? 0;
		proteinG += e.proteinG ?? 0;
		carbsG += e.carbsG ?? 0;
		fatG += e.fatG ?? 0;
		loggedDates.add(e.date);
		// foods.nutrients is per-serving — scale by the entry's servings.
		scaledNutrients.push(scaleNutrients(e.nutrients, e.servings ?? 1));
	}
	const nutrientTotals = sumNutrients(scaledNutrients);

	const waterL = waterRows.reduce((a, r) => a + (r.value ?? 0), 0);
	// Water lives in daily_metrics, independent of food logging — average it over
	// the days water was actually recorded, not the food-logged days.
	const waterDays = new Set(waterRows.map((r) => r.date)).size;

	const loggedDays = loggedDates.size;
	const calendarDays =
		Math.round(
			(Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000
		) + 1;
	// Per-logged-day averages are more meaningful than per-calendar-day when the
	// user skips logging some days.
	const avgDivisor = Math.max(loggedDays, 1);

	const totals: NutritionTotals = {
		calories: round1(calories),
		proteinG: round1(proteinG),
		carbsG: round1(carbsG),
		fatG: round1(fatG),
		waterL: round1(waterL)
	};
	const dailyAvg: NutritionTotals = {
		calories: round1(calories / avgDivisor),
		proteinG: round1(proteinG / avgDivisor),
		carbsG: round1(carbsG / avgDivisor),
		fatG: round1(fatG / avgDivisor),
		waterL: round1(waterL / Math.max(waterDays, 1))
	};

	// Only surface a nutrient when at least one logged food carried it.
	if (nutrientTotals) {
		for (const key of NUTRIENT_KEYS) {
			const v = nutrientTotals[key];
			if (v == null) continue;
			totals[key] = round1(v);
			dailyAvg[key] = round1(v / avgDivisor);
		}
	}

	return { from, to, calendarDays, loggedDays, totals, dailyAvg };
}
