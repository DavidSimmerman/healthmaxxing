import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { foods, pendingItems, dailyLog } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { requireApiToken } from '$lib/server/auth';
import { sanitizeNutrients } from '$lib/nutrients';

// POST /api/pending/:id/resolve
// Called by Claude Code after it figures out what a pending item actually is.
// Body: {
//   name, brand?, servingSize?, servingGrams?,
//   calories, proteinG, carbsG, fatG,
//   source: 'claude_code' | 'estimate' | 'label_ocr',
//   resolverNote?: string,
//   logToday?: boolean
// }
export async function POST({ params, request }) {
	requireApiToken(request);

	const [pending] = await db.select().from(pendingItems).where(eq(pendingItems.id, params.id));
	if (!pending) throw error(404, 'pending item not found');
	if (pending.status === 'resolved') throw error(409, 'already resolved');

	const body = await request.json();
	const {
		name,
		brand,
		servingSize,
		servingGrams,
		calories,
		proteinG,
		carbsG,
		fatG,
		nutrients,
		source = 'claude_code',
		resolverNote,
		logToday = false
	} = body;

	if (!name || calories == null) throw error(400, 'name and calories required');

	const cleanNutrients = sanitizeNutrients(nutrients);

	const [food] = await db
		.insert(foods)
		.values({
			name,
			brand: brand ?? null,
			barcode: pending.barcode ?? null,
			servingSize: servingSize ?? null,
			servingGrams: servingGrams ?? null,
			calories,
			proteinG: proteinG ?? 0,
			carbsG: carbsG ?? 0,
			fatG: fatG ?? 0,
			nutrients: cleanNutrients,
			source
		})
		.onConflictDoUpdate({
			target: foods.barcode,
			set: {
				name,
				brand: brand ?? null,
				calories,
				proteinG,
				carbsG,
				fatG,
				nutrients: cleanNutrients,
				source
			}
		})
		.returning();

	await db
		.update(pendingItems)
		.set({
			status: 'resolved',
			resolvedFoodId: food.id,
			resolverNote: resolverNote ?? null,
			resolvedAt: new Date()
		})
		.where(eq(pendingItems.id, pending.id));

	if (logToday) {
		const servings = pending.servings ?? 1;
		await db.insert(dailyLog).values({
			foodId: food.id,
			servings,
			calories: food.calories * servings,
			proteinG: food.proteinG * servings,
			carbsG: food.carbsG * servings,
			fatG: food.fatG * servings
		});
	}

	return json({ food, pending: { ...pending, status: 'resolved' } });
}
