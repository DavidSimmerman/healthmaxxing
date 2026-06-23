// Extended nutrient bag, per serving. All fields optional — only stored when known.
// Saved on foods.nutrients for later AI analysis; not displayed in the UI.
export type Nutrients = {
	// Carbohydrate breakdown
	fiberG: number;
	sugarG: number;
	addedSugarG: number;
	sugarAlcoholG: number;
	// Fat breakdown
	satFatG: number;
	transFatG: number;
	monoFatG: number;
	polyFatG: number;
	omega3G: number;
	omega6G: number;
	cholesterolMg: number;
	// Minerals
	sodiumMg: number;
	potassiumMg: number;
	calciumMg: number;
	ironMg: number;
	magnesiumMg: number;
	zincMg: number;
	phosphorusMg: number;
	// Vitamins
	vitAUg: number;
	vitCMg: number;
	vitDUg: number;
	vitEMg: number;
	vitKUg: number;
	vitB6Mg: number;
	vitB12Ug: number;
	folateUg: number;
	// Other
	caffeineMg: number;
	alcoholG: number;
};

export const NUTRIENT_KEYS: readonly (keyof Nutrients)[] = [
	'fiberG',
	'sugarG',
	'addedSugarG',
	'sugarAlcoholG',
	'satFatG',
	'transFatG',
	'monoFatG',
	'polyFatG',
	'omega3G',
	'omega6G',
	'cholesterolMg',
	'sodiumMg',
	'potassiumMg',
	'calciumMg',
	'ironMg',
	'magnesiumMg',
	'zincMg',
	'phosphorusMg',
	'vitAUg',
	'vitCMg',
	'vitDUg',
	'vitEMg',
	'vitKUg',
	'vitB6Mg',
	'vitB12Ug',
	'folateUg',
	'caffeineMg',
	'alcoholG'
] as const;

// Scale every known nutrient by a factor (e.g. per-serving → per-100g). Returns
// null when there's nothing to scale, so callers can store null instead of {}.
export function scaleNutrients(
	input: Partial<Nutrients> | null | undefined,
	factor: number
): Partial<Nutrients> | null {
	if (!input || !Number.isFinite(factor)) return null;
	const out: Partial<Nutrients> = {};
	for (const key of NUTRIENT_KEYS) {
		const v = input[key];
		if (typeof v === 'number' && Number.isFinite(v)) {
			const scaled = v * factor;
			if (Number.isFinite(scaled) && scaled >= 0) out[key] = scaled;
		}
	}
	return Object.keys(out).length > 0 ? out : null;
}

// Sum several nutrient bags into one (e.g. a recipe's ingredients → whole-recipe
// totals). Returns null when nothing valid, so callers can store null instead of {}.
export function sumNutrients(
	inputs: (Partial<Nutrients> | null | undefined)[]
): Partial<Nutrients> | null {
	const out: Partial<Nutrients> = {};
	for (const input of inputs) {
		if (!input || typeof input !== 'object') continue;
		for (const key of NUTRIENT_KEYS) {
			const v = input[key];
			if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
				out[key] = (out[key] ?? 0) + v;
			}
		}
	}
	return Object.keys(out).length > 0 ? out : null;
}

// Overlay a patch onto an existing nutrient bag, key by key. Patch values win;
// existing keys the patch doesn't mention are kept. Both sides are sanitized, so
// junk/negative values are dropped. Used to back-correct a food's stored nutrients
// (e.g. fill in vitamins OFF lacked) without resending the keys already known.
// Returns null only when the merged result is empty.
export function mergeNutrients(
	base: Partial<Nutrients> | null | undefined,
	patch: Partial<Nutrients> | null | undefined
): Partial<Nutrients> | null {
	const out = { ...(sanitizeNutrients(base) ?? {}), ...(sanitizeNutrients(patch) ?? {}) };
	return Object.keys(out).length > 0 ? out : null;
}

// Share (0–1) of `totalCalories` coming from food that actually recorded each
// nutrient — a confidence signal so a sparsely-attached micronutrient reads as
// "unknown", not "deficient". Calorie-weighted: a nutrient present on foods making up
// 90% of intake is trustworthy; present on 2% is not. For a recipe, the food's
// aggregated bag has a key if ANY ingredient recorded it, which would overstate
// coverage — so a recipe is weighted by the share of its ingredient calories that
// recorded the nutrient. Only keys present on at least one entry are returned (same
// set the totals carry).
export function nutrientCoverage(
	entries: {
		calories: number | null;
		nutrients: Partial<Nutrients> | null | undefined;
		ingredients?: { calories: number; nutrients?: Partial<Nutrients> | null }[] | null;
	}[],
	totalCalories: number
): Partial<Record<keyof Nutrients, number>> {
	const coveredCal: Partial<Record<keyof Nutrients, number>> = {};
	const recorded = new Set<keyof Nutrients>();
	// A source that recorded the key always marks it recorded; its calories (0 for a
	// supplement) add to the covered tally. So a nutrient logged only from zero-calorie
	// items reads as fully covered (an explicit, trusted value), never as missing.
	const note = (key: keyof Nutrients, cal: number) => {
		recorded.add(key);
		if (cal > 0) coveredCal[key] = (coveredCal[key] ?? 0) + cal;
	};

	for (const e of entries) {
		const cal = e.calories ?? 0;
		const ings = e.ingredients;
		if (ings && ings.length > 0) {
			// Recipe: weight by the share of ingredient calories that recorded each key.
			const totalIng = ings.reduce((a, i) => a + (i.calories > 0 ? i.calories : 0), 0);
			for (const key of NUTRIENT_KEYS) {
				let hitCal = 0;
				let present = false;
				for (const i of ings) {
					if (typeof i.nutrients?.[key] === 'number') {
						present = true;
						if (i.calories > 0) hitCal += i.calories;
					}
				}
				if (present) note(key, totalIng > 0 ? cal * (hitCal / totalIng) : 0);
			}
		} else if (e.nutrients) {
			for (const key of NUTRIENT_KEYS) {
				if (typeof e.nutrients[key] === 'number') note(key, cal);
			}
		}
	}

	const out: Partial<Record<keyof Nutrients, number>> = {};
	for (const key of recorded) {
		const cc = coveredCal[key] ?? 0;
		// Calorie-weighted share where there are calories to weight; otherwise (only
		// zero-calorie sources) the value is explicitly logged → full confidence.
		out[key] = totalCalories > 0 && cc > 0 ? Math.round((cc / totalCalories) * 100) / 100 : 1;
	}
	return out;
}

// Validate + strip an arbitrary object down to known nutrient keys with finite-number values.
// Returns null when nothing valid remains, so callers can store null instead of {}.
export function sanitizeNutrients(input: unknown): Partial<Nutrients> | null {
	if (!input || typeof input !== 'object') return null;
	const out: Partial<Nutrients> = {};
	const src = input as Record<string, unknown>;
	for (const key of NUTRIENT_KEYS) {
		const v = src[key];
		if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
			out[key] = v;
		}
	}
	return Object.keys(out).length > 0 ? out : null;
}
