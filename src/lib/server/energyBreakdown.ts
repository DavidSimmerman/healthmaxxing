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
	deficitBank,
	modeDeficit,
	isTrustedWorkoutSource,
	type GoalMode
} from '$lib/energy';

const WINDOW_DAYS = 30;
const MODES: GoalMode[] = ['cut', 'recomp', 'lean_bulk'];

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
	bankKcal: number; // recovery-bank credit folded into the targets today (0 when none / non-cut)
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
				time: sql<string>`to_char((${workouts.startedAt} at time zone 'UTC' at time zone ${APP_TZ}), 'FMHH12:MI AM')`,
				startedAt: sql<string>`${workouts.startedAt}::text`
			})
			.from(workouts)
			.where(sql`${woDate} between ${from}::date and ${today}::date`)
	]);

	const mode = (MODES.includes(s?.goalMode as GoalMode) ? s!.goalMode : 'cut') as GoalMode;

	// Group workouts by local day. ponytail: trust ALL workout kcal as dedicated
	// measurements; narrow to the pad's source once the workout source bundle id is
	// synced (HealthSync.swift). Null kcal counts as 0 trusted.
	const woByDate = new Map<string, { kcal: number; list: WorkoutLite[] }>();
	for (const w of woRows) {
		const trusted = isTrustedWorkoutSource(w.source);
		const e = woByDate.get(w.date) ?? { kcal: 0, list: [] };
		e.kcal += trusted ? (w.kcal ?? 0) : 0; // only trusted kcal count toward the carve-out
		e.list.push({ name: w.name, kcal: w.kcal, time: w.time, startedAt: w.startedAt, trusted });
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
	const latest = insights.body.series.at(-1);
	const bodyFatPct = insights.body.bodyFat?.current ?? latest?.bodyFatPct ?? null;
	const weightKg = insights.body.weight?.current ?? latest?.weightKg ?? null;
	const modeDeltaKcal =
		mode === 'recomp'
			? 0
			: weightKg != null && (mode === 'lean_bulk' || bodyFatPct != null)
				? Math.round(modeDeficit(mode, bodyFatPct ?? 0, weightKg))
				: null;

	// Ratcheting target: real active burned so far only (no forward projection), so it
	// starts conservative and only climbs — never drops out from under you mid-day.
	const todayEntry = windowLedger.find((d) => d.date === today);
	const actualActiveKcalToday = correctActive(
		todayEntry?.activeKcal ?? 0,
		trustedByDate.get(today) ?? 0,
		factor
	);
	// Cushioned baseline (fixed for the day). recomp/lean_bulk get no haircut (targetBaseline).
	const baseKcal =
		maintenanceKcal != null && modeDeltaKcal != null
			? targetBaseline(maintenanceKcal, modeDeltaKcal)
			: null;

	// Recovery bank: ease the deficit for a day or two after a big-deficit day so loss
	// doesn't run away. Cut-only. Measured against the CUSHIONED effective deficit
	// (maintenance − baseline), so ordinary cushioned days don't build it; capped at the
	// mode deficit (−modeDelta) so recovery stops at the cushion floor, never a surplus.
	// From COMPLETED, logged, non-vacation days (same set the calibration trusts); the 0.5/day
	// decay makes days past ~10 ago negligible → no stored state needed.
	let bankKcal = 0;
	if (baseKcal != null && maintenanceKcal != null && modeDeltaKcal != null && modeDeltaKcal < 0) {
		const effectiveGoalKcal = maintenanceKcal - baseKcal; // ≈ 0.1×maintenance + deficit
		const bankDays = completed.map((d) => ({
			deficitKcal:
				d.bmrKcal != null
					? d.bmrKcal +
						correctActive(d.activeKcal ?? 0, trustedByDate.get(d.date) ?? 0, factor) +
						d.tefKcal -
						d.intakeKcal
					: null,
			goalKcal: effectiveGoalKcal
		}));
		bankKcal = Math.round(deficitBank(bankDays, -modeDeltaKcal));
	}

	// The displayed eat-to goal RATCHETS UP for extra exercise (real burn only). The
	// deficit's assumed intake must NOT ratchet: the ratchet rises 1:1 with active kcal
	// above typical, so using it as effIntake would cancel that activity out of the deficit
	// (burn +1, assumed intake +1) and freeze deficit/active-to-go after a workout. So the
	// deficit uses the STABLE baseline (cushioned floor + recovery bank), matching the
	// ratchet's base; only the displayed goal ratchets above it.
	const stableTargetKcal = baseKcal != null ? Math.round(baseKcal + bankKcal) : null;
	let targetKcal: number | null = stableTargetKcal; // ratchet; falls back to stable with no active history
	if (baseKcal != null && avgCorrectedActive != null) {
		targetKcal = Math.round(
			ratchetTarget({
				maintenanceKcal: maintenanceKcal!,
				modeDeltaKcal: modeDeltaKcal!,
				avgActiveKcal: avgCorrectedActive,
				actualActiveKcal: actualActiveKcalToday,
				bankKcal
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
		bankKcal,
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
async function trustedWorkoutsByDate(from: string, to: string): Promise<Map<string, number>> {
	const woDate = sql<string>`(${workouts.startedAt} at time zone 'UTC' at time zone ${APP_TZ})::date`;
	const rows = await db
		.select({ date: sql<string>`${woDate}::text`, kcal: workouts.kcal, source: workouts.source })
		.from(workouts)
		.where(sql`${woDate} between ${from}::date and ${to}::date`);
	const m = new Map<string, number>();
	for (const r of rows)
		if (isTrustedWorkoutSource(r.source)) m.set(r.date, (m.get(r.date) ?? 0) + (r.kcal ?? 0));
	return m;
}

export async function correctedDeficitDays(
	fromDate: string,
	toDate: string,
	opts?: { settingsRow?: SettingsRow | null }
): Promise<DayEnergy[]> {
	// Factor + dynamic target come from the calibration window, but trusted-workout
	// kcal must cover the ACTUAL requested range (which may predate that window).
	const [ctx, trustedByDate] = await Promise.all([
		resolveCorrection(opts?.settingsRow),
		trustedWorkoutsByDate(fromDate, toDate)
	]);
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
