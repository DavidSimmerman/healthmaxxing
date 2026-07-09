import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { quickAdds } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { UUID_RE } from '$lib/uuid';

export async function DELETE({ params }) {
	// Malformed uuid → clean 404, not a Postgres uuid-cast 500.
	if (!UUID_RE.test(params.id)) throw error(404, 'quick-add not found');
	const [row] = await db.select().from(quickAdds).where(eq(quickAdds.id, params.id));
	if (!row) throw error(404, 'quick-add not found');
	await db.delete(quickAdds).where(eq(quickAdds.id, params.id));
	return json({ ok: true });
}

export async function PATCH({ params, request }) {
	if (!UUID_RE.test(params.id)) throw error(404, 'quick-add not found');
	const body = await request.json();
	const { sortOrder } = body;
	if (typeof sortOrder !== 'number' || !Number.isInteger(sortOrder)) {
		throw error(400, 'sortOrder must be an integer');
	}
	await db.update(quickAdds).set({ sortOrder }).where(eq(quickAdds.id, params.id));
	return json({ ok: true });
}
