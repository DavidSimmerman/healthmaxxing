import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { foods, dailyLog } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import type { Unit } from '$lib/units';
import { bolusableForLoggedEntry } from '$lib/netCarbs';
import { getFiberMode } from '$lib/server/prefs';
import { FoodInputError, resolveServings } from '$lib/server/foods';
import { UUID_RE } from '$lib/uuid';

export async function POST({ request }) {
	const body = await request.json();
	const { foodId, amount, unit, loggedAt } = body as {
		foodId: string;
		amount?: number;
		unit?: Unit;
		loggedAt?: string;
	};
	if (!foodId) throw error(400, 'foodId required');
	// Malformed uuid → clean 404, not a Postgres uuid-cast 500.
	if (!UUID_RE.test(foodId)) throw error(404, 'food not found');

	// Optional explicit log time (past/now). A future time belongs on /api/planned
	// as a pending row, so reject it here to keep logged rows non-future.
	let when: Date | undefined;
	if (loggedAt != null) {
		when = new Date(loggedAt);
		if (Number.isNaN(when.getTime())) throw error(400, 'valid loggedAt required');
		if (when.getTime() > Date.now())
			throw error(400, 'loggedAt cannot be in the future — schedule it instead');
	}

	const [food] = await db.select().from(foods).where(eq(foods.id, foodId));
	if (!food) throw error(404, 'food not found');

	// Shared quantity resolution (rejects 0/negative/NaN amounts and servings,
	// unknown units, gram/volume logging without a serving weight) — same rules as
	// the MCP log_food path, so validation can't drift between them.
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
			...(when ? { loggedAt: when } : {}),
			calories: food.calories * servings,
			proteinG: food.proteinG * servings,
			carbsG: food.carbsG * servings,
			fatG: food.fatG * servings
		})
		.returning();

	const b = bolusableForLoggedEntry(entry.carbsG, food, servings, {
		fiberMode: await getFiberMode()
	});
	return json({
		entry,
		foodName: food.name,
		bolusableCarbsG: b.bolusableCarbsG,
		bolusableLowConfidence: b.lowConfidence
	});
}
