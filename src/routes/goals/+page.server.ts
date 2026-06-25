import { buildGoalsView } from '$lib/server/goals';
import { todayLabel } from '$lib/server/day';
import { addDays } from '$lib/energy';

const PERIODS = ['day', 'week', 'month'] as const;
type Period = (typeof PERIODS)[number];

// How far prev/next steps in days, by period (matches the trailing-window span
// in periodRange: day=1, week=7, month=30).
const STEP: Record<Period, number> = { day: 1, week: 7, month: 30 };

export async function load({ url }) {
	const today = todayLabel();

	const rawPeriod = url.searchParams.get('period');
	const period: Period = PERIODS.includes(rawPeriod as Period) ? (rawPeriod as Period) : 'day';

	// Validate the date param; fall back to today, and clamp any future date down.
	let date = url.searchParams.get('date') ?? today;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) date = today;
	if (date > today) date = today;

	const view = await buildGoalsView(period, date);

	const step = STEP[period];
	const prevDate = addDays(date, -step);
	// Never let "next" walk past today.
	const nextRaw = addDays(date, step);
	const nextDate = nextRaw > today ? today : nextRaw;

	return { view, date, period, today, prevDate, nextDate };
}
