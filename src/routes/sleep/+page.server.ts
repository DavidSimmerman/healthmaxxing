import { healthReview } from '$lib/server/healthMetrics';
import { todayLabel } from '$lib/server/day';
import { addDays } from '$lib/energy';

// Last 30 days of nightly sleep (Fitbit, via the Google Health sync). Reuses the
// same per-day metric pivot the MCP tool uses; we just keep the sleep_* keys for
// nights that actually recorded sleep, newest first.
export async function load() {
	const today = todayLabel();
	const days = await healthReview(addDays(today, -29), today);
	const nights = days
		.filter((d) => d.metrics.sleep_min != null)
		.map((d) => ({ date: d.date, m: d.metrics }))
		.reverse();
	return { nights };
}
