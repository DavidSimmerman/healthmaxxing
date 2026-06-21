// Energy expenditure math. Pure functions — all data fetching lives in
// $lib/server/deficit.

// Katch-McArdle BMR — the preferred formula since the smart scale gives lean
// mass. Unlike weight-only formulas it doesn't assume an average body
// composition, which is the whole reason we sync body comp data.
export function katchMcArdleBmr(leanMassKg: number): number {
	return 370 + 21.6 * leanMassKg;
}

// Mifflin-St Jeor BMR — fallback for weigh-ins with no body-fat reading.
export function mifflinBmr(
	weightKg: number,
	heightCm: number,
	ageYears: number,
	sex: 'male' | 'female'
): number {
	return 10 * weightKg + 6.25 * heightCm - 5 * ageYears + (sex === 'male' ? 5 : -161);
}

// Thermic effect of food — digestion cost, per macro. Protein is ~25-30% of
// its own calories, carbs ~5-10%, fat ~0-3%; midpoints used. This is why
// logging macros (not just calories) sharpens the burn estimate.
export function tefKcal(proteinG: number, carbsG: number, fatG: number): number {
	return 0.27 * 4 * proteinG + 0.075 * 4 * carbsG + 0.02 * 9 * fatG;
}

// Whole years between birthDate ('YYYY-MM-DD') and onDate ('YYYY-MM-DD').
export function ageOn(onDate: string, birthDate: string): number {
	const [oy, om, od] = onDate.split('-').map(Number);
	const [by, bm, bd] = birthDate.split('-').map(Number);
	let age = oy - by;
	if (om < bm || (om === bm && od < bd)) age -= 1;
	return age;
}

// ~7700 kcal per kg of body fat → 3500 per lb.
export const KCAL_PER_LB = 3500;
export const KCAL_PER_KG = 7700;
