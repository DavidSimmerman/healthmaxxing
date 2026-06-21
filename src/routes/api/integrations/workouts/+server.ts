import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { workouts } from '$lib/server/db/schema';
import { requireApiToken } from '$lib/server/auth';
import { sql } from 'drizzle-orm';

// Ingest endpoint for HKWorkout sessions pushed by the iOS app (anchored query —
// only new/edited workouts arrive). Upsert keyed by the HealthKit sample UUID,
// mirroring the /api/healthkit conventions.

type WorkoutIn = {
	hkUuid: string;
	name: string;
	start: string; // ISO timestamp
	end?: string | null;
	kcal?: number | null;
	avgHr?: number | null;
	maxHr?: number | null;
};

function num(v: unknown, min: number, max: number, label: string): number | null {
	if (v === undefined || v === null) return null;
	if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
		throw error(400, `invalid ${label}`);
	}
	return v;
}

function parseWorkout(raw: unknown): WorkoutIn {
	if (typeof raw !== 'object' || raw === null) throw error(400, 'invalid workout entry');
	const r = raw as Record<string, unknown>;
	if (typeof r.hkUuid !== 'string' || !r.hkUuid) throw error(400, 'missing hkUuid');
	if (typeof r.name !== 'string' || !r.name) throw error(400, 'missing name');
	const start = typeof r.start === 'string' ? r.start : '';
	if (Number.isNaN(Date.parse(start))) throw error(400, 'invalid start');
	let end: string | null = null;
	if (r.end !== undefined && r.end !== null) {
		if (typeof r.end !== 'string' || Number.isNaN(Date.parse(r.end)))
			throw error(400, 'invalid end');
		end = r.end;
	}
	return {
		hkUuid: r.hkUuid,
		name: r.name,
		start,
		end,
		kcal: num(r.kcal, 0, 20_000, 'kcal'),
		avgHr: num(r.avgHr, 20, 250, 'avgHr'),
		maxHr: num(r.maxHr, 20, 260, 'maxHr')
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
	const { workouts: rawWorkouts } = (body ?? {}) as Record<string, unknown>;
	if (!Array.isArray(rawWorkouts)) throw error(400, 'workouts must be an array');

	const parsed = rawWorkouts.map(parseWorkout);
	// First-ever sync posts the entire workout history in ONE un-chunked batch
	// (the client doesn't chunk these like it does body comp), so the cap has to
	// clear a realistic lifetime of workouts. ponytail: 5000 ≈ 13 yrs of daily
	// workouts and stays under Postgres's ~9362-row bind-param ceiling (7 cols);
	// if anyone ever exceeds it, chunk the insert below in slices of ~500.
	if (parsed.length > 5000) throw error(400, 'batch too large');

	if (parsed.length) {
		await db
			.insert(workouts)
			.values(
				parsed.map((w) => ({
					hkUuid: w.hkUuid,
					name: w.name,
					startedAt: new Date(w.start),
					endedAt: w.end ? new Date(w.end) : null,
					kcal: w.kcal,
					avgHr: w.avgHr,
					maxHr: w.maxHr
				}))
			)
			.onConflictDoUpdate({
				target: workouts.hkUuid,
				set: {
					// An edited workout in Apple Health keeps its UUID — mirror the new values.
					name: sql`excluded.name`,
					startedAt: sql`excluded.started_at`,
					endedAt: sql`excluded.ended_at`,
					kcal: sql`excluded.kcal`,
					avgHr: sql`excluded.avg_hr`,
					maxHr: sql`excluded.max_hr`
				}
			});
	}

	return json({ workouts: parsed.length });
}
