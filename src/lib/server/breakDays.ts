import { and, gte, lte } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { breakDays } from '$lib/server/db/schema';
import { weekToDate } from '$lib/period';
import { addDays } from '$lib/energy';

// A date → boolean "is this a break day" predicate, same shape as loadIsVacation:
// loaded once per request, then a cheap in-memory Set lookup. One row per break day
// (≈52/year) so reading them all is cheaper than a per-date query.
export async function loadIsBreakDay(): Promise<(date: string) => boolean> {
	const rows = await db.select({ date: breakDays.date }).from(breakDays);
	if (!rows.length) return () => false;
	const set = new Set(rows.map((r) => r.date));
	return (date: string) => set.has(date);
}

// Mark / unmark `date` as this week's break day. One per calendar week (Sun–Sat), so
// marking a second day MOVES the break instead of failing — that's the useful outcome
// when plans change. Tapping the day that's already the break clears it. Returns the
// new state. Throws on a malformed date (weekToDate validates).
// ponytail: delete-then-insert, not a transaction — single-user app. A double-tap is
// the realistic race and onConflictDoNothing keeps it from erroring; the remaining
// ceiling is two tabs marking DIFFERENT days at once, which can leave two in a week
// (one tap fixes it). Wrap in a transaction with a lock only if that ever happens.
export async function toggleBreakDay(date: string): Promise<boolean> {
	const from = weekToDate(date).from; // Sunday of that week
	const to = addDays(from, 6);
	const existing = await db
		.select({ date: breakDays.date })
		.from(breakDays)
		.where(and(gte(breakDays.date, from), lte(breakDays.date, to)));
	const on = !existing.some((r) => r.date === date);
	await db.delete(breakDays).where(and(gte(breakDays.date, from), lte(breakDays.date, to)));
	if (on) await db.insert(breakDays).values({ date }).onConflictDoNothing();
	return on;
}
