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
