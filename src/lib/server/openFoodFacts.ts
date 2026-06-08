// Open Food Facts v2 lookup — free, no auth.
// https://openfoodfacts.github.io/openfoodfacts-server/api/

import type { Nutrients } from '$lib/nutrients';

export type OffResult =
	| {
			ok: true;
			name: string;
			brand: string | null;
			servingSize: string | null;
			servingGrams: number | null;
			calories: number;
			proteinG: number;
			carbsG: number;
			fatG: number;
			nutrients: Partial<Nutrients> | null;
			raw: unknown;
	  }
	| { ok: false; reason: 'not_found' | 'incomplete_nutriments' | 'http_error'; raw?: unknown };

const FIELDS = [
	'product_name',
	'brands',
	'serving_size',
	'serving_quantity',
	'nutriments',
	'nutrition_data_per'
].join(',');

export async function lookupBarcode(barcode: string): Promise<OffResult> {
	const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}?fields=${FIELDS}`;
	let res: Response;
	try {
		res = await fetch(url, { headers: { 'User-Agent': 'health-dashboard/0.1 (personal)' } });
	} catch {
		return { ok: false, reason: 'http_error' };
	}
	if (!res.ok) return { ok: false, reason: 'http_error' };
	const body = (await res.json()) as any;
	if (body.status !== 1 || !body.product) return { ok: false, reason: 'not_found', raw: body };

	const p = body.product;
	const n = p.nutriments ?? {};

	// Prefer per-serving values; fall back to per-100g if that's all OFF has.
	const per = (p.nutrition_data_per as string | undefined) ?? '100g';
	const usePerServing = per === 'serving';

	const pick = (key: string): number | null => {
		const serving = n[`${key}_serving`];
		const hundred = n[`${key}_100g`];
		if (usePerServing && typeof serving === 'number') return serving;
		if (typeof serving === 'number') return serving;
		if (typeof hundred === 'number') {
			// If we have grams of serving, scale; otherwise return per-100g as best-effort.
			const grams = Number(p.serving_quantity);
			if (Number.isFinite(grams) && grams > 0) return (hundred * grams) / 100;
			return hundred;
		}
		return null;
	};

	const calories = pick('energy-kcal') ?? (pick('energy') ? pick('energy')! / 4.184 : null);
	const proteinG = pick('proteins');
	const carbsG = pick('carbohydrates');
	const fatG = pick('fat');

	if (calories == null || proteinG == null || carbsG == null || fatG == null) {
		return { ok: false, reason: 'incomplete_nutriments', raw: body };
	}

	// Map OFF nutriment keys → our normalized bag. All optional.
	const nutMap: Array<[keyof Nutrients, string]> = [
		['fiberG', 'fiber'],
		['sugarG', 'sugars'],
		['addedSugarG', 'added-sugars'],
		['satFatG', 'saturated-fat'],
		['transFatG', 'trans-fat'],
		['monoFatG', 'monounsaturated-fat'],
		['polyFatG', 'polyunsaturated-fat'],
		['omega3G', 'omega-3-fat'],
		['omega6G', 'omega-6-fat'],
		['cholesterolMg', 'cholesterol'],
		['sodiumMg', 'sodium'],
		['potassiumMg', 'potassium'],
		['calciumMg', 'calcium'],
		['ironMg', 'iron'],
		['magnesiumMg', 'magnesium'],
		['zincMg', 'zinc'],
		['phosphorusMg', 'phosphorus'],
		['vitAUg', 'vitamin-a'],
		['vitCMg', 'vitamin-c'],
		['vitDUg', 'vitamin-d'],
		['vitEMg', 'vitamin-e'],
		['vitKUg', 'vitamin-k'],
		['vitB6Mg', 'vitamin-b6'],
		['vitB12Ug', 'vitamin-b12'],
		['folateUg', 'vitamin-b9'],
		['caffeineMg', 'caffeine'],
		['alcoholG', 'alcohol']
	];
	// OFF's normalized `_100g`/`_serving` values (what pick() returns) are in
	// grams for every nutrient we map (energy is handled separately above). The
	// `_unit` field is only the display unit, so we ignore it and convert grams
	// → the unit encoded in our key suffix (Mg → mg, Ug → µg).
	const gramsToTarget = (target: 'g' | 'mg' | 'ug'): number =>
		target === 'mg' ? 1000 : target === 'ug' ? 1_000_000 : 1;
	const nutrients: Partial<Nutrients> = {};
	for (const [outKey, offKey] of nutMap) {
		const raw = pick(offKey);
		if (raw == null) continue;
		const target: 'g' | 'mg' | 'ug' = outKey.endsWith('Ug')
			? 'ug'
			: outKey.endsWith('Mg')
				? 'mg'
				: 'g';
		const val = raw * gramsToTarget(target);
		if (Number.isFinite(val) && val >= 0) nutrients[outKey] = val;
	}

	return {
		ok: true,
		name: p.product_name || 'Unknown',
		brand: p.brands || null,
		servingSize: p.serving_size || null,
		servingGrams: Number.isFinite(Number(p.serving_quantity)) ? Number(p.serving_quantity) : null,
		calories,
		proteinG,
		carbsG,
		fatG,
		nutrients: Object.keys(nutrients).length > 0 ? nutrients : null,
		raw: body
	};
}
