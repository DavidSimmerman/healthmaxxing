import { sql, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { workouts, settings } from '$lib/server/db/schema';
import { APP_TZ, todayLabel } from '$lib/server/day';
import { deficitDays, type DayEnergy, type DayCorrection } from '$lib/server/deficit';
import { fillBmrGaps, energyInsights } from '$lib/server/projections';
import {
	addDays,
	correctActive,
	activeCorrectionFactor,
	activityBuckets,
	wakingFractionRemaining,
	liveTarget,
	modeDeficit,
	type GoalMode
} from '$lib/energy';

const WINDOW_DAYS = 30;
const MODES: GoalMode[] = ['cut', 'recomp', 'lean_bulk'];

export type WorkoutLite = { name: string; kcal: number | null; time: string; startedAt: string };

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
	targetKcal: number | null; // = correction.todayTargetKcal
	fixedCalorieTarget: number; // the user's configured settings.calorieTarget (fallback)
	// Active averages (corrected) + today's live inputs
	avgRawActive: number | null;
	avgCorrectedActive: number | null;
	avgTrustedKcal: number | null;
	buckets: number[]; // 5 activity-level representatives (corrected active)
	activityLevel: number | null; // today's override 0–4, or null (auto)
	fractionRemaining: number;
	// Reusable so callers don't re-query
	windowLedger: DayEnergy[]; // RAW, fillBmrGaps'd, [today-30 … today]
	woByDate: Map<string, { kcal: number; list: WorkoutLite[] }>;
};

function nowHourInAppTz(): number {
	return Number(
		new Intl.DateTimeFormat('en-US', { timeZone: APP_TZ, hour: '2-digit', hour12: false }).format(
			new Date()
		)
	);
}

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
		const e = woByDate.get(w.date) ?? { kcal: 0, list: [] };
		e.kcal += w.kcal ?? 0;
		e.list.push({ name: w.name, kcal: w.kcal, time: w.time, startedAt: w.startedAt });
		woByDate.set(w.date, e);
	}
	const trustedByDate = new Map([...woByDate].map(([d, v]) => [d, v.kcal]));

	// Correction factor from COMPLETED, logged days (today's partial excluded).
	const completed = windowLedger.filter(
		(d) => d.date < today && d.intakeKcal > 0 && d.burnedKcal != null
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

	// Per-day corrected active over completed days → avg + activity buckets.
	const correctedActives = completed.map((d) =>
		correctActive(d.activeKcal ?? 0, trustedByDate.get(d.date) ?? 0, factor)
	);
	const avgCorrectedActive = mean(correctedActives);
	const buckets = activityBuckets(correctedActives);

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

	// Live intraday target for today.
	const todayEntry = windowLedger.find((d) => d.date === today);
	const actualActiveKcalToday = correctActive(
		todayEntry?.activeKcal ?? 0,
		trustedByDate.get(today) ?? 0,
		factor
	);
	const activityLevel =
		s?.activityLevelDate === today && s?.activityLevel != null
			? Math.min(4, Math.max(0, s.activityLevel))
			: null;
	const levelActiveKcal =
		activityLevel != null && buckets.length ? buckets[activityLevel] : avgCorrectedActive;
	const fractionRemaining = wakingFractionRemaining(nowHourInAppTz());

	let targetKcal: number | null = null;
	if (maintenanceKcal != null && modeDeltaKcal != null) {
		targetKcal =
			avgCorrectedActive != null && levelActiveKcal != null
				? Math.round(
						liveTarget({
							maintenanceKcal,
							modeDeltaKcal,
							avgActiveKcal: avgCorrectedActive,
							actualActiveKcal: actualActiveKcalToday,
							levelActiveKcal,
							fractionRemaining
						})
					)
				: Math.round(maintenanceKcal + modeDeltaKcal); // stable fallback (no active history)
	}

	return {
		today,
		mode,
		correction: { factor, trustedByDate, todayTargetKcal: targetKcal },
		factor,
		maintenanceKcal,
		maintenanceSource,
		calibratedTdee: insights.calibratedTdee,
		estimatedTdee: insights.estimatedTdee,
		bodyFatPct,
		weightKg,
		modeDeltaKcal,
		targetKcal,
		avgRawActive: avgRawActive != null ? Math.round(avgRawActive) : null,
		avgCorrectedActive: avgCorrectedActive != null ? Math.round(avgCorrectedActive) : null,
		avgTrustedKcal: avgTrusted != null ? Math.round(avgTrusted) : null,
		buckets,
		activityLevel,
		fractionRemaining,
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
		.select({ date: sql<string>`${woDate}::text`, kcal: workouts.kcal })
		.from(workouts)
		.where(sql`${woDate} between ${from}::date and ${to}::date`);
	const m = new Map<string, number>();
	for (const r of rows) m.set(r.date, (m.get(r.date) ?? 0) + (r.kcal ?? 0));
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
