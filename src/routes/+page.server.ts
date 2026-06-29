import { db } from '$lib/server/db';
import { dailyLog, foods, plannedMeals, quickAdds, settings } from '$lib/server/db/schema';
import { asc, eq, sql } from 'drizzle-orm';
import { loggedToday, todayLabel, APP_TZ } from '$lib/server/day';
import { bolusableForLoggedEntry } from '$lib/netCarbs';
import { getFiberMode } from '$lib/server/prefs';
import { deficitDays } from '$lib/server/deficit';
import { dayMetricsForRange } from '$lib/server/goals';
import { scoreDay } from '$lib/score';

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
		.where(loggedToday())
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

	// Meals scheduled for later today (not yet confirmed → not in daily_log). They
	// fold into the calorie/protein "remaining" so it reads as room left for snacks.
	const plannedToday = await db
		.select({
			id: plannedMeals.id,
			servings: plannedMeals.servings,
			amount: plannedMeals.amount,
			unit: plannedMeals.unit,
			scheduledAt: plannedMeals.scheduledAt,
			calories: plannedMeals.calories,
			proteinG: plannedMeals.proteinG,
			carbsG: plannedMeals.carbsG,
			fatG: plannedMeals.fatG,
			foodName: foods.name,
			foodServingSize: foods.servingSize
		})
		.from(plannedMeals)
		.innerJoin(foods, eq(plannedMeals.foodId, foods.id))
		.where(
			sql`(${plannedMeals.scheduledAt} at time zone 'UTC' at time zone ${APP_TZ})::date = (now() at time zone ${APP_TZ})::date`
		)
		.orderBy(asc(plannedMeals.scheduledAt));

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
	const [[todayEnergy], dayMetrics] = await Promise.all([
		deficitDays(today, today),
		dayMetricsForRange(today, today)
	]);
	const goalScore = dayMetrics[0] ? scoreDay(dayMetrics[0]).score : null;

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
