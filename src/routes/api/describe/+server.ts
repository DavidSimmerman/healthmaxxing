import { json, error } from '@sveltejs/kit';
import { describeFood } from '$lib/server/agent';
import { createAndLogFood, FoodInputError } from '$lib/server/foods';
import { bolusableCarbsPerServing } from '$lib/netCarbs';
import { macroSanityNote } from '$lib/nutrients';
import { getFiberMode } from '$lib/server/prefs';

// POST /api/describe  { image?: dataURL|base64, mediaType?, text? }
// Claude identifies the food, we persist it as a Food (not logged), and return the
// row shaped for the capture sheet to stage — same fields BarcodeScan returns.
// Session-gated by hooks.server.ts like the rest of /api/*.
export async function POST({ request }) {
	const body = await request.json().catch(() => null);
	if (!body || (typeof body.image !== 'string' && typeof body.text !== 'string')) {
		throw error(400, 'provide an image and/or text');
	}

	let described;
	try {
		described = await describeFood({
			image: body.image,
			mediaType: body.mediaType,
			text: body.text
		});
	} catch (e) {
		throw error(502, `describe failed: ${(e as Error).message}`);
	}

	try {
		const { food } = await createAndLogFood({ ...described, logToday: false });
		const fiberMode = await getFiberMode();
		const b = bolusableCarbsPerServing(food, { fiberMode });
		return json({
			food: {
				id: food.id,
				name: food.name,
				brand: food.brand,
				servingSize: food.servingSize,
				servingGrams: food.servingGrams,
				calories: food.calories,
				proteinG: food.proteinG,
				carbsG: food.carbsG,
				fatG: food.fatG,
				bolusableCarbsG: b.bolusableCarbsG,
				bolusableLowConfidence: b.lowConfidence,
				// Atwater warning (never a rejection) — per-serving label math cross-check.
				macroCheck: macroSanityNote(food, food.nutrients),
				source: described.source
			}
		});
	} catch (e) {
		if (e instanceof FoodInputError) throw error(400, e.message);
		throw e;
	}
}
