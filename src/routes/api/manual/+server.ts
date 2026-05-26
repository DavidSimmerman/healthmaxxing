import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { foods, dailyLog, quickAdds } from '$lib/server/db/schema';

export async function POST({ request }) {
	const body = await request.json();
	const { name, servingSize, calories, proteinG, carbsG, fatG, pinToQuickAdds, logToday } = body;
	if (!name || calories == null) throw error(400, 'name and calories required');

	const [food] = await db
		.insert(foods)
		.values({
			name,
			servingSize: servingSize || null,
			calories,
			proteinG: proteinG ?? 0,
			carbsG: carbsG ?? 0,
			fatG: fatG ?? 0,
			source: 'manual'
		})
		.returning();

	if (logToday) {
		await db.insert(dailyLog).values({
			foodId: food.id,
			servings: 1,
			calories: food.calories,
			proteinG: food.proteinG,
			carbsG: food.carbsG,
			fatG: food.fatG
		});
	}

	if (pinToQuickAdds) {
		await db.insert(quickAdds).values({ foodId: food.id });
	}

	return json({ food });
}
