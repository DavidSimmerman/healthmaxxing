import { error } from '@sveltejs/kit';
import { sql, eq, and, asc, desc } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { dailyLog, foods, bodyComp, workouts, dailyMetrics } from '$lib/server/db/schema';
import { deficitDays } from '$lib/server/deficit';
import { fillBmrGaps } from '$lib/server/projections';
import { APP_TZ, todayLabel } from '$lib/server/day';
import { addDays } from '$lib/energy';
import { bolusableForLoggedEntry } from '$lib/netCarbs';
import { getFiberMode } from '$lib/server/prefs';

export async function load({ params }) {
	const { date } = params;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw error(404, 'bad date');
	// No future days — deficitDays would synthesize a BMR-only "deficit" against
	// zero intake, which is fake data, not a real day.
	const today = todayLabel();
	if (date > today) throw error(404, 'future date');

	const logDate = sql<string>`(${dailyLog.loggedAt} at time zone 'UTC' at time zone ${APP_TZ})::date`;
	const workoutDate = sql<string>`(${workouts.startedAt} at time zone 'UTC' at time zone ${APP_TZ})::date`;
	const compDate = sql<string>`(${bodyComp.measuredAt} at time zone 'UTC' at time zone ${APP_TZ})::date`;

	const [[day], entries, [weighIn], workoutRows, metrics] = await Promise.all([
		// Energy ledger for the single day, with interpolated BMR filled in.
		(async () => fillBmrGaps(await deficitDays(date, date)))(),
		// Everything eaten that day, oldest first.
		db
			.select({
				id: dailyLog.id,
				name: foods.name,
				brand: foods.brand,
				servings: dailyLog.servings,
				amount: dailyLog.amount,
				unit: dailyLog.unit,
				loggedAt: dailyLog.loggedAt,
				calories: dailyLog.calories,
				proteinG: dailyLog.proteinG,
				carbsG: dailyLog.carbsG,
				fatG: dailyLog.fatG,
				foodNutrients: foods.nutrients
			})
			.from(dailyLog)
			.innerJoin(foods, eq(dailyLog.foodId, foods.id))
			.where(sql`${logDate} = ${date}::date`)
			.orderBy(asc(dailyLog.loggedAt)),
		// Latest weigh-in on/before this day.
		db
			.select({
				weightKg: bodyComp.weightKg,
				bodyFatPct: bodyComp.bodyFatPct,
				leanMassKg: bodyComp.leanMassKg,
				measuredAt: bodyComp.measuredAt,
				measuredDate: sql<string>`${compDate}::text`, // local (APP_TZ) date, matches server selection
				source: bodyComp.source
			})
			.from(bodyComp)
			.where(sql`${compDate} <= ${date}::date`)
			.orderBy(desc(bodyComp.measuredAt))
			.limit(1),
		// Workouts that started that day.
		db
			.select({
				hkUuid: workouts.hkUuid,
				name: workouts.name,
				startedAt: workouts.startedAt,
				endedAt: workouts.endedAt,
				kcal: workouts.kcal,
				avgHr: workouts.avgHr,
				maxHr: workouts.maxHr
			})
			.from(workouts)
			.where(sql`${workoutDate} = ${date}::date`)
			.orderBy(asc(workouts.startedAt)),
		// Daily vitals (water, HR, HRV, …) for that day.
		db
			.select({ metric: dailyMetrics.metric, value: dailyMetrics.value })
			.from(dailyMetrics)
			.where(eq(dailyMetrics.date, date))
	]);

	const fiberMode = await getFiberMode();
	const entriesWithBolusable = entries.map((e) => {
		const b = bolusableForLoggedEntry(e.carbsG, e.foodNutrients, e.servings ?? 1, { fiberMode });
		return { ...e, bolusableCarbsG: b.bolusableCarbsG, bolusableLowConfidence: b.lowConfidence };
	});

	return {
		date,
		day,
		entries: entriesWithBolusable,
		weighIn: weighIn ?? null,
		workouts: workoutRows,
		metrics,
		prevDate: addDays(date, -1),
		nextDate: addDays(date, 1),
		today
	};
}
