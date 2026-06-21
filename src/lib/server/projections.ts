import { asc, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { bodyComp, settings } from '$lib/server/db/schema';
import { APP_TZ, todayLabel } from '$lib/server/day';
import { deficitDays, type DayEnergy } from '$lib/server/deficit';
import {
	linearRegression,
	interpolateGaps,
	etaDaysToGoal,
	daysBetween,
	addDays,
	KCAL_PER_KG,
	type Point
} from '$lib/energy';

// Body-composition trends + projections, built on the synced weigh-ins and the
// energy ledger. Weight on a scale is noisy, so we project off a least-squares
// trend line through the weigh-ins, and cross-check the implied weight-loss rate
// against the measured calorie deficit (avg deficit ÷ 7700 kcal/kg). Shared by
// the /trends page, the /day view, and the MCP server.

export type WeighIn = {
	date: string; // YYYY-MM-DD in APP_TZ
	weightKg: number;
	bodyFatPct: number | null;
	leanMassKg: number | null;
};

export type Trend = {
	slopePerDay: number; // signed change per day (negative = decreasing)
	ratePerWeek: number;
	current: number; // trend value at `today` (smoother than the last raw reading)
	anchorDate: string; // x=0 for the fit
	intercept: number; // value at anchorDate
};

export type GoalEta = {
	goal: number;
	current: number;
	ratePerWeek: number;
	etaDays: number | null;
	etaDate: string | null;
};

export type Projection = {
	date: string;
	label: string; // e.g. "+1 month"
	weightKg: number | null;
	bodyFatPct: number | null;
	leanMassKg: number | null;
};

export type BodyInsights = {
	asOf: string;
	series: WeighIn[]; // actual weigh-ins in the window (oldest → newest)
	weight: Trend | null;
	bodyFat: Trend | null;
	leanMass: Trend | null;
	deficitImplied: { ratePerWeekKg: number; avgDeficitKcal: number; days: number } | null;
	projections: Projection[];
	goal: { weight: GoalEta | null; bodyFat: GoalEta | null };
};

const compDateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: APP_TZ });

// All weigh-ins up to `toDate` (default today), oldest first, bucketed to a
// local date. Multiple weigh-ins on a day are kept — the regression handles
// repeated x's fine.
export async function weighInsThrough(toDate?: string): Promise<WeighIn[]> {
	const to = toDate ?? todayLabel();
	const rows = await db
		.select()
		.from(bodyComp)
		.where(
			sql`(${bodyComp.measuredAt} at time zone 'UTC' at time zone ${APP_TZ})::date <= ${to}::date`
		)
		.orderBy(asc(bodyComp.measuredAt));
	return rows.map((r) => ({
		date: compDateFmt.format(r.measuredAt),
		weightKg: r.weightKg,
		bodyFatPct: r.bodyFatPct,
		leanMassKg: r.leanMassKg
	}));
}

function trendFor(
	series: WeighIn[],
	pick: (w: WeighIn) => number | null,
	anchorDate: string,
	today: string
): Trend | null {
	const points: Point[] = [];
	for (const w of series) {
		const y = pick(w);
		if (y != null) points.push({ x: daysBetween(anchorDate, w.date), y });
	}
	const fit = linearRegression(points);
	if (!fit) return null;
	return {
		slopePerDay: fit.slope,
		ratePerWeek: fit.slope * 7,
		current: fit.intercept + fit.slope * daysBetween(anchorDate, today),
		anchorDate,
		intercept: fit.intercept
	};
}

function projAt(trend: Trend | null, date: string): number | null {
	if (!trend) return null;
	return trend.intercept + trend.slopePerDay * daysBetween(trend.anchorDate, date);
}

function goalEta(trend: Trend | null, goal: number | null | undefined, today: string): GoalEta | null {
	if (!trend || goal == null) return null;
	const etaDays = etaDaysToGoal(trend.current, goal, trend.slopePerDay);
	return {
		goal,
		current: trend.current,
		ratePerWeek: trend.ratePerWeek,
		etaDays: etaDays == null ? null : Math.round(etaDays),
		etaDate: etaDays == null ? null : addDays(today, Math.round(etaDays))
	};
}

