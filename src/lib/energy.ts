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

// Weigh-ins are stored in kg (HealthKit's native unit); the UI shows pounds.
// Convert only at the display edge — never store lb.
export const LB_PER_KG = 2.20462;
export const kgToLb = (kg: number) => kg * LB_PER_KG;
export const lbToKg = (lb: number) => lb / LB_PER_KG;

// ── Trend / projection math (pure) ──────────────────────────────────────────
// Body weight on a scale is noisy day to day (water, glycogen, gut contents), so
// we fit a least-squares line through the weigh-ins and project off the SLOPE of
// that line rather than the last reading. Same approach the "weight trend" apps
// use. See energy.selfcheck.ts for the runnable checks.

export type Point = { x: number; y: number };

// Ordinary least-squares fit. `x` is typically a day index. Returns null when
// there are fewer than two distinct x's — a line needs two points.
export function linearRegression(points: Point[]): { slope: number; intercept: number } | null {
	const pts = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
	if (pts.length < 2) return null;
	const n = pts.length;
	let sx = 0,
		sy = 0,
		sxx = 0,
		sxy = 0;
	for (const { x, y } of pts) {
		sx += x;
		sy += y;
		sxx += x * x;
		sxy += x * y;
	}
	const denom = n * sxx - sx * sx;
	if (denom === 0) return null; // all x identical
	const slope = (n * sxy - sx * sy) / denom;
	return { slope, intercept: (sy - slope * sx) / n };
}

// Whole days from `from` to `to` (YYYY-MM-DD). UTC noon avoids DST off-by-one.
export function daysBetween(from: string, to: string): number {
	return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

// The YYYY-MM-DD `n` days after `from`.
export function addDays(from: string, n: number): string {
	return new Date(Date.parse(`${from}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

// Linear-interpolate nulls in a series; hold the nearest known value flat past
// the ends (carry forward / back). All-null in → all-null out. Used to fill
// days whose BMR couldn't be estimated from the days that could.
export function interpolateGaps(values: (number | null)[]): (number | null)[] {
	const out = values.slice();
	const known = values.flatMap((v, i) => (v == null ? [] : [i]));
	if (known.length === 0) return out;
	// Two-pointer walk (known is ascending): ki is the last known index < i.
	let ki = -1;
	for (let i = 0; i < out.length; i++) {
		if (out[i] != null) {
			ki++;
			continue;
		}
		const prev = ki >= 0 ? known[ki] : undefined;
		const next = ki + 1 < known.length ? known[ki + 1] : undefined;
		if (prev !== undefined && next !== undefined) {
			const t = (i - prev) / (next - prev);
			out[i] = values[prev]! + t * (values[next]! - values[prev]!);
		} else out[i] = values[prev ?? next!]; // carry forward, else back
	}
	return out;
}

// Days until `current` reaches `goal` at `ratePerDay` (signed change per day).
// Null if already met within tolerance, the rate is ~0, or it moves away.
export function etaDaysToGoal(current: number, goal: number, ratePerDay: number): number | null {
	const remaining = goal - current;
	if (Math.abs(remaining) < 1e-9) return 0;
	if (!Number.isFinite(ratePerDay) || Math.abs(ratePerDay) < 1e-9) return null;
	const days = remaining / ratePerDay;
	return days > 0 ? days : null; // negative ⇒ trending the wrong way
}

// Body-fat % implied by weight + lean (fat-free) mass.
export function bodyFatPctFromLean(weightKg: number, leanMassKg: number): number {
	return weightKg > 0 ? ((weightKg - leanMassKg) / weightKg) * 100 : 0;
}
