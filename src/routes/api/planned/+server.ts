import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { foods, plannedMeals } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { toServings, type Unit } from '$lib/units';
import { todayLabel, APP_TZ } from '$lib/server/day';

// Schedule a meal for later today. Same food/serving resolution as POST /api/log,
// plus a `scheduledAt` (ISO) the meal is planned for — it lands in planned_meals,
// NOT daily_log, so it never counts as eaten until confirmed.
export async function POST({ request }) {
	const body = await request.json();
	const { foodId, amount, unit, scheduledAt } = body as {
		foodId: string;
		amount?: number;
		unit?: Unit;
		scheduledAt?: string;
	};
	if (!foodId) throw error(400, 'foodId required');

	// scheduledAt must parse and fall on today (APP_TZ) — you schedule for later
	// *today*, not arbitrary dates.
	const when = scheduledAt ? new Date(scheduledAt) : null;
	if (!when || Number.isNaN(when.getTime())) throw error(400, 'valid scheduledAt required');
	const onDay = new Intl.DateTimeFormat('en-CA', { timeZone: APP_TZ }).format(when);
	if (onDay !== todayLabel()) throw error(400, 'scheduledAt must be today');

	const [food] = await db.select().from(foods).where(eq(foods.id, foodId));
	if (!food) throw error(404, 'food not found');

	if (
		amount != null &&
		unit &&
		unit !== 'serving' &&
		!(food.servingGrams && food.servingGrams > 0)
	) {
		throw error(400, `Cannot schedule "${food.name}" by ${unit}: it has no serving weight.`);
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
		.insert(plannedMeals)
		.values({
			foodId,
			servings,
			amount: storedAmount,
			unit: storedUnit,
			scheduledAt: when,
			calories: food.calories * servings,
			proteinG: food.proteinG * servings,
			carbsG: food.carbsG * servings,
			fatG: food.fatG * servings
		})
		.returning();

	return json({ entry, foodName: food.name });
}
