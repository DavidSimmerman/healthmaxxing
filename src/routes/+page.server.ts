import { db } from '$lib/server/db';
import { dailyLog, foods, quickAdds, settings } from '$lib/server/db/schema';
import { asc, eq } from 'drizzle-orm';
import { loggedToday } from '$lib/server/day';
import { bolusableForLoggedEntry } from '$lib/netCarbs';
import { getFiberMode } from '$lib/server/prefs';

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

	return {
		settings: settingsRow ?? {
			calorieTarget: 2100,
			proteinTargetG: 180,
			carbsTargetG: 220,
			fatTargetG: 70
		},
		todayEntries,
		quickAddItems
	};
}
