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
	const { amount, unit, loggedAt } = body as { amount: number; unit: Unit; loggedAt?: string };
	if (amount == null || !unit) throw error(400, 'amount and unit required');

	// Optional time edit (keeps the entry's date; only H:M change from the client).
	let when: Date | undefined;
	if (loggedAt != null) {
		when = new Date(loggedAt);
		if (Number.isNaN(when.getTime())) throw error(400, 'valid loggedAt required');
		// Logged (non-pending) rows must not be in the future — that's the planned flow.
		if (when.getTime() > Date.now()) throw error(400, 'loggedAt cannot be in the future');
	}

	const [entry] = await db.select().from(dailyLog).where(eq(dailyLog.id, params.id));
	if (!entry) throw error(404, 'entry not found');

	const [food] = await db.select().from(foods).where(eq(foods.id, entry.foodId));
	if (!food) throw error(404, 'food not found');

	// Gram/volume units need a serving weight to convert; without one, toServings
	// would silently treat the amount as servings (188g → 188 servings). A food can
	// lose its serving weight after a source sync, so guard here rather than trust it.
	if (unit !== 'serving' && !(food.servingGrams && food.servingGrams > 0)) {
		throw error(400, `Cannot log "${food.name}" by ${unit}: it has no serving weight.`);
	}

	const servings = toServings(amount, unit, food.servingGrams);

	const [updated] = await db
		.update(dailyLog)
		.set({
			amount,
			unit,
			servings,
			...(when ? { loggedAt: when } : {}),
			calories: food.calories * servings,
			proteinG: food.proteinG * servings,
			carbsG: food.carbsG * servings,
			fatG: food.fatG * servings
		})
		.where(eq(dailyLog.id, params.id))
		.returning();

	return json({ entry: updated });
}
