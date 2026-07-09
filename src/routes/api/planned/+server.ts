import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { foods, dailyLog } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import type { Unit } from '$lib/units';
import { FoodInputError, parseScheduleAt, resolveServings } from '$lib/server/foods';
import { UUID_RE } from '$lib/uuid';

// Schedule a meal for later today. Same food/serving resolution as POST /api/log,
// but the row lands in daily_log with pending=true and loggedAt = scheduledAt — so
// it already counts toward deficit / goals / macros. Confirming it later clears
// pending (and stamps the real eaten time); cancelling deletes the row.
export async function POST({ request }) {
	const body = await request.json();
	const { foodId, amount, unit, scheduledAt } = body as {
		foodId: string;
		amount?: number;
		unit?: Unit;
		scheduledAt?: string;
	};
	if (!foodId) throw error(400, 'foodId required');
	// Malformed uuid → clean 404, not a Postgres uuid-cast 500.
	if (!UUID_RE.test(foodId)) throw error(404, 'food not found');

	// scheduledAt must parse to a FUTURE time later today (APP_TZ) — parseScheduleAt
	// enforces both, matching the MCP scheduling path.
	let when: Date | undefined;
	try {
		when = parseScheduleAt(scheduledAt);
	} catch (e) {
		if (e instanceof FoodInputError) throw error(400, e.message);
		throw e;
	}
	if (!when) throw error(400, 'valid scheduledAt required');

	const [food] = await db.select().from(foods).where(eq(foods.id, foodId));
	if (!food) throw error(404, 'food not found');

	// Shared quantity resolution (rejects 0/negative/NaN amounts and servings,
	// unknown units, gram/volume logging without a serving weight) — same rules as
	// POST /api/log and the MCP log_food path.
	let resolved: ReturnType<typeof resolveServings>;
	try {
		resolved = resolveServings(food, { amount, unit, servings: body.servings });
	} catch (e) {
		if (e instanceof FoodInputError) throw error(400, e.message);
		throw e;
	}
	const { servings } = resolved;

	const [entry] = await db
		.insert(dailyLog)
		.values({
			foodId,
			servings,
			amount: resolved.amount,
			unit: resolved.unit,
			loggedAt: when,
			pending: true,
			calories: food.calories * servings,
			proteinG: food.proteinG * servings,
			carbsG: food.carbsG * servings,
			fatG: food.fatG * servings
		})
		.returning();

	return json({ entry, foodName: food.name });
}
