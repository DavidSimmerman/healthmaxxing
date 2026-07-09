import { db } from '$lib/server/db';
import { dailyLog, foods, quickAdds, settings } from '$lib/server/db/schema';
import { asc, eq } from 'drizzle-orm';
import { loggedToday, todayLabel } from '$lib/server/day';
import { bolusableForLoggedEntry } from '$lib/netCarbs';
import { fiberModeFrom } from '$lib/server/prefs';
import { deficitDays } from '$lib/server/deficit';
import { dayMetricsForRange } from '$lib/server/goals';
import { scoreDay, weekBalances } from '$lib/score';
import { loadSpecsFor } from '$lib/server/vacations';
import { weekToDate } from '$lib/period';
import { addDays } from '$lib/energy';

export async function load() {
	const today = todayLabel();
	const weekStart = weekToDate(today).from;

	// One settings read per load: fiber mode is derived from the row and the row
	// is handed to deficitDays (which otherwise re-queries it).
	const settingsP = db
		.select()
		.from(settings)
		.where(eq(settings.id, 1))
		.then((rows) => rows[0] ?? null);

	// Today's deficit (assumes you eat up to your calorie budget — see deficitDays)
	// and today's goal score, for the two side rings on the home page. Both may be
	// null when the inputs aren't there yet; the rings render a dash, not a zero.
	// All of today's daily_log rows (eaten AND scheduled) in ONE query — split by
	// `pending` below instead of filtering twice in SQL. Everything here is
	// independent, so it all runs in parallel.
	const [settingsRow, rawToday, quickAddItems, [todayEnergy], dayMetrics, priorDays, specsFor] =
		await Promise.all([
			settingsP,
			db
				.select({
					id: dailyLog.id,
					pending: dailyLog.pending,
					servings: dailyLog.servings,
					amount: dailyLog.amount,
					unit: dailyLog.unit,
					loggedAt: dailyLog.loggedAt,
					calories: dailyLog.calories,
					proteinG: dailyLog.proteinG,
					carbsG: dailyLog.carbsG,
					fatG: dailyLog.fatG,
					foodId: foods.id,
					foodName: foods.name,
					foodServingSize: foods.servingSize,
					foodServingGrams: foods.servingGrams,
					foodCalories: foods.calories,
					foodProteinG: foods.proteinG,
					foodCarbsG: foods.carbsG,
					foodFatG: foods.fatG,
					foodNutrients: foods.nutrients,
					foodIngredients: foods.ingredients,
					foodMakesServings: foods.makesServings
				})
				.from(dailyLog)
				.innerJoin(foods, eq(dailyLog.foodId, foods.id))
				.where(loggedToday())
				.orderBy(asc(dailyLog.loggedAt)),
			db
				.select({
					id: quickAdds.id,
					foodId: foods.id,
					name: foods.name,
					calories: foods.calories,
					proteinG: foods.proteinG
				})
				.from(quickAdds)
				.innerJoin(foods, eq(quickAdds.foodId, foods.id))
				.orderBy(asc(quickAdds.sortOrder)),
			settingsP.then((s) => deficitDays(today, today, { settingsRow: s })),
			dayMetricsForRange(today, today),
			// Earlier days of this week, for today's bank/debt — so the home ring matches
			// the goals page's day-detail score (both bank-adjusted) instead of trailing it.
			today > weekStart ? dayMetricsForRange(weekStart, addDays(today, -1)) : Promise.resolve([]),
			loadSpecsFor()
		]);

	const fiberMode = fiberModeFrom(settingsRow);

	// Eaten meals: the non-pending rows, decorated with derived bolusable carbs.
	const todayEntries = rawToday.flatMap(({ pending, ...e }) => {
		if (pending) return [];
		const b = bolusableForLoggedEntry(
			e.carbsG,
			{
				nutrients: e.foodNutrients,
				ingredients: e.foodIngredients,
				makesServings: e.foodMakesServings
			},
			e.servings ?? 1,
			{ fiberMode }
		);
		return [{ ...e, bolusableCarbsG: b.bolusableCarbsG, bolusableLowConfidence: b.lowConfidence }];
	});

	// Meals scheduled for later today: pending daily_log rows. They already count
	// toward the day's metrics; here they're surfaced separately so the eaten list
	// stays clean and each can be confirmed (stamp the real time) or cancelled.
	const plannedToday = rawToday
		.filter((r) => r.pending)
		.map((r) => ({
			id: r.id,
			servings: r.servings,
			amount: r.amount,
			unit: r.unit,
			scheduledAt: r.loggedAt,
			calories: r.calories,
			proteinG: r.proteinG,
			carbsG: r.carbsG,
			fatG: r.fatG,
			foodName: r.foodName,
			foodServingSize: r.foodServingSize
		}));

	const goalScore = dayMetrics[0]
		? scoreDay(dayMetrics[0], weekBalances(priorDays, specsFor), specsFor(today)).score
		: null;

	return {
		settings: settingsRow ?? {
			calorieTarget: 2100,
			proteinTargetG: 180,
			carbsTargetG: 220,
			fatTargetG: 70
		},
		todayEntries,
		plannedMeals: plannedToday,
		quickAddItems,
		deficit: todayEnergy?.deficitKcal ?? null,
		// ponytail: default 500 kcal so the ring isn't dead before a target is set;
		// the Settings field overrides it.
		deficitTarget: settingsRow?.deficitTargetKcal ?? 500,
		goalScore
	};
}
