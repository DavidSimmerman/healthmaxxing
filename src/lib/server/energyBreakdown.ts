import { sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { workouts } from '$lib/server/db/schema';
import { APP_TZ, todayLabel } from '$lib/server/day';
import { deficitDays, type DayEnergy } from '$lib/server/deficit';
import { fillBmrGaps, energyInsights } from '$lib/server/projections';
import {
	addDays,
	correctActive,
	activeCorrectionFactor,
	modeDeficit,
	type GoalMode
} from '$lib/energy';

const WINDOW_DAYS = 30;

export type WorkoutLite = { name: string; kcal: number | null; time: string; startedAt: string };

export type DayBreakdown = DayEnergy & {
	trustedKcal: number; // dedicated workout kcal that day (already inside activeKcal)
	correctedActiveKcal: number | null;
	correctedBurnedKcal: number | null;
	correctedDeficitKcal: number | null;
	workouts: WorkoutLite[];
};

export type EnergyBreakdown = {
	today: string;
	windowDays: number;
	mode: GoalMode;
	// Correction
	factor: number; // passive-active haircut (1 = no correction)
	avgRawActive: number | null;
	avgCorrectedActive: number | null;
	avgTrustedKcal: number | null;
	// Maintenance + target
	maintenanceKcal: number | null;
	maintenanceSource: 'calibrated' | 'estimated' | null;
	calibratedTdee: number | null;
	estimatedTdee: number | null;
	bodyFatPct: number | null;
	weightKg: number | null;
	modeDeltaKcal: number | null; // signed: negative = deficit
	targetKcal: number | null;
	days: DayBreakdown[]; // ascending
};

const mean = (xs: number[]): number | null =>
	xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

// Per-day energy with the active-energy correction applied, plus the window's
// calibrated maintenance, correction factor, and the mode's dynamic target.
// Built as a composable layer over the RAW ledger — deficitDays stays untouched
// so the calibration (which never uses active energy) can't feed back on itself.
export async function energyBreakdown(mode: GoalMode): Promise<EnergyBreakdown> {
	const today = todayLabel();
	const from = addDays(today, -WINDOW_DAYS);

	const woDate = sql<string>`(${workouts.startedAt} at time zone 'UTC' at time zone ${APP_TZ})::date`;
	const [insights, ledger, woRows] = await Promise.all([
		energyInsights({ windowDays: WINDOW_DAYS }),
		deficitDays(from, today).then(fillBmrGaps),
		db
			.select({
				date: sql<string>`${woDate}::text`,
				name: workouts.name,
				kcal: workouts.kcal,
				// Clock time formatted server-side in APP_TZ — started_at is stored
				// naive-UTC, so a client `new Date()` would render the wrong zone.
				time: sql<string>`to_char((${workouts.startedAt} at time zone 'UTC' at time zone ${APP_TZ}), 'FMHH12:MI AM')`,
				startedAt: sql<string>`${workouts.startedAt}::text`
			})
			.from(workouts)
			.where(sql`${woDate} between ${from}::date and ${today}::date`)
	]);

	// Group workouts by local day. ponytail: trust ALL workout kcal as dedicated
	// measurements for now; narrow to the pad's source once we sync the workout
	// source bundle id (HealthSync.swift). Null kcal counts as 0 trusted.
	const woByDate = new Map<string, { kcal: number; list: WorkoutLite[] }>();
	for (const w of woRows) {
		const e = woByDate.get(w.date) ?? { kcal: 0, list: [] };
		e.kcal += w.kcal ?? 0;
		e.list.push({ name: w.name, kcal: w.kcal, time: w.time, startedAt: w.startedAt });
		woByDate.set(w.date, e);
	}

	// Correction factor from COMPLETED, logged days (today's partial excluded).
	const completed = ledger.filter(
		(d) => d.date < today && d.intakeKcal > 0 && d.burnedKcal != null
	);
	const avgBmr = mean(completed.map((d) => d.bmrKcal ?? 0));
	const avgTef = mean(completed.map((d) => d.tefKcal));
	const avgActive = mean(completed.map((d) => d.activeKcal ?? 0));
	const avgTrusted = mean(completed.map((d) => woByDate.get(d.date)?.kcal ?? 0));
	const realActiveAvg =
		insights.calibratedTdee != null && avgBmr != null && avgTef != null
			? insights.calibratedTdee - avgBmr - avgTef
			: null;
	const factor =
		realActiveAvg != null && avgActive != null && avgTrusted != null
			? activeCorrectionFactor(realActiveAvg, avgActive, avgTrusted)
			: 1;

	const days: DayBreakdown[] = ledger.map((d) => {
		const wo = woByDate.get(d.date);
		const trustedKcal = wo?.kcal ?? 0;
		const ca = d.activeKcal != null ? correctActive(d.activeKcal, trustedKcal, factor) : null;
		const cb = d.bmrKcal != null && ca != null ? d.bmrKcal + ca + d.tefKcal : null;
		return {
			...d,
			trustedKcal: Math.round(trustedKcal),
			correctedActiveKcal: ca != null ? Math.round(ca) : null,
			correctedBurnedKcal: cb != null ? Math.round(cb) : null,
			correctedDeficitKcal: cb != null ? Math.round(cb - d.intakeKcal) : null,
			workouts: wo?.list ?? []
		};
	});

	const avgCorrectedActive = mean(
		completed
			.map((d) => days.find((x) => x.date === d.date)?.correctedActiveKcal)
			.filter((v): v is number => v != null)
	);

	const maintenanceKcal = insights.calibratedTdee ?? insights.estimatedTdee ?? null;
	const maintenanceSource =
		insights.calibratedTdee != null
			? 'calibrated'
			: insights.estimatedTdee != null
				? 'estimated'
				: null;
	const bodyFatPct = insights.body.bodyFat?.current ?? null;
	const weightKg = insights.body.weight?.current ?? null;
	const modeDeltaKcal =
		bodyFatPct != null && weightKg != null
			? Math.round(modeDeficit(mode, bodyFatPct, weightKg))
			: null;
	const targetKcal =
		maintenanceKcal != null && modeDeltaKcal != null
			? Math.round(maintenanceKcal + modeDeltaKcal)
			: null;

	return {
		today,
		windowDays: WINDOW_DAYS,
		mode,
		factor,
		avgRawActive: avgActive != null ? Math.round(avgActive) : null,
		avgCorrectedActive,
		avgTrustedKcal: avgTrusted != null ? Math.round(avgTrusted) : null,
		maintenanceKcal,
		maintenanceSource,
		calibratedTdee: insights.calibratedTdee,
		estimatedTdee: insights.estimatedTdee,
		bodyFatPct,
		weightKg,
		modeDeltaKcal,
		targetKcal,
		days
	};
}
