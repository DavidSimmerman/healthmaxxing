import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { foods, plannedMeals, dailyLog } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

// Remove a scheduled meal.
export async function DELETE({ params }) {
	const [gone] = await db.delete(plannedMeals).where(eq(plannedMeals.id, params.id)).returning();
	if (!gone) throw error(404, 'planned meal not found');
	return json({ ok: true });
}

// Confirm a scheduled meal: write it into daily_log at its scheduled time (so the
// entry keeps the dinner time, not "now"), then drop the planned row. One transaction
// so a crash can't both log it and leave the plan. Macros are recomputed from the
// current food — the single source of truth — matching POST /api/log.
export async function POST({ params }) {
	const [plan] = await db.select().from(plannedMeals).where(eq(plannedMeals.id, params.id));
	if (!plan) throw error(404, 'planned meal not found');

	const [food] = await db.select().from(foods).where(eq(foods.id, plan.foodId));
	if (!food) throw error(404, 'food not found');

	const s = plan.servings;
	const entry = await db.transaction(async (tx) => {
		const [logged] = await tx
			.insert(dailyLog)
			.values({
				foodId: plan.foodId,
				servings: s,
				amount: plan.amount,
				unit: plan.unit,
				loggedAt: plan.scheduledAt,
				calories: food.calories * s,
				proteinG: food.proteinG * s,
				carbsG: food.carbsG * s,
				fatG: food.fatG * s
			})
			.returning();
		await tx.delete(plannedMeals).where(eq(plannedMeals.id, params.id));
		return logged;
	});

	return json({ entry, foodName: food.name });
}
