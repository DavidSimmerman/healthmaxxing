// Bolusable (net glycemic) carbs — the single source of truth for the number
// David doses insulin off of. Derived, never stored: store total carbs + the
// subtractable components (fiber, sugar alcohols) and compute the dose-relevant
// figure here, so every food — scanned, hand-logged, or recipe — uses one formula
// and a settings change recomputes the whole history.
//
// SAFETY: when data is uncertain we UNDER-subtract (→ slightly higher carbs),
// because over-estimating carbs is the safe direction for an insulin-dosing input.
// The fiber mode and polyol factors below are a CLINICAL CALIBRATION — review them
// with a care team and validate against CGM traces; they are not medical fact.
import type { Nutrients } from './nutrients.ts';

export type FiberMode = 'full' | 'half_over_5';

export type PolyolType =
	| 'erythritol'
	| 'allulose'
	| 'xylitol'
	| 'sorbitol'
	| 'mannitol'
	| 'maltitol'
	| 'unknown';

// Fraction of a sugar alcohol that is NON-glycemic (i.e. subtractable). Polyols
// vary: erythritol/allulose pass through (~100%), most others ~50%, and maltitol
// is the high-GI one — still only ~50%, never subtract it fully. Default 'unknown'
// = 0.5 (conservative: under-subtracts).
export const POLYOL_FACTOR: Record<PolyolType, number> = {
	erythritol: 1,
	allulose: 1,
	xylitol: 0.5,
	sorbitol: 0.5,
	mannitol: 0.5,
	maltitol: 0.5,
	unknown: 0.5
};

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

// Grams of fiber to subtract under the chosen mode.
//  full        → subtract all fiber (David's standing rule; simplest).
//  half_over_5 → subtract half of fiber, and only when fiber > 5g (ADA-style).
export function fiberAdjustment(fiberG: number, mode: FiberMode): number {
	const f = num(fiberG);
	if (mode === 'half_over_5') return f > 5 ? f / 2 : 0;
	return f;
}

// Grams of sugar alcohol to subtract, per the polyol's glycemic factor.
export function sugarAlcoholAdjustment(
	sugarAlcoholG: number,
	polyol: PolyolType = 'unknown'
): number {
	return num(sugarAlcoholG) * (POLYOL_FACTOR[polyol] ?? POLYOL_FACTOR.unknown);
}

export type NetCarbInput = {
	carbsG: number;
	fiberG?: number | null;
	sugarAlcoholG?: number | null;
	alluloseG?: number | null; // allulose/rare sugars: subtract fully (separate field if ever tracked)
	polyolType?: PolyolType;
};

export type NetCarbResult = {
	bolusableCarbsG: number;
	totalCarbsG: number;
	lowConfidence: boolean; // carbs present but fiber data missing → "verify from label"
};

export type NetCarbOpts = { fiberMode: FiberMode };

// The derivation. max(0, total − fiber − sugarAlcohol − allulose).
export function netCarbs(input: NetCarbInput, opts: NetCarbOpts): NetCarbResult {
	const total = num(input.carbsG);
	const net = Math.max(
		0,
		total -
			fiberAdjustment(num(input.fiberG), opts.fiberMode) -
			sugarAlcoholAdjustment(num(input.sugarAlcoholG), input.polyolType ?? 'unknown') -
			num(input.alluloseG)
	);
	// Missing (null/undefined) fiber on a carby food is the case to flag. A known 0
	// is not low-confidence. NEVER guess a fiber value to shrink the dose number.
	const lowConfidence = total > 0 && input.fiberG == null;
	return { bolusableCarbsG: net, totalCarbsG: total, lowConfidence };
}

// Structural shapes — kept local so this module has no server dependency and can be
// imported anywhere (matches foods.ts / Ingredient without coupling to the schema).
type IngredientLike = { carbsG?: number | null; nutrients?: Partial<Nutrients> | null };
type FoodLike = {
	carbsG?: number | null;
	nutrients?: Partial<Nutrients> | null;
	ingredients?: IngredientLike[] | null;
	makesServings?: number | null;
};

// Per-serving bolusable carbs for a catalog food. Recipes are summed at the
// INGREDIENT level then divided by makesServings — required so each ingredient's
// fiber/polyol handling is respected (the half_over_5 threshold is nonlinear, so
// you can't subtract from the already-summed recipe fiber). Any logged quantity is
// then perServing × servings (linear), computed by the caller.
export function bolusableCarbsPerServing(
	food: FoodLike,
	opts: NetCarbOpts
): { bolusableCarbsG: number; lowConfidence: boolean } {
	const ings = food.ingredients;
	const makes = food.makesServings;
	if (ings && ings.length > 0 && typeof makes === 'number' && makes > 0) {
		let net = 0;
		let lowConfidence = false;
		for (const ing of ings) {
			const r = netCarbs(
				{
					carbsG: ing.carbsG ?? 0,
					fiberG: ing.nutrients?.fiberG,
					sugarAlcoholG: ing.nutrients?.sugarAlcoholG
				},
				opts
			);
			net += r.bolusableCarbsG;
			if (r.lowConfidence) lowConfidence = true;
		}
		return { bolusableCarbsG: net / makes, lowConfidence };
	}
	const r = netCarbs(
		{
			carbsG: food.carbsG ?? 0,
			fiberG: food.nutrients?.fiberG,
			sugarAlcoholG: food.nutrients?.sugarAlcoholG
		},
		opts
	);
	return { bolusableCarbsG: r.bolusableCarbsG, lowConfidence: r.lowConfidence };
}

// Bolusable carbs for an ALREADY-LOGGED entry. The entry's total carbs are
// snapshotted at log time (daily_log caches macros so editing a food never rewrites
// history), so we derive from that snapshot total minus the food's CURRENT
// per-serving fiber/sugar-alcohol scaled to the portion. This guarantees
// bolusable ≤ total and stays coherent with the "total carbs" the entry displays.
// (For recipes under the nonlinear half_over_5 mode this is a flat approximation of
// the ingredient-level per-serving figure; identical under the default 'full' mode.)
export function bolusableForLoggedEntry(
	totalCarbsG: number,
	perServingNutrients: Partial<Nutrients> | null | undefined,
	servings: number,
	opts: NetCarbOpts
): { bolusableCarbsG: number; lowConfidence: boolean } {
	const s = typeof servings === 'number' && servings > 0 ? servings : 1;
	const fiberG = perServingNutrients?.fiberG;
	const sugarAlcoholG = perServingNutrients?.sugarAlcoholG;
	const r = netCarbs(
		{
			carbsG: totalCarbsG,
			fiberG: fiberG == null ? fiberG : fiberG * s,
			sugarAlcoholG: sugarAlcoholG == null ? sugarAlcoholG : sugarAlcoholG * s
		},
		opts
	);
	return { bolusableCarbsG: r.bolusableCarbsG, lowConfidence: r.lowConfidence };
}
