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

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

// ── Dynamic deficit goal ─────────────────────────────────────────────────────
export type GoalMode = 'cut' | 'recomp' | 'lean_bulk';

// Target rate of body-weight change per week as a % of bodyweight, scaled by how
// lean you are: cut harder with fat to spare, ease as you approach single digits
// to protect muscle. Signed — negative = losing. Anchored so ~18% bf → −0.66%/wk
// (≈1 lb/wk), ramping to −1.0% at 25% and easing to a −0.3% floor by ~13%.
export function targetRatePctPerWeek(mode: GoalMode, bodyFatPct: number): number {
	if (mode === 'recomp') return 0;
	if (mode === 'lean_bulk') return 0.25; // ponytail: flat gentle surplus; taper vs a bf ceiling only if it matters
	return -clamp(0.66 + (bodyFatPct - 18) * 0.07, 0.3, 1.0); // cut
}

// Signed daily energy delta vs maintenance (kcal). Negative = deficit (eat less
// than you burn), positive = surplus. target = maintenance + modeDeficit(...).
export function modeDeficit(mode: GoalMode, bodyFatPct: number, weightKg: number): number {
	const kgPerWeek = (targetRatePctPerWeek(mode, bodyFatPct) / 100) * weightKg;
	return (kgPerWeek * KCAL_PER_KG) / 7;
}

// ── Active-energy correction ─────────────────────────────────────────────────
// HealthKit over-estimates PASSIVE active energy; dedicated workout tracking (the
// walking pad) is trusted. So trusted kcal ride at 1.0 and only the passive
// remainder gets the haircut. `dailyActiveKcal` already includes the workout kcal.
export function correctActive(
	dailyActiveKcal: number,
	trustedKcal: number,
	factor: number
): number {
	const passive = Math.max(0, dailyActiveKcal - trustedKcal);
	return trustedKcal + factor * passive;
}

// Back the passive haircut out of calibration: `realActiveAvg` is the true active
// burn implied by the weight trend (calibratedMaintenance − BMR − TEF); solve for
// the factor that scales the window's average PASSIVE active to reality with
// trusted held fixed. Clamped; returns 1 (no correction) when there's too little
// passive signal to learn from (e.g. every active calorie came from a workout).
export function activeCorrectionFactor(
	realActiveAvg: number,
	rawActiveAvg: number,
	trustedAvg: number
): number {
	const passiveAvg = rawActiveAvg - trustedAvg;
	if (!(passiveAvg > 50)) return 1;
	return clamp((realActiveAvg - trustedAvg) / passiveAvg, 0.4, 1.2);
}

// Eat-to target sits at this fraction of calibrated maintenance (before the mode
// deficit). The <1 haircut is a deliberate cushion: the daily number is stable and
// only ratchets UP for extra exercise (never down for a lazy day), so a below-average
// day would otherwise leave the target too high — the haircut keeps those days netting
// a deficit and stops the target chasing an activity-inflated average upward over time.
// ponytail: one knob; tune here if the cushion feels wrong.
export const TARGET_BUFFER_FRACTION = 0.9;

// The daily eat-to baseline (fixed for the whole day, from trailing data that EXCLUDES
// today). On a CUT it's held at TARGET_BUFFER_FRACTION × maintenance + the deficit — i.e.
// ~90% of maintenance minus the deficit. The <1 haircut is a cut-only cushion. Recomp
// (delta 0, eat AT maintenance) and lean bulk (delta > 0, eat ABOVE it) get NO haircut —
// applying it would wrongly turn a maintenance/surplus goal into a deficit. So the buffer
// only kicks in when there's a deficit to cushion (negative delta).
export function targetBaseline(maintenanceKcal: number, modeDeltaKcal: number): number {
	const fraction = modeDeltaKcal < 0 ? TARGET_BUFFER_FRACTION : 1;
	return fraction * maintenanceKcal + modeDeltaKcal;
}

// Rolling signed "deficit balance" (kcal): recovery when you overshoot your deficit goal,
// DEBT when you fall short of it — so neither losing too fast nor stalling compounds. It's an
// exponential moving average of daily over/under-shoot with a 0.5/day decay, so a spike fades
// over ~2-3 days (not piled onto the next day, not chased for a week):
//   balance = clamp(0.5 × yesterdayBalance + (yesterdayDeficit − yesterdayGoal), −maxKcal, maxKcal)
// Positive (recovery) → raise today's eat-to (you already lost enough, ease off). Negative
// (debt) → lower it (you ate over, trim to catch back up). Symmetric cap at ±maxKcal so
// recovery never recommends a surplus and debt can't spiral. `days` run oldest→newest; the
// decay makes anything past ~10 days ago negligible, so it's recomputed from the trailing
// ledger with no stored state. Days with no deficit data are skipped (carry the balance).
export function deficitBalance(
	days: { deficitKcal: number | null; goalKcal: number }[],
	maxKcal: number
): number {
	let balance = 0;
	for (const d of days) {
		if (d.deficitKcal == null || !Number.isFinite(d.deficitKcal)) continue;
		balance = clamp(0.5 * balance + (d.deficitKcal - d.goalKcal), -maxKcal, maxKcal);
	}
	return balance;
}