/**
 * @param windowDays trailing window of weigh-ins to fit the trend over
 * @param horizons   future offsets (in days) to project at
 * @param targetDate optional extra date to project at (YYYY-MM-DD)
 */
export async function bodyInsights({
	windowDays = 90,
	horizons = [
		{ days: 30, label: '+1 month' },
		{ days: 60, label: '+2 months' },
		{ days: 90, label: '+3 months' }
	],
	targetDate
}: {
	windowDays?: number;
	horizons?: { days: number; label: string }[];
	targetDate?: string;
} = {}): Promise<BodyInsights> {
	// Clamp untrusted input (URL ?window=, MCP args) — an Infinite/huge window
	// would make addDays throw and deficitDays iterate forever. 1–1825 days.
	windowDays = Math.min(Math.max(1, Math.floor(Number(windowDays)) || 90), 1825);

	const today = todayLabel();
	const all = await weighInsThrough(today);

	// Window to the trailing `windowDays` of weigh-ins; if that leaves <2 points,
	// fall back to the full history so a sparse logger still gets a trend.
	let series = all;
	if (all.length) {
		const cutoff = addDays(all[all.length - 1].date, -windowDays);
		const windowed = all.filter((w) => w.date >= cutoff);
		if (windowed.length >= 2) series = windowed;
	}

	const anchor = series.length ? series[0].date : today;
	const weight = trendFor(series, (w) => w.weightKg, anchor, today);
	const bodyFat = trendFor(series, (w) => w.bodyFatPct, anchor, today);
	const leanMass = trendFor(series, (w) => w.leanMassKg, anchor, today);

	// Deficit-implied weight rate over the same window: avg daily deficit ÷ 7700
	// kcal/kg. Positive deficit ⇒ losing ⇒ negative weight change.
	const from = addDays(today, -windowDays + 1);
	const ledger = await deficitDays(from, today);
	const counted = ledger.filter((d) => d.deficitKcal != null && d.intakeKcal > 0);
	const deficitImplied = counted.length
		? (() => {
				const avgDeficitKcal =
					counted.reduce((a, d) => a + (d.deficitKcal ?? 0), 0) / counted.length;
				return {
					avgDeficitKcal: Math.round(avgDeficitKcal),
					ratePerWeekKg: (-avgDeficitKcal / KCAL_PER_KG) * 7,
					days: counted.length
				};
			})()
		: null;

	const projections: Projection[] = [];
	const horizonRows = [...horizons];
	if (targetDate && targetDate > today) {
		horizonRows.push({ days: daysBetween(today, targetDate), label: targetDate });
	}
	for (const h of horizonRows) {
		const date = h.label === targetDate ? targetDate : addDays(today, h.days);
		projections.push({
			date,
			label: h.label,
			weightKg: round1(projAt(weight, date)),
			bodyFatPct: round1(projAt(bodyFat, date)),
			leanMassKg: round1(projAt(leanMass, date))
		});
	}

	const [settingsRow] = await db.select().from(settings).where(sql`${settings.id} = 1`);
	return {
		asOf: today,
		series,
		weight,
		bodyFat,
		leanMass,
		deficitImplied,
		projections,
		goal: {
			weight: goalEta(weight, settingsRow?.goalWeightKg, today),
			bodyFat: goalEta(bodyFat, settingsRow?.goalBodyFatPct, today)
		}
	};
}

// Fill days whose BMR couldn't be estimated by interpolating between the days
// that could, then recompute burn + deficit for those days. Returns a NEW array;
// untouched days are returned as-is. No-op when no day has a BMR (nothing to
// interpolate from).
export function fillBmrGaps(days: DayEnergy[]): DayEnergy[] {
	const filled = interpolateGaps(days.map((d) => d.bmrKcal));
	return days.map((d, i) => {
		if (d.bmrKcal != null || filled[i] == null) return d;
		const bmr = Math.round(filled[i]!);
		const burned = bmr + (d.activeKcal ?? 0) + d.tefKcal;
		return {
			...d,
			bmrKcal: bmr,
			bmrSource: 'interpolated',
			burnedKcal: Math.round(burned),
			deficitKcal: Math.round(burned - d.intakeKcal)
		};
	});
}

