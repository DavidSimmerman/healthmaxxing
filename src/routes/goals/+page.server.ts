import { buildGoalsView } from '$lib/server/goals';
import { todayLabel } from '$lib/server/day';
import { weekToDate } from '$lib/period';
import { addDays } from '$lib/energy';

export async function load({ url }) {
	const today = todayLabel();

	// Validate the date param; fall back to today, and clamp any future date down.
	// Round-trip through Date so impossible-but-well-formed values (e.g. 2026-02-31,
	// which would make weekToDate throw → 500) fall back instead of erroring.
	let date = url.searchParams.get('date') ?? today;
	const d = new Date(`${date}T00:00:00Z`);
	if (
		!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
		Number.isNaN(d.getTime()) ||
		d.toISOString().slice(0, 10) !== date
	) {
		date = today;
	}
	if (date > today) date = today;

	// weekScores stays server-side (stripped from `view` here) — the client payload
	// keeps its old shape. buildGoalsView scores the strip itself, with the same
	// specs + bank/debt as the day detail, so the two can't disagree.
	const { weekScores: scored, ...view } = await buildGoalsView(date);

	// Week strip: the 7 calendar days (Sun–Sat) of the week containing `date`, each
	// with its overall score for the day rings. Later days render as empty/dimmed.
	const weekStart = weekToDate(date).from; // Sunday
	const weekDays = Array.from({ length: 7 }, (_, i) => {
		const dd = addDays(weekStart, i);
		return { date: dd, score: scored.get(dd) ?? null, future: dd > today, selected: dd === date };
	});

	// Week navigation: jump a week back/forward, preserving the weekday. Never past
	// the week that contains today.
	const todayWeekStart = weekToDate(today).from;
	const nextWeekStart = addDays(weekStart, 7);
	const nextWeekDate =
		nextWeekStart > todayWeekStart
			? null
			: (() => {
					const t = addDays(date, 7);
					return t > today ? today : t;
				})();

	return { view, date, today, weekDays, prevWeekDate: addDays(date, -7), nextWeekDate };
}
