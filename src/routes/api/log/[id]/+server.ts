import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { dailyLog, foods } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { toServings, type Unit } from '$lib/units';

export async function DELETE({ params }) {
	const [deleted] = await db.delete(dailyLog).where(eq(dailyLog.id, params.id)).returning();
	if (!deleted) throw error(404, 'entry not found');
	return json({ ok: true });
}

export async function PATCH({ params, request }) {
	const body = await request.json();
	const { amount, unit } = body as { amount: number; unit: Unit };
	if (amount == null || !unit) throw error(400, 'amount and unit required');

	const [entry] = await db.select().from(dailyLog).where(eq(dailyLog.id, params.id));
	if (!entry) throw error(404, 'entry not found');

	const [food] = await db.select().from(foods).where(eq(foods.id, entry.foodId));
	if (!food) throw error(404, 'food not found');

	const servings = toServings(amount, unit, food.servingGrams);

	const [updated] = await db
		.update(dailyLog)
		.set({
			amount,
			unit,
			servings,
			calories: food.calories * servings,
			proteinG: food.proteinG * servings,
			carbsG: food.carbsG * servings,
			fatG: food.fatG * servings
		})
		.where(eq(dailyLog.id, params.id))
		.returning();

	return json({ entry: updated });
}
