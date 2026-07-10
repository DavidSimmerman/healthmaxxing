import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { bodyComp, activityDays } from '$lib/server/db/schema';
import { requireApiToken } from '$lib/server/auth';
import { recordSync } from '$lib/server/syncStatus';
import { sql } from 'drizzle-orm';

// Ingest endpoint for the iOS wrapper app's HealthKit sync. Everything is an
// upsert: body comp keyed by the HealthKit sample UUID, activity days keyed by
// local date (the current day gets re-pushed with growing totals all day).

type BodyCompIn = {
	hkUuid: string;
	measuredAt: string; // ISO timestamp
	weightKg: number;
	bodyFatPct?: number | null;
	leanMassKg?: number | null;
	source?: string | null;
};

type DayIn = {
	date: string; // 'YYYY-MM-DD' in device-local time
	activeKcal?: number | null;
	basalKcal?: number | null;
	steps?: number | null;
	exerciseMin?: number | null;
};

function num(v: unknown, min: number, max: number, label: string): number | null {
	if (v === undefined || v === null) return null;
	if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
		throw error(400, `invalid ${label}`);
	}
	return v;
}

function parseBodyComp(raw: unknown): BodyCompIn {
	if (typeof raw !== 'object' || raw === null) throw error(400, 'invalid bodyComp entry');
	const r = raw as Record<string, unknown>;
	if (typeof r.hkUuid !== 'string' || !r.hkUuid) throw error(400, 'missing hkUuid');
	const measuredAt = typeof r.measuredAt === 'string' ? r.measuredAt : '';
	if (Number.isNaN(Date.parse(measuredAt))) throw error(400, 'invalid measuredAt');
	const weightKg = num(r.weightKg, 20, 400, 'weightKg');
	if (weightKg === null) throw error(400, 'missing weightKg');
	return {
		hkUuid: r.hkUuid,
		measuredAt,
		weightKg,
		bodyFatPct: num(r.bodyFatPct, 1, 75, 'bodyFatPct'),
		leanMassKg: num(r.leanMassKg, 10, 300, 'leanMassKg'),
		source: typeof r.source === 'string' ? r.source : null
	};
}

function parseDay(raw: unknown): DayIn {
	if (typeof raw !== 'object' || raw === null) throw error(400, 'invalid day entry');
	const r = raw as Record<string, unknown>;
	if (typeof r.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) {
		throw error(400, 'invalid date');
	}
	const steps = num(r.steps, 0, 200_000, 'steps');
	return {
		date: r.date,
		activeKcal: num(r.activeKcal, 0, 20_000, 'activeKcal'),
		basalKcal: num(r.basalKcal, 0, 20_000, 'basalKcal'),
		steps: steps === null ? null : Math.round(steps),
		exerciseMin: num(r.exerciseMin, 0, 1440, 'exerciseMin')
	};
}

export async function POST({ request }) {
	requireApiToken(request);

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'invalid JSON');
	}
	if (typeof body !== 'object' || body === null || Array.isArray(body)) {
		throw error(400, 'expected an object body');
	}
	const { bodyComp: rawComp, days: rawDays } = body as {
		bodyComp?: unknown;
		days?: unknown;
	};
	if (rawComp !== undefined && !Array.isArray(rawComp))
		throw error(400, 'bodyComp must be an array');
	if (rawDays !== undefined && !Array.isArray(rawDays)) throw error(400, 'days must be an array');

	const comp = (rawComp ?? []).map(parseBodyComp);
	const days = (rawDays ?? []).map(parseDay);
	if (comp.length > 1000 || days.length > 1000) throw error(400, 'batch too large');

	try {
		if (comp.length) {
			await db
				.insert(bodyComp)
				.values(
					comp.map((c) => ({
						hkUuid: c.hkUuid,
						measuredAt: new Date(c.measuredAt),
						weightKg: c.weightKg,
						bodyFatPct: c.bodyFatPct,
						leanMassKg: c.leanMassKg,
						source: c.source
					}))
				)
				.onConflictDoUpdate({
					target: bodyComp.hkUuid,
					set: {
						// An edited sample in Apple Health keeps its UUID — mirror the new values.
						measuredAt: sql`excluded.measured_at`,
						weightKg: sql`excluded.weight_kg`,
						bodyFatPct: sql`excluded.body_fat_pct`,
						leanMassKg: sql`excluded.lean_mass_kg`,
						source: sql`excluded.source`
					}
				});
		}

		if (days.length) {
			await db
				.insert(activityDays)
				.values(days)
				.onConflictDoUpdate({
					target: activityDays.date,
					set: {
						activeKcal: sql`excluded.active_kcal`,
						basalKcal: sql`excluded.basal_kcal`,
						steps: sql`excluded.steps`,
						exerciseMin: sql`excluded.exercise_min`,
						updatedAt: new Date()
					}
				});
		}
	} catch (e) {
		await recordSync('healthkit', false, e instanceof Error ? e.message : 'sync failed');
		throw e;
	}

	await recordSync('healthkit', true, `${comp.length} weigh-ins · ${days.length} days`);
	return json({ bodyComp: comp.length, days: days.length });
}
