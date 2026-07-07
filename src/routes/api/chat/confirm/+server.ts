import { json, error } from '@sveltejs/kit';
import { createAndLogFood, prepFood, FoodInputError } from '$lib/server/foods';
import { bolusableCarbsPerServing } from '$lib/netCarbs';
import { getFiberMode } from '$lib/server/prefs';

// POST /api/chat/confirm  { kind: 'track'|'recipe'|'schedule', proposal }
// Executes a proposal the user confirmed in the chat UI. This is the ONLY place a chat
// action commits — the sidecar has no write tools, so nothing mutates until Confirm.
//
// track/schedule commit EXACTLY the macros shown on the card, as a single serving, so the
// logged entry always equals what the user saw (we never trust arbitrary payload macros or
// a servings multiplier). recipe is ingredient-derived (the card relabels to the authoritative
// per-serving macros after it's saved). Session-gated by hooks.
const r1 = (n: number) => Math.round(n * 10) / 10;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export async function POST({ request }) {
	const body = await request.json().catch(() => null);
	const kind = body?.kind;
	const p = body?.proposal;
	if (!p || typeof p !== 'object' || typeof p.name !== 'string' || !p.name.trim()) {
		throw error(400, 'proposal with a name is required');
	}
	if (kind !== 'track' && kind !== 'recipe' && kind !== 'schedule') {
		throw error(400, 'kind must be track, recipe, or schedule');
	}

	try {
		const fiberMode = await getFiberMode();

		if (kind === 'recipe') {
			const payload = (p.payload ?? {}) as Record<string, unknown>;
			const food = await prepFood({
				name: p.name,
				ingredients: (payload.ingredients as never) ?? null,
				makesServings: (payload.makesServings as number) ?? null,
				totalGrams: (payload.totalGrams as number) ?? null,
				source: 'ai_chat'
			});
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

		// track / schedule — log the card's macros verbatim, as one serving.
		const scheduleAt = kind === 'schedule' ? ((p.payload?.scheduleAt as string) ?? null) : null;
		const { food, logEntry } = await createAndLogFood({
			name: p.name,
			calories: num(p.calories),
			proteinG: num(p.proteinG),
			carbsG: num(p.carbsG),
			fatG: num(p.fatG),
			source: 'ai_chat',
			logToday: true,
			servings: 1,
			scheduleAt
		});
		if (!logEntry) throw new FoodInputError('nothing was logged');
		const b = bolusableCarbsPerServing(food, { fiberMode });
		return json({
			ok: true,
			kind,
			name: food.name,
			scheduled: !!logEntry.pending, // pending == scheduled for later
			macros: {
				calories: r1(logEntry.calories),
				proteinG: r1(logEntry.proteinG),
				carbsG: r1(logEntry.carbsG),
				fatG: r1(logEntry.fatG)
			},
			bolusableCarbsG: r1(b.bolusableCarbsG)
		});
	} catch (e) {
		if (e instanceof FoodInputError) throw error(400, e.message);
		throw e;
	}
}