function round1(n: number | null): number | null {
	return n == null ? null : Math.round(n * 10) / 10;
}

// ── Energy-balance projection model ──────────────────────────────────────────
// Beyond the raw weigh-in trend, project body comp from calorie balance. The
// core trick (what adaptive-TDEE apps like MacroFactor do): instead of trusting
// a BMR formula OR the noisy scale, BACK OUT the user's real maintenance from
// observed data over a window — calibratedTDEE = avgIntake − weightSlope×7700.
// Then forward-simulate, decaying TDEE as weight drops and splitting each
// increment of loss into fat vs lean by a protein/leanness-aware p-ratio.
//
// Constants are research-defaulted and live here to tune in one place.
// (see .claude/research/weight-projection-science.md — Hall/Thomas linearized
// model, Forbes p-ratio, ISSN/Helms protein.)
const PROTEIN_ADEQUATE_G_PER_KG = 1.6; // g/kg floor that protects lean mass (optimal ~2.3 + lifting)
const TDEE_DROP_PER_KG = 32; // kcal/day maintenance falls per kg lost — obligatory ~25 + adaptive ~7 (ε)
const RHO_KCAL_PER_KG = 8700; // effective energy density of weight change in the forward model
// NOTE: calibrating TDEE from observed loss uses the classic 7700 (KCAL_PER_KG);
// the forward simulation uses ρ=8700 + ε decay, which converges to the same
// equilibrium loss (deficit ÷ ε) Hall's model predicts.

export type ProjectionMethod = 'trend' | 'deficit' | 'combined';

export type MethodProjection = {
	method: ProjectionMethod;
	label: string;
	note: string;
	ratePerWeekKg: number | null; // near-term loss rate this method implies (neg = losing)
	rows: Projection[];
};

export type EnergyInsights = {
	windowDays: number;
	loggedDays: number;
	avgIntakeKcal: number | null;
	avgProteinG: number | null;
	proteinPerKg: number | null;
	proteinAdequate: boolean | null;
	estimatedTdee: number | null; // our BMR+active+TEF average (the formula's guess)
	calibratedTdee: number | null; // backed out of observed intake + weight change (reality)
	measuredRatePerWeekKg: number | null; // from the weigh-in trend
	expectedRatePerWeekKg: number | null; // from the logged calorie deficit (formula)
	pace: {
		ratio: number | null;
		verdict: 'on-track' | 'slower' | 'faster' | 'gaining' | 'surplus' | 'unknown';
	};
	methods: MethodProjection[];
};

// Share of a weight CHANGE that comes from LEAN mass (the p-ratio). Leaner
// bodies surrender more lean (Forbes); adequate protein + lifting protect it.
// Defaults from the p-ratio review tables (Thomas 2012 / Helms 2014).
function leanLossFraction(bodyFatPct: number, proteinAdequate: boolean): number {
	let p = 0.2 - (bodyFatPct - 15) * 0.006; // ~0.20 at 15% bf, falls as bf rises
	p = Math.min(0.45, Math.max(0.05, p));
	if (!proteinAdequate) p = Math.min(0.6, p * 1.5); // too little protein → more lean lost
	return p;
}

