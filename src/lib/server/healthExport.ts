import { eq, and, gte, lte } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { sleepStages, settings } from '$lib/server/db/schema';
import { nutritionReport, logEntries } from '$lib/server/nutrition';
import { healthReview, type DayReview } from '$lib/server/healthMetrics';
import { deficitDays } from '$lib/server/deficit';
import { fillBmrGaps, bodyInsights } from '$lib/server/projections';
import { todayLabel } from '$lib/server/day';

// The data-export registry behind the export_data MCP tool. Each category is a
// thin adapter over an EXISTING server function (nutritionReport, healthReview,
// deficitDays, bodyInsights …) — nothing here re-queries data those already
// expose. The scheduled Claude review pulls 'all' for a full picture; a focused
// follow-up pulls one category so it fetches only what it needs.
//
// ponytail: adding a future category = ONE new entry in EXPORT_CATEGORIES. The
// 'all' bundle and the tool's validation both derive from this map, so a new
// category flows through with zero other edits.

// What counts as a "sleep" metric for export bucketing. Almost all use the
// `sleep_` prefix, but Fitbit time-in-bed is stored as `time_in_bed_min` (no
// prefix) — so name it explicitly. Used by BOTH the sleep filter (include) and
// the vitals filter (exclude) so the two never disagree.
function isSleepMetric(key: string): boolean {
	return key.startsWith('sleep_') || key === 'time_in_bed_min';
}

// Per-day vitals/activity row stripped to the metrics for a given category.
function spanDays(from: string, to: string): number {
	return (
		Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000) + 1
	);
}

// Sleep aggregates: the sleep_* keys per night from healthReview, plus the
// per-night stage timeline from sleep_stages.
async function sleepExport(from: string, to: string) {
	const [days, stages] = await Promise.all([
		healthReview(from, to),
		db
			.select()
			.from(sleepStages)
			.where(and(gte(sleepStages.date, from), lte(sleepStages.date, to)))
	]);
	const nights = days
		.map((d) => {
			const m: Record<string, number> = {};
			for (const [k, v] of Object.entries(d.metrics)) if (isSleepMetric(k)) m[k] = v;
			return { date: d.date, metrics: m };
		})
		.filter((n) => Object.keys(n.metrics).length > 0);
	const timeline = stages.map((s) => ({
		date: s.date,
		startAt: s.startAt.toISOString(),
		endAt: s.endAt.toISOString(),
		segments: s.segments
	}));
	return { nights, timeline };
}

// Vitals: every per-day metric EXCEPT the sleep_* keys (those go to `sleep`).
// Stripping by prefix means a future daily_metrics key (e.g. blood_glucose_mgdl)
// lands in `vitals` automatically — no code change.
function vitalsRow(d: DayReview) {
	const metrics: Record<string, number> = {};
	for (const [k, v] of Object.entries(d.metrics)) if (!isSleepMetric(k)) metrics[k] = v;
	return { date: d.date, metrics };
}

export const EXPORT_CATEGORIES: Record<
	string,
	(from: string, to: string) => Promise<unknown>
> = {
	nutrition: async (from, to) => ({
		totals: await nutritionReport(from, to),
		log: await logEntries(from, to)
	}),
	sleep: (from, to) => sleepExport(from, to),
	vitals: async (from, to) => (await healthReview(from, to)).map(vitalsRow),
	activity: async (from, to) =>
		(await healthReview(from, to)).map((d) => ({
			date: d.date,
			activeKcal: d.activeKcal,
			basalKcal: d.basalKcal,
			steps: d.steps,
			exerciseMin: d.exerciseMin
		})),
	workouts: async (from, to) =>
		(await healthReview(from, to)).flatMap((d) => d.workouts.map((w) => ({ date: d.date, ...w }))),
	// ponytail: body composition moves slowly, so fit the trend over ≥90 days
	// regardless of the requested period — a 7-day window has too few weigh-ins.
	// bodyInsights is a live "as of today" trend/projection (its series cutoff,
	// deficit window and projections all anchor on today), so a HISTORICAL export
	// window can't be back-dated honestly — omit it with a note rather than mix
	// today's weigh-ins into a past report. The scheduled review uses today, so the
	// common path returns the full trend.
	body: async (from, to) =>
		to === todayLabel()
			? bodyInsights({ windowDays: Math.max(spanDays(from, to), 90) })
			: {
					asOf: to,
					note: 'Body composition is a live "as of today" trend and is not back-dated; it is omitted for historical export windows. Request a current-period export, or use get_body_trends.'
				},
	energy: async (from, to) => fillBmrGaps(await deficitDays(from, to))
};

export type ExportCategory = keyof typeof EXPORT_CATEGORIES;

export const EXPORT_CATEGORY_NAMES = Object.keys(EXPORT_CATEGORIES);

// Run one category, or 'all' to bundle every category keyed by name plus the
// settings notes (the free-text context the user leaves for the review).
export async function runExport(category: string, from: string, to: string): Promise<unknown> {
	if (category === 'all') {
		const entries = await Promise.all(
			EXPORT_CATEGORY_NAMES.map(async (name) => [name, await EXPORT_CATEGORIES[name](from, to)] as const)
		);
		const bundle: Record<string, unknown> = Object.fromEntries(entries);
		const [row] = await db.select().from(settings).where(eq(settings.id, 1));
		bundle.notes = row?.notes ?? null;
		return bundle;
	}
	const fn = EXPORT_CATEGORIES[category];
	if (!fn) throw new Error(`unknown category: ${category}`);
	return fn(from, to);
}
