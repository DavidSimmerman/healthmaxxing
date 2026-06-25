import { and, gte, lte, inArray, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { activityDays, dailyMetrics, glucoseReadings, workouts } from '$lib/server/db/schema';
import { deficitDays } from '$lib/server/deficit';
import { APP_TZ } from '$lib/server/day';
import { addDays } from '$lib/energy';
import { periodRange } from '$lib/period';
import {
	scoreDay,
	scorePeriod,
	aggregateDailyGoals,
	currentStreak,
	grade,
	type DayMetrics,
	type GoalResult
} from '$lib/score';

const L_TO_OZ = 33.814; // liters → US fluid ounces
const KM_TO_MI = 0.621371;

// Every metric the scoring engine needs, one row per local (APP_TZ) day in
// [from, to]. Missing data stays null so the engine can exclude it (a day with no
// food logged isn't a "0g protein" day — it's unknown).
export async function dayMetricsForRange(from: string, to: string): Promise<DayMetrics[]> {
	const [energy, steps, metricRows, glucose] = await Promise.all([
		deficitDays(from, to),
		db
			.select({ date: activityDays.date, steps: activityDays.steps })
			.from(activityDays)
			.where(and(gte(activityDays.date, from), lte(activityDays.date, to))),
		db
			.select({ date: dailyMetrics.date, metric: dailyMetrics.metric, value: dailyMetrics.value })
			.from(dailyMetrics)
			.where(
				and(
					gte(dailyMetrics.date, from),
					lte(dailyMetrics.date, to),
					inArray(dailyMetrics.metric, [
						'sleep_min',
						'water_l',
						'glucose_tir_pct',
						'glucose_gmi_pct'
					])
				)
			),
		db
			.select({
				date: glucoseReadings.date,
				total: sql<number>`count(*)::int`,
				over250: sql<number>`count(*) filter (where ${glucoseReadings.mgdl} > 250)::int`,
				below70: sql<number>`count(*) filter (where ${glucoseReadings.mgdl} < 70)::int`
			})
			.from(glucoseReadings)
			.where(and(gte(glucoseReadings.date, from), lte(glucoseReadings.date, to)))
			.groupBy(glucoseReadings.date)
	]);

	const energyBy = new Map(energy.map((e) => [e.date, e]));
	const stepsBy = new Map(steps.map((s) => [s.date, s.steps]));
	const glucoseBy = new Map(glucose.map((g) => [g.date, g]));
	const metricsBy = new Map<string, Record<string, number>>();
	for (const r of metricRows) {
		const m = metricsBy.get(r.date) ?? {};
		m[r.metric] = r.value;
		metricsBy.set(r.date, m);
	}

	const out: DayMetrics[] = [];
	for (let date = from; date <= to; date = addDays(date, 1)) {
		const e = energyBy.get(date);
		const m = metricsBy.get(date) ?? {};
		const g = glucoseBy.get(date);
		// Protein/deficit are only meaningful when something was actually logged.
		const logged = !!e && e.intakeKcal > 0;
		out.push({
			date,
			gmi: m['glucose_gmi_pct'] ?? null,
			tir: m['glucose_tir_pct'] ?? null,
			over250: g && g.total > 0 ? (g.over250 / g.total) * 100 : null,
			below70: g && g.total > 0 ? (g.below70 / g.total) * 100 : null,
			steps: stepsBy.get(date) ?? null,
			sleepMin: m['sleep_min'] ?? null,
			deficit: logged ? (e!.deficitKcal ?? null) : null,
			protein: logged ? e!.proteinG : null,
			waterOz: m['water_l'] != null ? m['water_l'] * L_TO_OZ : null
		});
		if (date === to) break; // guard (addDays always advances, but be explicit)
	}
	return out;
}

// Strength workout count + running miles over [from, to] (workout bucketed to its
// APP_TZ start date). Zero is a real value here (you did zero), not "no data".
export async function periodExtras(
	from: string,
	to: string
): Promise<{ strengthCount: number; runningMiles: number }> {
	const woDate = sql`(${workouts.startedAt} at time zone 'UTC' at time zone ${APP_TZ})::date`;
	const rows = await db
		.select({ name: workouts.name, distanceKm: workouts.distanceKm })
		.from(workouts)
		.where(and(sql`${woDate} >= ${from}::date`, sql`${woDate} <= ${to}::date`));

	let strengthCount = 0;
	let runningKm = 0;
	for (const w of rows) {
		const n = w.name.toLowerCase();
		if (n.includes('strength')) strengthCount++;
		// "running miles (not walking)" — running workouts only.
		if (n.includes('run')) runningKm += w.distanceKm ?? 0;
	}
	return { strengthCount, runningMiles: runningKm * KM_TO_MI };
}

export type GoalsView = {
	period: string;
	from: string;
	to: string;
	score: number | null;
	grade: string;
	base: number | null;
	bonus: number;
	goals: GoalResult[]; // daily-goal rows (day: that day; week/month: period averages)
	weeklyGoals: GoalResult[]; // strength + running (period totals vs target)
	dayScores: { date: string; score: number | null; perfect: boolean; veryBad: boolean }[];
	streak: number;
	perfectDays: number;
	veryBadDays: number;
};

// Everything the /goals page needs for one (period, anchor).
export async function buildGoalsView(
	period: 'day' | 'week' | 'month',
	anchor: string
): Promise<GoalsView> {
	const { from, to } = periodRange(period, anchor);
	const days = await dayMetricsForRange(from, to);
	const dayScores = days.map(scoreDay);

	let score: number | null;
	let base: number | null;
	let bonus: number;
	let goals: GoalResult[];
	let weeklyGoals: GoalResult[];
	let perfectDays: number;

	if (period === 'day') {
		const d = dayScores[0];
		score = d.score;
		base = d.base;
		bonus = d.bonus;
		goals = d.goals;
		perfectDays = d.perfect ? 1 : 0;
		// Weekly context: this trailing week's strength/running progress.
		const wr = periodRange('week', anchor);
		const wExtras = await periodExtras(wr.from, wr.to);
		const wDays = await dayMetricsForRange(wr.from, wr.to);
		weeklyGoals = scorePeriod(wDays, { ...wExtras, days: 7 }).weeklyGoals;
	} else {
		const extras = await periodExtras(from, to);
		const ps = scorePeriod(days, { ...extras, days: days.length });
		score = ps.score;
		base = ps.base;
		bonus = ps.bonus;
		goals = aggregateDailyGoals(dayScores);
		weeklyGoals = ps.weeklyGoals;
		perfectDays = ps.perfectDays;
	}

	// Current streak: independent 60-day lookback so it isn't truncated by the window.
	const lookDays = await dayMetricsForRange(addDays(anchor, -59), anchor);
	const streak = currentStreak(lookDays.map(scoreDay));

	return {
		period,
		from,
		to,
		score,
		grade: grade(score),
		base,
		bonus,
		goals,
		weeklyGoals,
		dayScores: dayScores.map((d) => ({
			date: d.date,
			score: d.score,
			perfect: d.perfect,
			veryBad: d.veryBad
		})),
		streak,
		perfectDays,
		veryBadDays: dayScores.filter((d) => d.veryBad).length
	};
}
