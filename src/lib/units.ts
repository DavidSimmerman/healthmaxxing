export type Unit = 'serving' | 'gram' | 'cup' | 'tbsp' | 'tsp';

export const UNITS: Unit[] = ['serving', 'gram', 'cup', 'tbsp', 'tsp'];

export const UNIT_LABEL: Record<Unit, string> = {
	serving: 'serv',
	gram: 'g',
	cup: 'cup',
	tbsp: 'tbsp',
	tsp: 'tsp'
};

// Approximate grams per unit using water density. Accurate for liquids;
// for solids (flour, etc.) this can be off by ±30%. Acceptable for personal tracking.
export const GRAMS_PER_UNIT: Record<Exclude<Unit, 'serving'>, number> = {
	gram: 1,
	cup: 240,
	tbsp: 15,
	tsp: 5
};

export function toServings(amount: number, unit: Unit, servingGrams: number | null): number {
	if (unit === 'serving') return amount;
	// If we don't know the food's per-serving gram weight, fall back to 1:1
	// (treat amount as servings). User can always switch back to 'serving' unit.
	if (!servingGrams || servingGrams <= 0) return amount;
	return (amount * GRAMS_PER_UNIT[unit]) / servingGrams;
}

export function formatAmount(n: number): string {
	if (Number.isInteger(n)) return String(n);
	return Number(n.toFixed(2)).toString();
}

export function entryDisplay(
	amount: number | null,
	unit: string | null,
	servings: number,
	foodServingSize: string | null
): string {
	if (amount != null && unit) return `${formatAmount(amount)} ${UNIT_LABEL[unit as Unit] ?? unit}`;
	if (servings !== 1) return `${formatAmount(servings)}× ${foodServingSize ?? 'serving'}`;
	return foodServingSize ?? '1 serving';
}
