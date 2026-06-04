import { db } from '$lib/server/db';
import { dailyLog, foods, quickAdds, settings, pendingItems } from '$lib/server/db/schema';
import { and, asc, desc, eq, gte, lt } from 'drizzle-orm';

function startOfToday(): Date {
	const d = new Date();
	d.setHours(0, 0, 0, 0);
	return d;
}
function startOfTomorrow(): Date {
	const d = startOfToday();
	d.setDate(d.getDate() + 1);
	return d;
}

export async function load() {
	const [settingsRow] = await db.select().from(settings).where(eq(settings.id, 1));

	const todayEntries = await db
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
			foodFatG: foods.fatG
		})
		.from(dailyLog)
		.innerJoin(foods, eq(dailyLog.foodId, foods.id))
		.where(and(gte(dailyLog.loggedAt, startOfToday()), lt(dailyLog.loggedAt, startOfTomorrow())))
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

	const pendingCount = await db
		.select({ id: pendingItems.id })
		.from(pendingItems)
		.where(eq(pendingItems.status, 'pending'));

	return {
		settings: settingsRow ?? {
			calorieTarget: 2100,
			proteinTargetG: 180,
			carbsTargetG: 220,
			fatTargetG: 70
		},
		todayEntries,
		quickAddItems,
		pendingCount: pendingCount.length
	};
}
