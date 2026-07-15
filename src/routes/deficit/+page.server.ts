import { deficitDays } from '$lib/server/deficit';
import { fillBmrGaps } from '$lib/server/projections';
import { resolveCorrection } from '$lib/server/energyBreakdown';
import { todayLabel } from '$lib/server/day';

const RANGES = { d: 1, w: 7, m: 30, '3m': 91 } as const;
export type RangeKey = keyof typeof RANGES;

export async function load({ url }) {
	const range = (url.searchParams.get('range') ?? 'w') as RangeKey;
	const lengthDays = RANGES[range] ?? RANGES.w;

	const to = todayLabel();
	const from = new Date(`${to}T12:00:00Z`);
	from.setUTCDate(from.getUTCDate() - (lengthDays - 1));

	// Resolve the correction once; apply it to the range and reuse its live target.
	const ctx = await resolveCorrection();
	const days = fillBmrGaps(
		await deficitDays(from.toISOString().slice(0, 10), to, { correction: ctx.correction })
	);
	return {
		days,
		range: RANGES[range] ? range : 'w',
		today: to,
		// Dynamic daily target (calibrated maintenance ± the mode's leanness-scaled
		// delta, live). Falls back to a flat 2100 only before there's enough data.
		calorieTarget: ctx.targetKcal ?? ctx.fixedCalorieTarget,
		includeToday: url.searchParams.get('today') === '1'
	};
}
