import { addDays } from '$lib/energy';

// period -> trailing window ending on `anchor` (YYYY-MM-DD, inclusive). Trailing
// N days, not calendar week/month — simplest and matches the other read tools.
// ponytail: trailing windows; switch to calendar boundaries if a review ever
// needs "all of June" rather than "the last 30 days". Pure (anchor required) so
// it stays unit-testable; callers default the anchor to today.
export function periodRange(period: string, anchor: string): { from: string; to: string } {
	// Round-trip through Date (UTC) so impossible calendar dates are rejected, not
	// silently normalized: '2026-02-31' would otherwise roll into March, and
	// '2026-13-01' would throw a RangeError downstream in addDays.
	const d = new Date(`${anchor}T00:00:00Z`);
	if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== anchor) {
		throw new Error('invalid date');
	}
	const span = period === 'day' ? 1 : period === 'month' ? 30 : 7; // default week
	return { from: addDays(anchor, -(span - 1)), to: anchor };
}
