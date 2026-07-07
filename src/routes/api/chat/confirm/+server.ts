import { json, error } from '@sveltejs/kit';
import { createAndLogFood, prepFood, FoodInputError } from '$lib/server/foods';
import { bolusableCarbsPerServing } from '$lib/netCarbs';
import { getFiberMode } from '$lib/server/prefs';

// POST /api/chat/confirm  { kind: 'track'|'recipe'|'schedule', payload }
// Executes a proposal the user confirmed in the chat UI, reusing the same food logic as
// the rest of the app. This is the ONLY place a chat action commits — the sidecar has no
// write tools, so nothing mutates until the user taps Confirm and this runs. Session-gated.
const r1 = (n: number) => Math.round(n * 10) / 10;

export async function POST({ request }) {
	const body = await request.json().catch(() => null);
	const kind = body?.kind;
	const payload = body?.payload;
	if (!payload || typeof payload !== 'object') throw error(400, 'payload required');
	if (kind !== 'track' && kind !== 'recipe' && kind !== 'schedule') {
		throw error(400, 'kind must be track, recipe, or schedule');
	}

	try {
		const fiberMode = await getFiberMode();

		if (kind === 'recipe') {
			// Create/update the recipe food (not logged). Per-serving macros are derived from
			// the ingredient contributions ÷ makesServings inside prepFood.
			const food = await prepFood(payload);
			const b = bolusableCarbsPerServing(food, { fiberMode });
			return json({
				ok: true,
				kind,
				name: food.name,
				perServing: true,
				makesServings: food.makesServings ?? null,
				macros: {
					calories: r1(food.calories),
					proteinG: r1(food.proteinG),
					carbsG: r1(food.carbsG),
					fatG: r1(food.fatG)
				},
				bolusableCarbsG: r1(b.bolusableCarbsG)
			});
		}

		// track = log now; schedule = log with scheduleAt (pending). Both need logToday so the
		// dailyLog row (with its authoritative totals) is written.
		const { food, logEntry } = await createAndLogFood({ ...payload, logToday: true });
		if (!logEntry) throw new FoodInputError('nothing was logged');
		const servings = logEntry.servings ?? payload.servings ?? 1;
		const b = bolusableCarbsPerServing(food, { fiberMode });
		return json({
			ok: true,
			kind,
			name: food.name,
			// Reflect what actually happened: pending == scheduled for later.
			scheduled: !!logEntry.pending,
			// logEntry.{calories,…} are the exact totals written to the day log.
			macros: {
				calories: r1(logEntry.calories),
				proteinG: r1(logEntry.proteinG),
				carbsG: r1(logEntry.carbsG),
				fatG: r1(logEntry.fatG)
			},
			bolusableCarbsG: r1(b.bolusableCarbsG * servings)
		});
	} catch (e) {
		if (e instanceof FoodInputError) throw error(400, e.message);
		throw e;
	}
}
