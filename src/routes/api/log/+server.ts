import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { foods, dailyLog } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { toServings, type Unit } from '$lib/units';
import { bolusableForLoggedEntry } from '$lib/netCarbs';
import { getFiberMode } from '$lib/server/prefs';

export async function POST({ request }) {
	const body = await request.json();
	const { foodId, amount, unit } = body as { foodId: string; amount?: number; unit?: Unit };
	if (!foodId) throw error(400, 'foodId required');

	const [food] = await db.select().from(foods).where(eq(foods.id, foodId));
	if (!food) throw error(404, 'food not found');

	// Gram/volume units need a serving weight to convert; without one, toServings
	// would treat the amount as servings (188g → 188 servings). A food can lose its
	// serving weight after a barcode source sync, so reject rather than misread it.
	if (
		amount != null &&
		unit &&
		unit !== 'serving' &&
		!(food.servingGrams && food.servingGrams > 0)
	) {
		throw error(400, `Cannot log "${food.name}" by ${unit}: it has no serving weight.`);
	}

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

	const b = bolusableForLoggedEntry(entry.carbsG, food.nutrients, servings, {
		fiberMode: await getFiberMode()
	});
	return json({
		entry,
		foodName: food.name,
		bolusableCarbsG: b.bolusableCarbsG,
		bolusableLowConfidence: b.lowConfidence
	});
}
