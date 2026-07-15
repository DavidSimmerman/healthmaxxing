import { db } from '$lib/server/db';
import { vacations } from '$lib/server/db/schema';
import { desc } from 'drizzle-orm';
import { SPEC, VACATION_SPECS, type SpecMap } from '$lib/score';

export type Vacation = { id: string; from: string; to: string };

// All trip windows, newest first (for the settings list).
export async function listVacations(): Promise<Vacation[]> {
	return db
		.select({ id: vacations.id, from: vacations.from, to: vacations.to })
		.from(vacations)
		.orderBy(desc(vacations.from));
}

// A date → boolean "is this day inside a trip window" predicate. Same cheap
// in-memory range check as loadSpecsFor, for calibration filters that must drop
// vacation days (trip food is guesswork; trip weigh-ins are water-noisy).
export async function loadIsVacation(): Promise<(date: string) => boolean> {
	const rows = await db.select({ from: vacations.from, to: vacations.to }).from(vacations);
	if (!rows.length) return () => false;
	return (date: string) => rows.some((r) => date >= r.from && date <= r.to);
}

// A date → SpecMap resolver built from the trip windows (ranges inclusive). Loaded
// once per request; the returned closure is a cheap in-memory range check. With no
// trips it returns the normal specs for every day, so scoring is unchanged.
export async function loadSpecsFor(): Promise<(date: string) => SpecMap> {
	const rows = await db.select({ from: vacations.from, to: vacations.to }).from(vacations);
	if (!rows.length) return () => SPEC;
	return (date: string) =>
		rows.some((r) => date >= r.from && date <= r.to) ? VACATION_SPECS : SPEC;
}
