import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { dailyLog, foods } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import type { Unit } from '$lib/units';
import { FoodInputError, resolveServings } from '$lib/server/foods';
import { UUID_RE } from '$lib/uuid';

export async function DELETE({ params }) {
	// Malformed uuid → clean 404, not a Postgres uuid-cast 500.
	if (!UUID_RE.test(params.id)) throw error(404, 'entry not found');
	const [deleted] = await db.delete(dailyLog).where(eq(dailyLog.id, params.id)).returning();
	if (!deleted) throw error(404, 'entry not found');
	return json({ ok: true });
}

export async function PATCH({ params, request }) {
	if (!UUID_RE.test(params.id)) throw error(404, 'entry not found');
	const body = await request.json();
	const { amount, unit, loggedAt } = body as { amount: number; unit: Unit; loggedAt?: string };
	if (typeof amount !== 'number' || !Number.isFinite(amount) || !unit)
		throw error(400, 'amount and unit required');

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

	// Shared quantity resolution (rejects 0/negative amounts, unknown units,
	// gram/volume logging without a serving weight) — same rules as the MCP path.
	let resolved: ReturnType<typeof resolveServings>;
	try {
		resolved = resolveServings(food, { amount, unit });
	} catch (e) {
		if (e instanceof FoodInputError) throw error(400, e.message);
		throw e;
	}
	const { servings } = resolved;

	const [updated] = await db
		.update(dailyLog)
		.set({
			amount: resolved.amount,
			unit: resolved.unit,
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
