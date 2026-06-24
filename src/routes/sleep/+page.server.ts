import { healthReview } from '$lib/server/healthMetrics';
import { db } from '$lib/server/db';
import { sleepStages } from '$lib/server/db/schema';
import { APP_TZ, todayLabel } from '$lib/server/day';
import { addDays } from '$lib/energy';
import { gte } from 'drizzle-orm';

// Last 30 nights: aggregate metrics (for the period averages + insights) plus the
// per-night stage timeline (for the hypnogram). The period selector and insight
// math run client-side off this one payload, so switching week/2-week/month is
// instant.
export async function load() {
	const today = todayLabel();
	const from = addDays(today, -29);
	const [days, stages] = await Promise.all([
		healthReview(from, today),
		db.select().from(sleepStages).where(gte(sleepStages.date, from))
	]);

	const nights = days
		.filter((d) => d.metrics.sleep_min != null)
		.map((d) => ({ date: d.date, m: d.metrics }))
		.reverse(); // newest first

	const stagesByDate: Record<
		string,
		{ startAt: string; endAt: string; segments: { stage: string; startMin: number; durationMin: number }[] }
	> = {};
	for (const s of stages) {
		stagesByDate[s.date] = {
			startAt: s.startAt.toISOString(),
			endAt: s.endAt.toISOString(),
			segments: s.segments
		};
	}

	return { nights, stagesByDate, tz: APP_TZ };
}
