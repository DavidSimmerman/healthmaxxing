import { db } from '$lib/server/db';
import { settings, quickAdds, foods } from '$lib/server/db/schema';
import { asc, eq } from 'drizzle-orm';
import { authEnabled } from '$lib/server/session';

export async function load() {
	const [settingsRow] = await db.select().from(settings).where(eq(settings.id, 1));

	const quickAddItems = await db
		.select({
			id: quickAdds.id,
			sortOrder: quickAdds.sortOrder,
			foodId: foods.id,
			name: foods.name,
			brand: foods.brand,
			calories: foods.calories,
			proteinG: foods.proteinG
		})
		.from(quickAdds)
		.innerJoin(foods, eq(quickAdds.foodId, foods.id))
		.orderBy(asc(quickAdds.sortOrder));

	return {
		settings: settingsRow ?? {
			id: 1,
			calorieTarget: 2100,
			proteinTargetG: 180,
			carbsTargetG: 220,
			fatTargetG: 70
		},
		quickAddItems,
		authEnabled: authEnabled()
	};
}
