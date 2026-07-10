import { json, error } from '@sveltejs/kit';
import { requireApiToken } from '$lib/server/auth';
import { createAndLogFood, FoodInputError } from '$lib/server/foods';
import { bolusableCarbsPerServing, bolusableForLoggedEntry } from '$lib/netCarbs';
import { macroSanityNote } from '$lib/nutrients';
import { getFiberMode } from '$lib/server/prefs';

// POST /api/foods
// One-shot create-or-upsert a Food from an external resolver (Claude Code session).
// Body: {
//   name, brand?, barcode?,
//   servingSize?, servingGrams?,
//   calories, proteinG, carbsG, fatG,
//   nutrients?,            // optional Partial<Nutrients> bag
//   source?,               // 'claude_code' | 'label_ocr' | 'estimate' | 'manual' (default 'claude_code')
//   sourcePayload?,        // arbitrary JSON for provenance / debugging
//   resolverNote?,         // human-readable note; merged into sourcePayload.note
//   logToday?,             // boolean — if true, also append to today's daily_log
//   servings?,             // default 1, applied to logToday entry
//   pinToQuickAdds?        // boolean — pin a quick-add tile
// }
export async function POST({ request }) {
	requireApiToken(request);
	const body = await request.json();
	try {
		const { food, logEntry } = await createAndLogFood(body);
		const fiberMode = await getFiberMode();
		const perServing = bolusableCarbsPerServing(food, { fiberMode });
		const entryBolus = logEntry
			? bolusableForLoggedEntry(logEntry.carbsG, food, logEntry.servings ?? 1, { fiberMode })
			: null;
		return json({
			food: {
				...food,
				bolusableCarbsG: perServing.bolusableCarbsG,
				bolusableLowConfidence: perServing.lowConfidence,
				// Atwater warning (never a rejection) — per-serving label math cross-check.
				macroCheck: macroSanityNote(food, food.nutrients)
			},
			logEntry:
				logEntry && entryBolus
					? {
							...logEntry,
							bolusableCarbsG: entryBolus.bolusableCarbsG,
							bolusableLowConfidence: entryBolus.lowConfidence
						}
					: logEntry
		});
	} catch (e) {
		if (e instanceof FoodInputError) throw error(400, e.message);
		throw e;
	}
}