// Forward-simulate body comp day by day from `today` to the furthest requested
// date, recording at each requested horizon. TDEE decays with lost mass; loss is
// split fat/lean by the p-ratio. If bodyFat is unknown we project weight only.
function forwardSim(opts: {
	today: string;
	weightKg: number;
	bodyFatPct: number | null;
	tdee0: number;
	plannedIntake: number;
	proteinG: number | null;
	dates: { date: string; label: string }[];
}): { rows: Projection[]; ratePerWeekKg: number } {
	const ratePerWeekKg = (-(opts.tdee0 - opts.plannedIntake) / RHO_KCAL_PER_KG) * 7;
	const maxDay = opts.dates.reduce((m, d) => Math.max(m, daysBetween(opts.today, d.date)), 0);
	if (maxDay <= 0) return { rows: [], ratePerWeekKg };

	const w0 = opts.weightKg;
	let weight = opts.weightKg;
	let fat = opts.bodyFatPct != null ? (weight * opts.bodyFatPct) / 100 : null;
	let lean = fat != null ? weight - fat : null;
	const recordOn = new Map(opts.dates.map((d) => [daysBetween(opts.today, d.date), d.label]));
	const rows: Projection[] = [];

	for (let day = 1; day <= maxDay; day++) {
		const tdee = opts.tdee0 - (w0 - weight) * TDEE_DROP_PER_KG; // less mass → less maintenance
		const dW = -(tdee - opts.plannedIntake) / RHO_KCAL_PER_KG; // kg/day, neg when in a deficit
		if (fat != null && lean != null) {
			const bf = weight > 0 ? (fat / weight) * 100 : 0;
			const adequate = opts.proteinG != null && weight > 0 && opts.proteinG / weight >= PROTEIN_ADEQUATE_G_PER_KG;
			const leanShare = leanLossFraction(bf, adequate);
			fat = Math.max(0, fat + dW * (1 - leanShare));
			lean = Math.max(0, lean + dW * leanShare);
			weight = fat + lean;
		} else {
			weight = Math.max(0, weight + dW);
		}
		const label = recordOn.get(day);
		if (label !== undefined) {
			const bf = fat != null && weight > 0 ? (fat / weight) * 100 : null;
			rows.push({
				date: addDays(opts.today, day),
				label,
				weightKg: round1(weight),
				bodyFatPct: round1(bf),
				leanMassKg: round1(lean)
			});
		}
	}
	return { rows, ratePerWeekKg };
}

/**
 * Energy-aware insights + multi-method projections. Builds on bodyInsights for
 * the weigh-in trend, and on the calorie ledger for intake/protein/deficit.
 */
