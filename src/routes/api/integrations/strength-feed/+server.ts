import { json, error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { timingSafeEqual } from 'node:crypto';
import { and, desc, eq, gte, inArray, not, ilike } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { bodyComp, dailyLog, dailyMetrics, settings, workouts } from '$lib/server/db/schema';

// Read-only feed for strengthmaxxing's coach: other training (runs, basketball…), food log
// timing + protein, sleep / HRV / resting HR, body composition and profile. Its own bearer,
// STRENGTHMAXXING_TOKEN, so the lifting app never holds healthmaxxing's read/write API_TOKEN.
// Public in hooks.server.ts (the cookie/API_TOKEN gate would refuse it) and fails closed:
// with no token configured nothing is served.
function tokenOk(request: Request): boolean {
	const want = env.STRENGTHMAXXING_TOKEN;
	if (!want) return false;
	const h = request.headers.get('authorization') ?? '';
	const got = Buffer.from(h.startsWith('Bearer ') ? h.slice(7) : '');
	const exp = Buffer.from(want);
	return got.length === exp.length && timingSafeEqual(got, exp);
}

export async function GET({ request, url }) {
	if (!tokenOk(request)) throw error(401, 'Unauthorized');
	const days = Math.min(30, Math.max(1, Number(url.searchParams.get('days')) || 7));
	const since = new Date(Date.now() - days * 864e5);
	const sinceDay = since.toISOString().slice(0, 10);

	const [w, food, metrics, body, s] = await Promise.all([
		db
			.select({
				name: workouts.name,
				startedAt: workouts.startedAt,
				endedAt: workouts.endedAt,
				distanceKm: workouts.distanceKm,
				avgHr: workouts.avgHr,
				kcal: workouts.kcal
			})
			.from(workouts)
			// strengthmaxxing writes its own lifting sessions to Apple Health; don't echo them back
			.where(and(gte(workouts.startedAt, since), not(ilike(workouts.name, '%strength%'))))
			.orderBy(workouts.startedAt),
		db
			.select({ loggedAt: dailyLog.loggedAt, calories: dailyLog.calories, proteinG: dailyLog.proteinG })
			.from(dailyLog)
			.where(and(gte(dailyLog.loggedAt, since), eq(dailyLog.pending, false)))
			.orderBy(dailyLog.loggedAt),
		db
			.select({ date: dailyMetrics.date, metric: dailyMetrics.metric, value: dailyMetrics.value })
			.from(dailyMetrics)
			.where(and(gte(dailyMetrics.date, sinceDay), inArray(dailyMetrics.metric, ['sleep_min', 'hrv_ms', 'resting_hr'])))
			.orderBy(dailyMetrics.date),
		db
			.select({
				measuredAt: bodyComp.measuredAt,
				weightKg: bodyComp.weightKg,
				bodyFatPct: bodyComp.bodyFatPct,
				leanMassKg: bodyComp.leanMassKg
			})
			.from(bodyComp)
			.where(gte(bodyComp.measuredAt, new Date(Date.now() - 30 * 864e5)))
			.orderBy(desc(bodyComp.measuredAt)),
		db
			.select({
				heightCm: settings.heightCm,
				sex: settings.sex,
				birthDate: settings.birthDate,
				calorieTarget: settings.calorieTarget,
				proteinTargetG: settings.proteinTargetG,
				goalMode: settings.goalMode,
				goalBodyFatPct: settings.goalBodyFatPct
			})
			.from(settings)
			.where(eq(settings.id, 1))
	]);

	const daily: Record<string, { sleepMin?: number; hrvMs?: number; restingHr?: number }> = {};
	const KEY = { sleep_min: 'sleepMin', hrv_ms: 'hrvMs', resting_hr: 'restingHr' } as const;
	for (const m of metrics) (daily[m.date] ??= {})[KEY[m.metric as keyof typeof KEY]] = m.value;

	return json({ days, workouts: w, food, daily, body, profile: s[0] ?? null });
}
