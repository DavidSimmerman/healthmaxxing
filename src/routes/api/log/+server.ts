import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { foods, dailyLog } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { toServings, type Unit } from '$lib/units';

export async function POST({ request }) {
	const body = await request.json();
	const { foodId, amount, unit } = body as { foodId: string; amount?: number; unit?: Unit };
	if (!foodId) throw error(400, 'foodId required');

	const [food] = await db.select().from(foods).where(eq(foods.id, foodId));
	if (!food) throw error(404, 'food not found');

	let servings: number;
	let storedAmount: number | null;
	let storedUnit: Unit | null;
	if (amount != null && unit) {
		servings = toServings(amount, unit, food.servingGrams);
		storedAmount = amount;
		storedUnit = unit;
	} else {
		servings = body.servings ?? 1;
		storedAmount = null;
		storedUnit = null;
	}

	const [entry] = await db
		.insert(dailyLog)
		.values({
			foodId,
			servings,
			amount: storedAmount,
			unit: storedUnit,
			calories: food.calories * servings,
			proteinG: food.proteinG * servings,
			carbsG: food.carbsG * servings,
			fatG: food.fatG * servings
		})
		.returning();
	return json({ entry });
}
