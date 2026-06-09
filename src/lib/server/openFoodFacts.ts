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
			categories: string | null;
			raw: unknown;
	  }
	| { ok: false; reason: 'not_found' | 'incomplete_nutriments' | 'http_error'; raw?: unknown };

const FIELDS = [
	'product_name',
	'brands',
	'categories',
	'serving_size',
	'serving_quantity',
	'nutriments',
	'nutrition_data_per'
].join(',');

// OFF data is frequently SHOUTED in all caps. Soften to Title Case for display,
// but leave mixed-case strings (which usually already read well) untouched.
function softenCaps(s: string): string {
	if (/[a-z]/.test(s) || !/[A-Z]/.test(s)) return s;
	return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

// Build a full display name from OFF's separate product_name + brands fields.
// OFF often stores the brand apart from the name ("BUILT" + "BROWNIE BATTER
// PUFF"), so we fold the brand in to get the brand + type + flavor the label
// shows — unless the name already contains it.
export function composeName(productName: string | undefined, brands: string | undefined): string {
	const name = (productName ?? '').trim();
	const brand = (brands ?? '').split(',')[0].trim();
	const full =
		brand && !name.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${name}` : name;
	return softenCaps(full) || 'Unknown';
}

// Map our normalized nutrient keys → OFF nutriment base keys (OFF appends
// `_100g` / `_serving`). Shared by both the per-serving and rich lookups.
const NUT_MAP: ReadonlyArray<[keyof Nutrients, string]> = [
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

// OFF's normalized `_100g`/`_serving` values are in grams for every nutrient we
// map (energy is handled separately). Convert grams → the unit in our key suffix.
function gramsToTarget(target: 'g' | 'mg' | 'ug'): number {
	return target === 'mg' ? 1000 : target === 'ug' ? 1_000_000 : 1;
}
function unitForKey(key: keyof Nutrients): 'g' | 'mg' | 'ug' {
	return key.endsWith('Ug') ? 'ug' : key.endsWith('Mg') ? 'mg' : 'g';
}

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

	// Map OFF nutriment keys → our normalized bag. All optional. Values are in
	// grams; convert to the unit encoded in each key suffix (Mg → mg, Ug → µg).
	const nutrients: Partial<Nutrients> = {};
	for (const [outKey, offKey] of NUT_MAP) {
		const raw = pick(offKey);
		if (raw == null) continue;
		const val = raw * gramsToTarget(unitForKey(outKey));
		if (Number.isFinite(val) && val >= 0) nutrients[outKey] = val;
	}

	return {
		ok: true,
		name: composeName(p.product_name, p.brands),
		brand: p.brands || null,
		servingSize: p.serving_size || null,
		servingGrams: Number.isFinite(Number(p.serving_quantity)) ? Number(p.serving_quantity) : null,
		calories,
		proteinG,
		carbsG,
		fatG,
		nutrients: Object.keys(nutrients).length > 0 ? nutrients : null,
		categories: p.categories || null,
		raw: body
	};
}

// ── Rich lookup: macros on BOTH bases (per-100g and per-serving) ───────────────
// Recipes are measured by weight, so per-100g is the denominator Claude needs to
// scale an ingredient to the grams actually used. Per-serving is handy when the
// food is eaten as a unit. Either base can be null when OFF lacks the data to
// derive it (e.g. no serving size → no per-serving figures).

export type MacroBundle = {
	calories: number;
	proteinG: number;
	carbsG: number;
	fatG: number;
	nutrients: Partial<Nutrients> | null;
};

export type RichOffResult =
	| {
			ok: true;
			name: string;
			brand: string | null;
			servingSize: string | null;
			servingGrams: number | null;
			dataBasis: '100g' | 'serving'; // what OFF actually reported its values per
			per100g: MacroBundle | null;
			perServing: MacroBundle | null;
			categories: string | null;
	  }
	| { ok: false; reason: 'not_found' | 'incomplete_nutriments' | 'http_error' };

export async function lookupBarcodeRich(barcode: string): Promise<RichOffResult> {
	const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}?fields=${FIELDS}`;
	let res: Response;
	try {
		res = await fetch(url, { headers: { 'User-Agent': 'health-dashboard/0.1 (personal)' } });
	} catch {
		return { ok: false, reason: 'http_error' };
	}
	if (!res.ok) return { ok: false, reason: 'http_error' };
	const body = (await res.json()) as any;
	if (body.status !== 1 || !body.product) return { ok: false, reason: 'not_found' };

	const p = body.product;
	const n = p.nutriments ?? {};
	const grams = Number(p.serving_quantity);
	const servingGrams = Number.isFinite(grams) && grams > 0 ? grams : null;
	const dataBasis: '100g' | 'serving' =
		(p.nutrition_data_per as string | undefined) === 'serving' ? 'serving' : '100g';

	// Read a nutrient on a specific base, deriving across bases via serving grams.
	const pick = (key: string, base: '100g' | 'serving'): number | null => {
		const serving = n[`${key}_serving`];
		const hundred = n[`${key}_100g`];
		if (base === '100g') {
			if (typeof hundred === 'number') return hundred;
			if (typeof serving === 'number' && servingGrams) return (serving / servingGrams) * 100;
			return null;
		}
		if (typeof serving === 'number') return serving;
		if (typeof hundred === 'number' && servingGrams) return (hundred * servingGrams) / 100;
		return null;
	};

	const caloriesOn = (base: '100g' | 'serving'): number | null => {
		const kcal = pick('energy-kcal', base);
		if (kcal != null) return kcal;
		const kj = pick('energy', base);
		return kj != null ? kj / 4.184 : null;
	};

	const bundleFor = (base: '100g' | 'serving'): MacroBundle | null => {
		const calories = caloriesOn(base);
		const proteinG = pick('proteins', base);
		const carbsG = pick('carbohydrates', base);
		const fatG = pick('fat', base);
		if (calories == null || proteinG == null || carbsG == null || fatG == null) return null;
		const nutrients: Partial<Nutrients> = {};
		for (const [outKey, offKey] of NUT_MAP) {
			const raw = pick(offKey, base);
			if (raw == null) continue;
			const val = raw * gramsToTarget(unitForKey(outKey));
			if (Number.isFinite(val) && val >= 0) nutrients[outKey] = val;
		}
		return {
			calories,
			proteinG,
			carbsG,
			fatG,
			nutrients: Object.keys(nutrients).length > 0 ? nutrients : null
		};
	};

	const per100g = bundleFor('100g');
	const perServing = bundleFor('serving');
	if (!per100g && !perServing) return { ok: false, reason: 'incomplete_nutriments' };

	return {
		ok: true,
		name: composeName(p.product_name, p.brands),
		brand: p.brands || null,
		servingSize: p.serving_size || null,
		servingGrams,
		dataBasis,
		per100g,
		perServing,
		categories: p.categories || null
	};
}
