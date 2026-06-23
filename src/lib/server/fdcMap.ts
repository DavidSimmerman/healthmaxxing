// Pure FDC → our-nutrient-keys mapping. No network, no env — unit-testable.
// Relative (not $lib) so the pure mapper stays runnable under tsx for its self-check.
import { sanitizeNutrients, type Nutrients } from '../nutrients';

// FDC nutrient number → our extended-nutrient key. Numbers are stable across
// Foundation/SR Legacy/Branded. Macros (energy/protein/carbs/fat) are intentionally
// omitted — they're separate columns and never recomputed from ingredients here.
const FDC_MAP: Record<string, keyof Nutrients> = {
	'1079': 'fiberG',
	'2000': 'sugarG', // total sugars (newer datasets)
	'1063': 'sugarG', // total sugars (older; whichever is present wins)
	'1235': 'addedSugarG',
	'1258': 'satFatG',
	'1257': 'transFatG',
	'1292': 'monoFatG',
	'1293': 'polyFatG',
	'1253': 'cholesterolMg',
	'1093': 'sodiumMg',
	'1092': 'potassiumMg',
	'1087': 'calciumMg',
	'1089': 'ironMg',
	'1090': 'magnesiumMg',
	'1095': 'zincMg',
	'1091': 'phosphorusMg',
	'1106': 'vitAUg', // Vitamin A, RAE (µg)
	'1162': 'vitCMg',
	'1114': 'vitDUg', // Vitamin D (D2 + D3), µg
	'1109': 'vitEMg', // Vitamin E (alpha-tocopherol), mg
	'1185': 'vitKUg', // Vitamin K (phylloquinone), µg
	'1175': 'vitB6Mg',
	'1178': 'vitB12Ug',
	'1177': 'folateUg', // Folate, total (µg)
	'1057': 'caffeineMg',
	'1018': 'alcoholG'
};

// Convert an FDC value in `unitName` to the unit our key expects (g / mg / µg).
// Returns null for units we can't safely convert (IU, etc.) — never guess.
function toKeyUnit(value: number, unitName: string, key: keyof Nutrients): number | null {
	const u = unitName.toUpperCase();
	const grams =
		u === 'G'
			? value
			: u === 'MG' || u === 'MG_ATE' // alpha-tocopherol equivalents are reported in mg
				? value / 1000
				: u === 'UG' || u === 'µG'
					? value / 1_000_000
					: null;
	if (grams == null) return null;
	const target = key.endsWith('Ug') ? 'ug' : key.endsWith('Mg') ? 'mg' : 'g';
	return target === 'ug' ? grams * 1_000_000 : target === 'mg' ? grams * 1000 : grams;
}

// FDC has TWO numbering schemes: the modern nutrient id (1003, 1079, …) and the
// legacy INFOODS number (203, 291, …). Our FDC_MAP uses the MODERN ids, which live
// in `nutrientId` (search results) / `nutrient.id` (food detail) — NOT in
// `nutrientNumber`/`nutrient.number`, which carry the legacy values. Read the id.
export type FdcNutrientItem = {
	value?: number;
	amount?: number;
	unitName?: string;
	nutrientId?: number;
	nutrient?: { id?: number; unitName?: string };
};

const idOf = (it: FdcNutrientItem): string => {
	const id = it.nutrientId ?? it.nutrient?.id;
	return id != null ? String(id) : '';
};
const valueOf = (it: FdcNutrientItem): number | null => {
	const raw = typeof it.value === 'number' ? it.value : it.amount;
	return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
};

// Read one modern nutrient id's raw value from an FDC foodNutrients array (per 100g).
export function fdcValue(items: FdcNutrientItem[] | undefined, id: string): number | null {
	for (const it of items ?? []) {
		if (idOf(it) === id) {
			const v = valueOf(it);
			if (v != null) return v;
		}
	}
	return null;
}

// Map an FDC foodNutrients array (per 100g) → our per-100g extended-nutrient bag.
// Tolerant of both response shapes: search ({nutrientId, value, unitName}) and food
// detail ({nutrient:{id,unitName}, amount}).
export function mapFdcNutrients(foodNutrients: FdcNutrientItem[] | undefined): Partial<Nutrients> {
	const out: Partial<Nutrients> = {};
	for (const it of foodNutrients ?? []) {
		const key = FDC_MAP[idOf(it)];
		if (!key) continue;
		const raw = valueOf(it);
		if (raw == null) continue;
		const unit = String(it.unitName ?? it.nutrient?.unitName ?? '');
		const v = toKeyUnit(raw, unit, key);
		if (v != null && v >= 0) out[key] = v;
	}
	return sanitizeNutrients(out) ?? {};
}
