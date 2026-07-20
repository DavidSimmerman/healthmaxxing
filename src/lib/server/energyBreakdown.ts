import { sql, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { workouts, settings } from '$lib/server/db/schema';
import { APP_TZ, todayLabel } from '$lib/server/day';
import { deficitDays, type DayEnergy, type DayCorrection } from '$lib/server/deficit';
import { fillBmrGaps, energyInsights } from '$lib/server/projections';
import { loadIsVacation } from '$lib/server/vacations';
import {
	addDays,
	correctActive,
	activeCorrectionFactor,
	ratchetTarget,
	targetBaseline,
	deficitBalance,
	MIN_EAT_TO_KCAL,
	modeDeficit,
	isTrustedWorkoutSource,
	workoutActiveKcal,
	type GoalMode
} from '$lib/energy';

const WINDOW_DAYS = 30;
const MODES: GoalMode[] = ['cut', 'recomp', 'lean_bulk'];

type WorkoutRow = {
	name: string;
	kcal: number | null;
	source: string | null;
	distanceKm: number | null;
};

// Trusted (out-of-haircut) active kcal for one workout. Dedicated trackers (walking pad,
// legacy null-source) are already accurate — they ride on their own kcal as-is, untouched.
// Apple's OWN workout estimate is the one we replace: a run/walk with a measured distance
// gets our net-cost-of-transport number (distance × weight); anything with no distance to
// stand on (strength) or a non-transport type (cycling) stays on the existing path.
// `weightKg` is the latest weigh-in (weight drifts <a few % over the window — under the
// formula's own error, and calibration absorbs the residual).
function trustWorkout(w: WorkoutRow, weightKg: number | null): { trusted: boolean; kcal: number } {
	if (isTrustedWorkoutSource(w.source)) return { trusted: true, kcal: w.kcal ?? 0 };
	const own = workoutActiveKcal({ name: w.name, distanceKm: w.distanceKm, weightKg });
	return own != null ? { trusted: true, kcal: own } : { trusted: false, kcal: w.kcal ?? 0 };
}

export type WorkoutLite = {
	name: string;
	kcal: number | null;
	time: string;
	startedAt: string;
	trusted: boolean;
};

const mean = (xs: number[]): number | null =>
	xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

type SettingsRow = typeof settings.$inferSelect;

// Everything the corrected view + dynamic target need, computed ONCE per request
// from the RAW 30-day ledger + calibration. Threaded into deficitDays via
// `correction` so consumers get corrected numbers without recomputing this, and
// so the calibration path (projections) can keep calling deficitDays raw.
export type EnergyContext = {
	today: string;
	mode: GoalMode;
	correction: DayCorrection; // { factor, trustedByDate, todayTargetKcal }
	// Calibration / maintenance
	factor: number;
	maintenanceKcal: number | null;
	maintenanceSource: 'calibrated' | 'estimated' | null;
	calibratedTdee: number | null;
	estimatedTdee: number | null;
	bodyFatPct: number | null;
	weightKg: number | null;
	modeDeltaKcal: number | null;
	balanceKcal: number; // signed deficit balance folded into today's targets (+ recovery / − debt; 0 when none / non-cut)
	targetKcal: number | null; // RATCHET eat-to goal (display): rises with real burn, never drops
	stableTargetKcal: number | null; // non-ratcheting assumed intake for deficit math (= correction.todayTargetKcal)
	fixedCalorieTarget: number; // the user's configured settings.calorieTarget (fallback)
	// Active averages (corrected) + today's live inputs
	avgRawActive: number | null;
	avgCorrectedActive: number | null;
	avgTrustedKcal: number | null;
	// Reusable so callers don't re-query
	windowLedger: DayEnergy[]; // RAW, fillBmrGaps'd, [today-30 … today]
	woByDate: Map<string, { kcal: number; list: WorkoutLite[] }>;
};

export async function resolveCorrection(settingsRow?: SettingsRow | null): Promise<EnergyContext> {
	const today = todayLabel();
	const from = addDays(today, -WINDOW_DAYS);
	const woDate = sql<string>`(${workouts.startedAt} at time zone 'UTC' at time zone ${APP_TZ})::date`;

	const [s, insights, windowLedger, woRows] = await Promise.all([
		settingsRow !== undefined
			? Promise.resolve(settingsRow)
			: db
					.select()
					.from(settings)
					.where(eq(settings.id, 1))
					.then((r) => r[0] ?? null),
		energyInsights({ windowDays: WINDOW_DAYS }),
		deficitDays(from, today).then(fillBmrGaps), // RAW — factor is derived from this
		db
			.select({
				date: sql<string>`${woDate}::text`,
				name: workouts.name,
				kcal: workouts.kcal,
				source: workouts.source,
				distanceKm: workouts.distanceKm,
				time: sql<string>`to_char((${workouts.startedAt} at time zone 'UTC' at time zone ${APP_TZ}), 'FMHH12:MI AM')`,
				startedAt: sql<string>`${workouts.startedAt}::text`
			})
			.from(workouts)
			.where(sql`${woDate} between ${from}::date and ${today}::date`)
	]);

	const mode = (MODES.includes(s?.goalMode as GoalMode) ? s!.goalMode : 'cut') as GoalMode;

	// Latest weigh-in (+ body-fat), reused for the workout formula and maintenance/mode.
	// Weight drifts slowly, so one value across the window is plenty.
	const latest = insights.body.series.at(-1);
	const bodyFatPct = insights.body.bodyFat?.current ?? latest?.bodyFatPct ?? null;
	const weightKg = insights.body.weight?.current ?? latest?.weightKg ?? null;

	// Group workouts by local day. Runs/walks with a measured distance use OUR net-cost-of-
	// transport active-kcal (distance × weight, out of the haircut pool); dedicated third-party
	// trackers (pad) still ride on their own kcal; everything else follows the source rule.
	// Null kcal counts as 0 trusted.
	const woByDate = new Map<string, { kcal: number; list: WorkoutLite[] }>();
	for (const w of woRows) {
		const { trusted, kcal } = trustWorkout(w, weightKg);
		const e = woByDate.get(w.date) ?? { kcal: 0, list: [] };
		e.kcal += trusted ? kcal : 0; // only trusted kcal count toward the carve-out
		e.list.push({
			name: w.name,
			kcal: trusted ? Math.round(kcal) : w.kcal, // show the number we actually use
			time: w.time,
			startedAt: w.startedAt,
			trusted
		});
		woByDate.set(w.date, e);
	}
	const trustedByDate = new Map([...woByDate].map(([d, v]) => [d, v.kcal]));

	// Correction factor from COMPLETED, logged days (today's partial excluded).
	// Vacation days don't train it — trip food is guesswork.
	const isVac = await loadIsVacation();
	const completed = windowLedger.filter(
		(d) => d.date < today && d.intakeKcal > 0 && d.burnedKcal != null && !isVac(d.date)
	);
	const avgBmr = mean(completed.map((d) => d.bmrKcal ?? 0));
	const avgTef = mean(completed.map((d) => d.tefKcal));
	const avgRawActive = mean(completed.map((d) => d.activeKcal ?? 0));
	const avgTrusted = mean(completed.map((d) => trustedByDate.get(d.date) ?? 0));
	const realActiveAvg =
		insights.calibratedTdee != null && avgBmr != null && avgTef != null
			? insights.calibratedTdee - avgBmr - avgTef
			: null;
	const factor =
		realActiveAvg != null && avgRawActive != null && avgTrusted != null
			? activeCorrectionFactor(realActiveAvg, avgRawActive, avgTrusted)
			: 1;

	// Avg corrected active over completed days (already inside calibrated maintenance).
	const avgCorrectedActive = mean(
		completed.map((d) => correctActive(d.activeKcal ?? 0, trustedByDate.get(d.date) ?? 0, factor))
	);

	// Maintenance + per-mode target delta (recomp needs no body data, lean_bulk only
	// weight, cut both; fall back to the latest weigh-in when the trend is null).
	const maintenanceKcal = insights.calibratedTdee ?? insights.estimatedTdee ?? null;
	const maintenanceSource =
		insights.calibratedTdee != null
			? 'calibrated'
			: insights.estimatedTdee != null
				? 'estimated'
				: null;
	const modeDeltaKcal =
		mode === 'recomp'
			? 0
			: weightKg != null && (mode === 'lean_bulk' || bodyFatPct != null)
				? Math.round(modeDeficit(mode, bodyFatPct ?? 0, weightKg))
				: null;

	// Today's corrected burn so far (BMR + corrected active + TEF) — what the eat-to target
	// tracks once it passes the conservative estimate. Null until there's a BMR for today.
	const todayEntry = windowLedger.find((d) => d.date === today);
	const correctedBurnToday =
		todayEntry?.bmrKcal != null
			? todayEntry.bmrKcal +
				correctActive(todayEntry.activeKcal ?? 0, trustedByDate.get(today) ?? 0, factor) +
				todayEntry.tefKcal
			: null;
	// Conservative-burn floor (fixed for the day). recomp/lean_bulk get no haircut (targetBaseline).
	const baseKcal =
		maintenanceKcal != null && modeDeltaKcal != null
			? targetBaseline(maintenanceKcal, modeDeltaKcal)
			: null;

	// Deficit balance: recovery (ease off) after big-deficit days, DEBT (trim down) after days
	// you fell short — so neither losing too fast nor stalling compounds. Cut-only. Measured
	// against the deficit GOAL (−modeDelta) — the deficit you net on a normal day now that the
	// target is burn-anchored; capped at ±that goal (recovery tops out at eating to maintenance,
	// debt at a doubled deficit, and the target's own MIN floor guards the low end). From
	// COMPLETED, logged, non-vacation days (same set the calibration trusts); the 0.5/day decay
	// makes days past ~10 ago negligible → no stored state needed.
	let balanceKcal = 0;
	if (baseKcal != null && maintenanceKcal != null && modeDeltaKcal != null && modeDeltaKcal < 0) {
		const balanceDays = completed.map((d) => ({
			deficitKcal:
				d.bmrKcal != null
					? d.bmrKcal +
						correctActive(d.activeKcal ?? 0, trustedByDate.get(d.date) ?? 0, factor) +
						d.tefKcal -
						d.intakeKcal
					: null,
			goalKcal: -modeDeltaKcal
		}));
		balanceKcal = Math.round(deficitBalance(balanceDays, -modeDeltaKcal));
	}

	// The displayed eat-to goal is burn-anchored: it climbs 1:1 as today's real burn passes
	// the conservative estimate. The deficit's assumed intake must NOT track burn like that —
	// it would cancel burn out of the deficit (burn +1, assumed intake +1) and freeze
	// deficit/active-to-go. So the deficit uses the STABLE floor (conservative estimate −
	// deficit + deficit balance), the target's morning value; only the displayed goal climbs.
	const stableTargetKcal =
		baseKcal != null ? Math.round(Math.max(MIN_EAT_TO_KCAL, baseKcal + balanceKcal)) : null;
	let targetKcal: number | null = stableTargetKcal; // burn-anchored; falls back to the floor with no burn yet
	if (baseKcal != null && correctedBurnToday != null) {
		targetKcal = Math.round(
			ratchetTarget({
				maintenanceKcal: maintenanceKcal!,
				modeDeltaKcal: modeDeltaKcal!,
				actualBurnKcal: correctedBurnToday,
				balanceKcal
			})
		);
	}

	return {
		today,
		mode,
		correction: { factor, trustedByDate, todayTargetKcal: stableTargetKcal },
		factor,
		maintenanceKcal,
		maintenanceSource,
		calibratedTdee: insights.calibratedTdee,
		estimatedTdee: insights.estimatedTdee,
		bodyFatPct,
		weightKg,
		modeDeltaKcal,
		balanceKcal,
		targetKcal,
		stableTargetKcal,
		avgRawActive: avgRawActive != null ? Math.round(avgRawActive) : null,
		avgCorrectedActive: avgCorrectedActive != null ? Math.round(avgCorrectedActive) : null,
		avgTrustedKcal: avgTrusted != null ? Math.round(avgTrusted) : null,
		fixedCalorieTarget: s?.calorieTarget ?? 2100,
		windowLedger,
		woByDate
	};
}

// deficitDays with the active-energy correction + dynamic target applied. The
// one-line swap for consumers that want corrected numbers. Multi-call callers
// (e.g. goals scoring) should resolveCorrection() ONCE and thread `correction`.
// ponytail: recomputes the correction per call — fine for a solo app; hoist if a
// hot path calls it many times.
// Trusted (dedicated workout) kcal per local day over [from, to] — so a requested
// historical range gets its OWN workout carve-out, not just the 30-day calibration
// window's (older days would otherwise haircut real workout burn as passive).
async function trustedWorkoutsByDate(
	from: string,
	to: string,
	weightKg: number | null
): Promise<Map<string, number>> {
	const woDate = sql<string>`(${workouts.startedAt} at time zone 'UTC' at time zone ${APP_TZ})::date`;
	const rows = await db
		.select({
			date: sql<string>`${woDate}::text`,
			name: workouts.name,
			kcal: workouts.kcal,
			source: workouts.source,
			distanceKm: workouts.distanceKm
		})
		.from(workouts)
		.where(sql`${woDate} between ${from}::date and ${to}::date`);
	const m = new Map<string, number>();
	for (const r of rows) {
		const { trusted, kcal } = trustWorkout(r, weightKg);
		if (trusted) m.set(r.date, (m.get(r.date) ?? 0) + kcal);
	}
	return m;
}

export async function correctedDeficitDays(
	fromDate: string,
	toDate: string,
	opts?: { settingsRow?: SettingsRow | null }
): Promise<DayEnergy[]> {
	// Factor + dynamic target come from the calibration window, but trusted-workout
	// kcal must cover the ACTUAL requested range (which may predate that window). The
	// workout formula needs the latest weight the context already resolved.
	const ctx = await resolveCorrection(opts?.settingsRow);
	const trustedByDate = await trustedWorkoutsByDate(fromDate, toDate, ctx.weightKg);
	return deficitDays(fromDate, toDate, {
		settingsRow: opts?.settingsRow,
		correction: { ...ctx.correction, trustedByDate }
	});
}

// ── /energy breakdown page ───────────────────────────────────────────────────
export type DayBreakdown = DayEnergy & {
	trustedKcal: number;
	correctedActiveKcal: number | null;
	correctedBurnedKcal: number | null;
	correctedDeficitKcal: number | null;
	workouts: WorkoutLite[];
};

export type EnergyBreakdown = Omit<EnergyContext, 'correction' | 'windowLedger' | 'woByDate'> & {
	windowDays: number;
	days: DayBreakdown[]; // ascending, raw fields + corrected fields for display
};

export async function energyBreakdown(): Promise<EnergyBreakdown> {
	const ctx = await resolveCorrection();
	// The window ledger in ctx is RAW — apply the correction per day for the
	// raw→corrected display (the page shows both).
	const days: DayBreakdown[] = ctx.windowLedger.map((d) => {
		const trustedKcal = ctx.woByDate.get(d.date)?.kcal ?? 0;
		const ca = correctActive(d.activeKcal ?? 0, trustedKcal, ctx.factor);
		const cb = d.bmrKcal != null ? d.bmrKcal + ca + d.tefKcal : null;
		return {
			...d,
			trustedKcal: Math.round(trustedKcal),
			correctedActiveKcal: d.activeKcal != null ? Math.round(ca) : null,
			correctedBurnedKcal: cb != null ? Math.round(cb) : null,
			correctedDeficitKcal: cb != null ? Math.round(cb - d.intakeKcal) : null,
			workouts: ctx.woByDate.get(d.date)?.list ?? []
		};
	});

	// Strip the internal-only fields; expose the rest for display.
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	const { correction, windowLedger, woByDate, ...view } = ctx;
	return { ...view, windowDays: WINDOW_DAYS, days };
}
