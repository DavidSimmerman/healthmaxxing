import { sql, and, gte, lte, asc } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { dailyMetrics, activityDays, workouts } from '$lib/server/db/schema';
import { APP_TZ } from '$lib/server/day';

// Read side of the HealthKit sync: pivot the free-form daily_metrics EAV rows
// (vitals, mobility, respiratory, environment, category-event counts…) back into
// one object per day, merged with the activity_days columns and that day's
// workouts. Powers the get_health_metrics MCP tool so Claude can review a day,
// week, or month. Window math lives in $lib/period (periodRange).

export type DayReview = {
	date: string; // YYYY-MM-DD, APP_TZ
	activeKcal: number | null;
	basalKcal: number | null;
	steps: number | null;
	exerciseMin: number | null;
	metrics: Record<string, number>; // metric key -> value (see catalog in mcp tool)
	workouts: { name: string; start: string; end: string | null; kcal: number | null; avgHr: number | null; maxHr: number | null }[];
};

export async function healthReview(from: string, to: string): Promise<DayReview[]> {
	// Workouts: bucket the start timestamp into a local (APP_TZ) date so it lines
	// up with the date-keyed metric/activity rows.
	const woDate = sql<string>`(${workouts.startedAt} at time zone 'UTC' at time zone ${APP_TZ})::date::text`;

	const [metricRows, activityRows, workoutRows] = await Promise.all([
		db
			.select({ date: dailyMetrics.date, metric: dailyMetrics.metric, value: dailyMetrics.value })
			.from(dailyMetrics)
			.where(and(gte(dailyMetrics.date, from), lte(dailyMetrics.date, to))),
		db
			.select()
			.from(activityDays)
			.where(and(gte(activityDays.date, from), lte(activityDays.date, to))),
		db
			.select({
				date: woDate,
				name: workouts.name,
				start: workouts.startedAt,
				end: workouts.endedAt,
				kcal: workouts.kcal,
				avgHr: workouts.avgHr,
				maxHr: workouts.maxHr
			})
			.from(workouts)
			.where(sql`${woDate} between ${from} and ${to}`)
			.orderBy(asc(workouts.startedAt))
	]);

	const byDate = new Map<string, DayReview>();
	const day = (d: string): DayReview => {
		let r = byDate.get(d);
		if (!r) {
			r = { date: d, activeKcal: null, basalKcal: null, steps: null, exerciseMin: null, metrics: {}, workouts: [] };
			byDate.set(d, r);
		}
		return r;
	};

	for (const a of activityRows) {
		const r = day(a.date);
		r.activeKcal = a.activeKcal;
		r.basalKcal = a.basalKcal;
		r.steps = a.steps;
		r.exerciseMin = a.exerciseMin;
	}
	for (const m of metricRows) day(m.date).metrics[m.metric] = m.value;
	for (const w of workoutRows) {
		day(w.date).workouts.push({
			name: w.name,
			start: w.start.toISOString(),
			end: w.end ? w.end.toISOString() : null,
			kcal: w.kcal,
			avgHr: w.avgHr,
			maxHr: w.maxHr
		});
	}

	return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}