export async function energyInsights({
	windowDays = 30,
	horizons = [
		{ days: 30, label: '+1 month' },
		{ days: 60, label: '+2 months' },
		{ days: 90, label: '+3 months' }
	],
	targetDate
}: {
	windowDays?: number;
	horizons?: { days: number; label: string }[];
	targetDate?: string;
} = {}): Promise<EnergyInsights & { body: BodyInsights }> {
	windowDays = Math.min(Math.max(1, Math.floor(Number(windowDays)) || 30), 1825);
	const today = todayLabel();
	const body = await bodyInsights({ windowDays, horizons, targetDate });

	// Window ledger for intake / protein / our formula-TDEE.
	const from = addDays(today, -windowDays + 1);
	const ledger = fillBmrGaps(await deficitDays(from, today));
	const logged = ledger.filter((d) => d.intakeKcal > 0);
	const withBurn = ledger.filter((d) => d.burnedKcal != null);
	const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

	const avgIntakeKcal = mean(logged.map((d) => d.intakeKcal));
	const avgProteinG = mean(logged.map((d) => d.proteinG));
	const estimatedTdee = mean(withBurn.map((d) => d.burnedKcal as number));

	// Calibrated TDEE + the energy-based projections multiply avg intake across the
	// whole window, so they're only trustworthy with enough logged-day coverage —
	// otherwise one logged day would be treated as if it happened every day.
	const spanDays = body.series.length ? daysBetween(body.series[0].date, today) + 1 : windowDays;
	const effWindow = Math.min(windowDays, Math.max(1, spanDays));
	const enoughIntake = logged.length >= 7 && logged.length / effWindow >= 0.5;

	const startWeight = body.weight?.current ?? null; // trend value today (smoothed)
	const startBf = body.bodyFat?.current ?? null;
	const proteinPerKg = avgProteinG != null && startWeight ? avgProteinG / startWeight : null;
	const proteinAdequate = proteinPerKg != null ? proteinPerKg >= PROTEIN_ADEQUATE_G_PER_KG : null;

	const measuredSlope = body.weight?.slopePerDay ?? null;
	const measuredRatePerWeekKg = body.weight?.ratePerWeek ?? null;
	const calibratedTdee =
		enoughIntake && avgIntakeKcal != null && measuredSlope != null
			? Math.round(avgIntakeKcal - measuredSlope * KCAL_PER_KG)
			: null;
	const expectedRatePerWeekKg = body.deficitImplied?.ratePerWeekKg ?? null;

	// "Am I losing as fast as my deficit predicts?" — branch on whether the logged
	// intake is actually a deficit; surplus/maintenance gets different copy.
	let ratio: number | null = null;
	let verdict: EnergyInsights['pace']['verdict'] = 'unknown';
	if (!enoughIntake || measuredRatePerWeekKg == null || expectedRatePerWeekKg == null) {
		verdict = 'unknown';
	} else if (expectedRatePerWeekKg >= -1e-6) {
		// logged intake is at/above estimated maintenance — not a deficit
		verdict = measuredRatePerWeekKg > 0.05 ? 'gaining' : 'surplus';
	} else if (measuredRatePerWeekKg > 0.05) {
		verdict = 'gaining'; // a predicted deficit, yet trending up
	} else {
		ratio = measuredRatePerWeekKg / expectedRatePerWeekKg; // both neg when losing
		verdict = ratio >= 1.3 ? 'faster' : ratio >= 0.7 ? 'on-track' : 'slower';
	}

	// Project dates (horizons + optional custom target).
	const dates = horizons.map((h) => ({ date: addDays(today, h.days), label: h.label }));
	if (targetDate && targetDate > today) dates.push({ date: targetDate, label: targetDate });

	const methods: MethodProjection[] = [
		{
			method: 'trend',
			label: 'Current trend',
			note: 'Extrapolates your weigh-in trend line as-is.',
			ratePerWeekKg: measuredRatePerWeekKg,
			rows: body.projections
		}
	];
	if (enoughIntake && startWeight != null && estimatedTdee != null && avgIntakeKcal != null) {
		const sim = forwardSim({
			today,
			weightKg: startWeight,
			bodyFatPct: startBf,
			tdee0: estimatedTdee,
			plannedIntake: avgIntakeKcal,
			proteinG: avgProteinG,
			dates
		});
		methods.push({
			method: 'deficit',
			label: 'Calorie deficit',
			note: 'If your logged intake vs estimated burn holds — splits loss into fat/lean by protein & body-fat %.',
			ratePerWeekKg: sim.ratePerWeekKg,
			rows: sim.rows
		});
	}
	if (startWeight != null && calibratedTdee != null && avgIntakeKcal != null) {
		const sim = forwardSim({
			today,
			weightKg: startWeight,
			bodyFatPct: startBf,
			tdee0: calibratedTdee,
			plannedIntake: avgIntakeKcal,
			proteinG: avgProteinG,
			dates
		});
		methods.push({
			method: 'combined',
			label: 'Smart (calibrated)',
			note: 'Uses your REAL maintenance backed out of observed intake + weight change, then projects energy balance with metabolic adaptation.',
			ratePerWeekKg: sim.ratePerWeekKg,
			rows: sim.rows
		});
	}

	return {
		body,
		windowDays,
		loggedDays: logged.length,
		avgIntakeKcal: avgIntakeKcal == null ? null : Math.round(avgIntakeKcal),
		avgProteinG: avgProteinG == null ? null : Math.round(avgProteinG),
		proteinPerKg: round1(proteinPerKg),
		proteinAdequate,
		estimatedTdee: estimatedTdee == null ? null : Math.round(estimatedTdee),
		calibratedTdee,
		measuredRatePerWeekKg,
		expectedRatePerWeekKg,
		pace: { ratio, verdict },
		methods
	};
}