// ── Daily eat-to target ──────────────────────────────────────────────────────
// Burn-anchored eat-to target, with maintenance as a CONSERVATIVE starting guess of today's
// burn. The morning floor is `TARGET_BUFFER_FRACTION × maintenance − deficit` — a slightly
// low burn estimate, minus the deficit — so it's steady and plannable before you've moved.
// As today's ACTUAL corrected burn (BMR + corrected active + TEF) climbs past that estimate,
// the target rises 1:1 with it, converging on `today's burn − deficit`: you eat back what you
// actually burn while still netting the deficit. Collapses to
// `max(fraction × maintenance, burn) + modeDelta` (+ deficit balance). Monotonic in burn — it
// never drops out from under you. `balanceKcal` (signed, see deficitBalance) shifts it:
// recovery raises it (ease off), debt lowers it (trim to catch up). On a cut the conservative
// fraction applies; recomp/lean_bulk assume full maintenance (fraction 1) so the low estimate
// can't floor them into an accidental deficit. Final target is floored at MIN_EAT_TO_KCAL so
// debt on a low-burn day can't recommend an unsafely low intake.
// ponytail: fixed safety floor; nudge if it clamps real targets.
export const MIN_EAT_TO_KCAL = 1500;

export function ratchetTarget(opts: {
	maintenanceKcal: number;
	modeDeltaKcal: number; // signed (negative = deficit)
	actualBurnKcal: number; // corrected total burn (BMR + corrected active + TEF) accrued so far today
	balanceKcal?: number; // signed deficit balance: + recovery raises eat-to, − debt lowers it; default 0
}): number {
	const fraction = opts.modeDeltaKcal < 0 ? TARGET_BUFFER_FRACTION : 1;
	const assumedBurn = Math.max(fraction * opts.maintenanceKcal, opts.actualBurnKcal);
	return Math.max(MIN_EAT_TO_KCAL, assumedBurn + opts.modeDeltaKcal + (opts.balanceKcal ?? 0));
}

// Which workout calories to trust at full value (not haircut): dedicated
// third-party trackers like the walking pad. Apple's OWN workout estimates (Watch)
// are treated like passive active energy and get the haircut, same as the rest of
// Apple's numbers. Null source (data synced before source capture) stays trusted
// to avoid a regression. ponytail: vendor-prefix heuristic — pin the pad's exact
// bundle id here once it shows up in real data.
export function isTrustedWorkoutSource(source: string | null): boolean {
	return source == null || !source.toLowerCase().includes('apple');
}

// ── Workout active energy (distance workouts: runs & walks) ───────────────────
// Apple over-estimates PASSIVE active energy, so the daily total gets a weight-trend
// haircut — but a GPS workout with a MEASURED distance is physically grounded and shouldn't
// be cut like a couch estimate. So we compute the workout's OWN active kcal and let it ride
// at full value (trusted), out of the haircut pool.
//
// Method = net cost of transport: running burns ~1.0 kcal per kg of body weight per km,
// walking ~0.5 — essentially pace-independent (that constancy is why it's so robust) and
// already net of resting. distance × body weight, split by activity type.
//
// Why NOT heart rate: an HR→kcal formula (Keytel) needs the person's VO2max or it over-reads
// for fit people, and this user's VO2max syncs on ~2 days in 30. Un-calibrated HR clocked a
// 2-mile run at 260 kcal when distance, Apple's OWN workout estimate (204–233 on comparable
// runs), and the physiology all agree on ~220. With no fitness data to calibrate it, HR adds
// BIAS, not accuracy — so it's left out. Here distance × weight is both the simplest and the
// most accurate signal available. Blind spot is hills; revisit HR only if dense VO2max data
// appears. The weight-trend calibration stays the referee for absolute scale.
// ponytail: fixed cost-of-transport constants; non-transport types (cycling — where distance
// is a poor energy proxy) return null and fall back to the existing source path.
export function workoutActiveKcal(w: {
	name: string;
	distanceKm: number | null;
	weightKg: number | null;
}): number | null {
	const { name, distanceKm: dist, weightKg: wt } = w;
	if (dist == null || wt == null || dist <= 0 || wt <= 0) return null;
	const t = name.toLowerCase();
	const costPerKgKm = t.includes('run') ? 1.0 : t.includes('walk') || t.includes('hik') ? 0.5 : null;
	if (costPerKgKm == null) return null; // e.g. cycling — distance is a poor energy proxy
	return dist * wt * costPerKgKm;
}
