import { and, gte, lte, inArray, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import {
	activityDays,
	dailyMetrics,
	glucoseReadings,
	pumpGlucose,
	workouts
} from '$lib/server/db/schema';
import { deficitDays } from '$lib/server/deficit';
import { APP_TZ, todayLabel } from '$lib/server/day';
import { addDays } from '$lib/energy';
import { weekToDate } from '$lib/period';
import { glucoseStats } from '$lib/glucose';
import { loadSpecsFor } from '$lib/server/vacations';
import {
	scoreDay,
	scorePeriod,
	currentStreak,
	grade,
	weekBalances,
	SPEC,
	VACATION_SPECS,
	type SpecMap,
	type DayMetrics,
	type GoalResult,
	type BonusPart
} from '$lib/score';

const L_TO_OZ = 33.814; // liters → US fluid ounces
const KM_TO_MI = 0.621371;

// Every metric the scoring engine needs, one row per local (APP_TZ) day in
// [from, to]. Missing data stays null so the engine can exclude it (a day with no
// food logged isn't a "0g protein" day — it's unknown).
export async function dayMetricsForRange(from: string, to: string): Promise<DayMetrics[]> {
	const [energy, steps, metricRows, dexcomGlucose, pumpGlucoseRows] = await Promise.all([
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
			.groupBy(glucoseReadings.date),
		// Tandem pump CGM (raw) — per-day fallback for days Dexcom couldn't be pulled.
		db
			.select({ date: pumpGlucose.date, mgdl: pumpGlucose.mgdl })
			.from(pumpGlucose)
			.where(and(gte(pumpGlucose.date, from), lte(pumpGlucose.date, to)))
	]);

	const energyBy = new Map(energy.map((e) => [e.date, e]));
	const stepsBy = new Map(steps.map((s) => [s.date, s.steps]));

	const dexcomBy = new Map(dexcomGlucose.map((g) => [g.date, g]));
	const pumpByDate = new Map<string, number[]>();
	for (const r of pumpGlucoseRows) {
		const a = pumpByDate.get(r.date);
		if (a) a.push(r.mgdl);
		else pumpByDate.set(r.date, [r.mgdl]);
	}

	// Per-day glucose goal inputs. Prefer Dexcom; on a day Dexcom couldn't be pulled
	// (no readings), fall back to the Tandem pump's CGM — same clinical stats (TIR
	// 70–180, GMI). Hyperglycemia goal counts readings > 250.
	const glucoseFor = (date: string, m: Record<string, number>) => {
		const dex = dexcomBy.get(date);
		if (dex && dex.total > 0) {
			return {
				over250: (dex.over250 / dex.total) * 100,
				below70: (dex.below70 / dex.total) * 100,
				tir: m['glucose_tir_pct'] ?? null,
				gmi: m['glucose_gmi_pct'] ?? null
			};
		}
		const vals = pumpByDate.get(date);
		const s = vals ? glucoseStats(vals) : null;
		if (!s) return { over250: null, below70: null, tir: null, gmi: null };
		return {
			over250: (vals!.filter((x) => x > 250).length / s.n) * 100,
			below70: s.belowPct,
			tir: s.tirPct,
			gmi: s.gmiPct
		};
	};

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
		const gl = glucoseFor(date, m);
		// Protein/deficit are only meaningful when something was actually logged.
		const logged = !!e && e.intakeKcal > 0;
		out.push({
			date,
			gmi: gl.gmi,
			tir: gl.tir,
			over250: gl.over250,
			below70: gl.below70,
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

export type PeriodSummary = {
	from: string;
	to: string;
	completedDays: number; // days that counted toward the averages (excludes today)
	score: number | null;
	grade: string;
	bonus: number;
	bonusParts: BonusPart[];
	goals: GoalResult[]; // each daily goal scored on its average over completed days
	weeklyGoals: GoalResult[]; // strength + running
};

export type GoalsView = {
	date: string;
	day: {
		score: number | null;
		grade: string;
		base: number | null;
		bonus: number;
		bonusParts: BonusPart[];
		goals: GoalResult[];
		streak: number;
		vacation: boolean; // this day falls inside a trip → relaxed targets applied
	};
	week: PeriodSummary;
	month: PeriodSummary;
};

// Score a calendar period [from, to]. Daily goals are averaged over COMPLETED days
// only (date < today) — today/future would drag the average. Strength/running count
// through today (or the period end if it's already past), against a target prorated
// to `periodDays` (7 for a week, the month length for a month).
async function periodSummary(
	from: string,
	to: string,
	periodDays: number,
	specsFor: (date: string) => SpecMap
): Promise<PeriodSummary> {
	const today = todayLabel();
	const completed = (await dayMetricsForRange(from, to)).filter((d) => d.date < today);
	const extraTo = to < today ? to : today;
	const extras =
		extraTo >= from ? await periodExtras(from, extraTo) : { strengthCount: 0, runningMiles: 0 };
	// Prorate the weekly strength/running targets to the days ELAPSED so far (not the
	// full period), so mid-week the score reflects the pace you're on: 1 workout by
	// Tuesday scores against ~2 expected by Tuesday, not 5 for the whole week. A
	// finished period elapses fully → unchanged; a fully-future one keeps the full target.
	const elapsedDays =
		extraTo >= from
			? Math.min(periodDays, Math.round((Date.parse(extraTo) - Date.parse(from)) / 86_400_000) + 1)
			: periodDays;
	// Rollup regime is a property of the CALENDAR period, not of how much has elapsed:
	// count vacation days across the whole [from, to] so an in-progress week/month
	// doesn't flip targets as days complete.
	let vacDays = 0;
	let totalDays = 0;
	for (let d = from; d <= to; d = addDays(d, 1)) {
		totalDays++;
		if (specsFor(d) === VACATION_SPECS) vacDays++;
		if (d === to) break;
	}
	const rollupSpecs = vacDays * 2 > totalDays ? VACATION_SPECS : SPEC;

	const ps = scorePeriod(completed, { ...extras, days: elapsedDays }, specsFor, rollupSpecs);
	return {
		from,
		to,
		completedDays: completed.length,
		score: ps.score,
		grade: grade(ps.score),
		bonus: ps.bonus,
		bonusParts: ps.bonusParts,
		goals: ps.dailyGoals,
		weeklyGoals: ps.weeklyGoals
	};
}

// Everything the /goals page needs for the selected day, plus its week & month rollups.
export async function buildGoalsView(anchor: string): Promise<GoalsView> {
	// Per-day targets: normal, or relaxed for days inside a trip window.
	const specsFor = await loadSpecsFor();

	// Bank/debt entering `anchor`: the running surplus/shortfall over this week's
	// days BEFORE it. Sunday (week start) → no prior days → no carry-over.
	const balWeekStart = weekToDate(anchor).from;
	const priorDays =
		anchor > balWeekStart ? await dayMetricsForRange(balWeekStart, addDays(anchor, -1)) : [];
	const day = scoreDay(
		(await dayMetricsForRange(anchor, anchor))[0],
		weekBalances(priorDays, specsFor),
		specsFor(anchor)
	);

	// Current streak ending on `anchor`: walk back in 60-day chunks until a
	// non-perfect day, so a long run isn't truncated by a fixed window. The
	// 20-iteration cap (~3 years) is just an infinite-loop backstop.
	let streak = 0;
	for (let end = anchor, i = 0; i < 20; i++) {
		const chunk = (await dayMetricsForRange(addDays(end, -59), end)).map((d) =>
			scoreDay(d, {}, specsFor(d.date))
		);
		const s = currentStreak(chunk);
		streak += s;
		if (s < chunk.length) break;
		end = addDays(end, -60);
	}

	const weekStart = weekToDate(anchor).from; // Sunday
	const ym = anchor.slice(0, 7);
	const [y, mo] = anchor.split('-').map(Number);
	const lastDom = new Date(Date.UTC(y, mo, 0)).getUTCDate(); // last day of anchor's month
	const [week, month] = await Promise.all([
		periodSummary(weekStart, addDays(weekStart, 6), 7, specsFor),
		periodSummary(`${ym}-01`, `${ym}-${String(lastDom).padStart(2, '0')}`, lastDom, specsFor)
	]);

	return {
		date: anchor,
		day: {
			score: day.score,
			grade: grade(day.score),
			base: day.base,
			bonus: day.bonus,
			bonusParts: day.bonusParts,
			goals: day.goals,
			streak,
			vacation: specsFor(anchor) === VACATION_SPECS
		},
		week,
		month
	};
}
