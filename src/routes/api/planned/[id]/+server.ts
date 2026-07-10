import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { dailyLog } from '$lib/server/db/schema';
import { and, eq } from 'drizzle-orm';
import { UUID_RE } from '$lib/uuid';

// Cancel a scheduled meal — delete the pending row. Guarded to pending rows so this
// can never remove an already-eaten entry (those go through /api/log/[id]).
export async function DELETE({ params }) {
	// Malformed uuid → clean 404, not a Postgres uuid-cast 500.
	if (!UUID_RE.test(params.id)) throw error(404, 'planned meal not found');
	const [gone] = await db
		.delete(dailyLog)
		.where(and(eq(dailyLog.id, params.id), eq(dailyLog.pending, true)))
		.returning();
	if (!gone) throw error(404, 'planned meal not found');
	return json({ ok: true });
}

// Confirm a scheduled meal: clear pending and stamp the time it was actually eaten
// (now), so the day's metrics already counting it stay put and the entry reads as a
// normal logged meal.
export async function POST({ params }) {
	if (!UUID_RE.test(params.id)) throw error(404, 'planned meal not found');
	const [entry] = await db
		.update(dailyLog)
		.set({ pending: false, loggedAt: new Date() })
		.where(and(eq(dailyLog.id, params.id), eq(dailyLog.pending, true)))
		.returning();
	if (!entry) throw error(404, 'planned meal not found');
	return json({ entry });
}
