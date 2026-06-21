import { deficitDays } from '$lib/server/deficit';
import { fillBmrGaps } from '$lib/server/projections';
import { todayLabel } from '$lib/server/day';

const RANGES = { d: 1, w: 7, m: 30, '3m': 91 } as const;
export type RangeKey = keyof typeof RANGES;

export async function load({ url }) {
	const range = (url.searchParams.get('range') ?? 'w') as RangeKey;
	const lengthDays = RANGES[range] ?? RANGES.w;

	const to = todayLabel();
	const from = new Date(`${to}T12:00:00Z`);
	from.setUTCDate(from.getUTCDate() - (lengthDays - 1));

	const days = fillBmrGaps(await deficitDays(from.toISOString().slice(0, 10), to));
	return { days, range: RANGES[range] ? range : 'w', today: to };
}
