import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { dailyMetrics } from '$lib/server/db/schema';
import { requireApiToken } from '$lib/server/auth';
import { sql } from 'drizzle-orm';

// Daily-vitals ingest from the iOS app: water, resting/min/avg/max heart rate,
// HRV, SpO2, respiratory rate, VO2max, BMI — one value per (date, metric),
// recomputed and re-pushed for a trailing window each sync (same upsert-by-day
// mechanism as /api/healthkit's activity days). The metric name is free-form
// (validated shape, not a whitelist) so the app can ship a new metric without a
// server release.

type MetricIn = { date: string; metric: string; value: number };

function parseMetric(raw: unknown): MetricIn {
	if (typeof raw !== 'object' || raw === null) throw error(400, 'invalid metric entry');
	const r = raw as Record<string, unknown>;
	if (typeof r.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) {
		throw error(400, 'invalid date');
	}
	if (typeof r.metric !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(r.metric)) {
		throw error(400, 'invalid metric name');
	}
	if (
		typeof r.value !== 'number' ||
		!Number.isFinite(r.value) ||
		r.value < -100_000 ||
		r.value > 1_000_000
	) {
		throw error(400, `invalid value for ${r.metric}`);
	}
	return { date: r.date, metric: r.metric, value: r.value };
}

export async function POST({ request }) {
	requireApiToken(request);

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'invalid JSON');
	}
	const { metrics: rawMetrics } = (body ?? {}) as Record<string, unknown>;
	if (!Array.isArray(rawMetrics)) throw error(400, 'metrics must be an array');

	const parsed = rawMetrics.map(parseMetric);
	if (parsed.length > 2000) throw error(400, 'batch too large');

	if (parsed.length) {
		await db
			.insert(dailyMetrics)
			.values(parsed)
			.onConflictDoUpdate({
				target: [dailyMetrics.date, dailyMetrics.metric],
				set: { value: sql`excluded.value`, updatedAt: new Date() }
			});
	}

	return json({ metrics: parsed.length });
}
