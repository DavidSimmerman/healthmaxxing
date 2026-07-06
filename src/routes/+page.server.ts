import { db } from '$lib/server/db';
import { dailyLog, foods, quickAdds, settings } from '$lib/server/db/schema';
import { and, asc, eq } from 'drizzle-orm';
import { loggedToday, todayLabel } from '$lib/server/day';
import { bolusableForLoggedEntry } from '$lib/netCarbs';
import { getFiberMode } from '$lib/server/prefs';
import { deficitDays } from '$lib/server/deficit';
import { dayMetricsForRange } from '$lib/server/goals';
import { scoreDay, weekBalances } from '$lib/score';
import { loadSpecsFor } from '$lib/server/vacations';
import { weekToDate } from '$lib/period';
import { addDays } from '$lib/energy';

export async function load() {
	const [settingsRow] = await db.select().from(settings).where(eq(settings.id, 1));
	const fiberMode = await getFiberMode();

	const rawEntries = await db
		.select({
			id: dailyLog.id,
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
		.where(and(loggedToday(), eq(dailyLog.pending, false)))
		.orderBy(asc(dailyLog.loggedAt));

	const todayEntries = rawEntries.map((e) => {
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
		return { ...e, bolusableCarbsG: b.bolusableCarbsG, bolusableLowConfidence: b.lowConfidence };
	});

	// Meals scheduled for later today: pending daily_log rows. They already count
	// toward the day's metrics; here they're surfaced separately so the eaten list
	// stays clean and each can be confirmed (stamp the real time) or cancelled.
	const plannedToday = await db
		.select({
			id: dailyLog.id,
			servings: dailyLog.servings,
			amount: dailyLog.amount,
			unit: dailyLog.unit,
			scheduledAt: dailyLog.loggedAt,
			calories: dailyLog.calories,
			proteinG: dailyLog.proteinG,
			carbsG: dailyLog.carbsG,
			fatG: dailyLog.fatG,
			foodName: foods.name,
			foodServingSize: foods.servingSize
		})
		.from(dailyLog)
		.innerJoin(foods, eq(dailyLog.foodId, foods.id))
		.where(and(loggedToday(), eq(dailyLog.pending, true)))
		.orderBy(asc(dailyLog.loggedAt));

	const quickAddItems = await db
		.select({
			id: quickAdds.id,
			foodId: foods.id,
			name: foods.name,
			calories: foods.calories,
			proteinG: foods.proteinG
		})
		.from(quickAdds)
		.innerJoin(foods, eq(quickAdds.foodId, foods.id))
		.orderBy(asc(quickAdds.sortOrder));

	// Today's deficit (assumes you eat up to your calorie budget — see deficitDays)
	// and today's goal score, for the two side rings on the home page. Both may be
	// null when the inputs aren't there yet; the rings render a dash, not a zero.
	const today = todayLabel();
	const weekStart = weekToDate(today).from;
	const [[todayEnergy], dayMetrics, priorDays] = await Promise.all([
		deficitDays(today, today),
		dayMetricsForRange(today, today),
		// Earlier days of this week, for today's bank/debt — so the home ring matches
		// the goals page's day-detail score (both bank-adjusted) instead of trailing it.
		today > weekStart ? dayMetricsForRange(weekStart, addDays(today, -1)) : Promise.resolve([])
	]);
	const specsFor = await loadSpecsFor();
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
