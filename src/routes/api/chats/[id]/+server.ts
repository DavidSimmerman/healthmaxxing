import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { chats } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

// GET /api/chats/[id] — load a saved conversation's messages (to resume it). Session-gated.
export async function GET({ params }) {
	const [row] = await db
		.select({ id: chats.id, title: chats.title, messages: chats.messages })
		.from(chats)
		.where(eq(chats.id, params.id));
	if (!row) throw error(404, 'chat not found');
	return json(row);
}

// PATCH /api/chats/[id]  { unread: false } — mark read; the only supported transition.
// Deliberately does not bump updatedAt (reading must not reorder the list).
export async function PATCH({ params, request }) {
	const body = await request.json().catch(() => null);
	if (body?.unread !== false) throw error(400, 'only { unread: false } is supported');
	const [row] = await db
		.update(chats)
		.set({ unread: false })
		.where(eq(chats.id, params.id))
		.returning({ id: chats.id });
	if (!row) throw error(404, 'chat not found');
	return json({ ok: true });
}

// DELETE /api/chats/[id] — remove a saved conversation. Session-gated by hooks.
export async function DELETE({ params }) {
	const [row] = await db.delete(chats).where(eq(chats.id, params.id)).returning({ id: chats.id });
	if (!row) throw error(404, 'chat not found');
	return json({ ok: true });
}
