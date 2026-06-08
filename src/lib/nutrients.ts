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
