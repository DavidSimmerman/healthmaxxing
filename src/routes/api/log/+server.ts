import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { foods, dailyLog } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

export async function POST({ request }) {
	const { foodId, servings = 1 } = await request.json();
	if (!foodId) throw error(400, 'foodId required');
	const [food] = await db.select().from(foods).where(eq(foods.id, foodId));
	if (!food) throw error(404, 'food not found');

	const [entry] = await db
		.insert(dailyLog)
		.values({
			foodId,
			servings,
			calories: food.calories * servings,
			proteinG: food.proteinG * servings,
			carbsG: food.carbsG * servings,
			fatG: food.fatG * servings
		})
		.returning();
	return json({ entry });
}
