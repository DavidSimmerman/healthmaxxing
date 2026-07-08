import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { chats, type ChatMessage } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

// POST /api/chats  { id?, title?, messages: ChatMessage[] }  -> { id }
// Upsert a saved conversation. New chat (no id) inserts and returns the id the client then
// reuses for subsequent saves in the same session. Session-gated by hooks.
function deriveTitle(messages: ChatMessage[]): string {
	const first = messages.find((m) => m.role === 'user') as { text?: string } | undefined;
	const t = (first?.text ?? '').trim().replace(/\s+/g, ' ');
	return t ? (t.length > 48 ? t.slice(0, 48) + '…' : t) : 'New chat';
}

export async function POST({ request }) {
	const body = await request.json().catch(() => null);
	const messages = Array.isArray(body?.messages) ? (body.messages as ChatMessage[]) : null;
	if (!messages) throw error(400, 'messages array required');
	// Backstop against accidental image-data bloat — the client persists text + imageCount only.
	if (JSON.stringify(messages).length > 512 * 1024) throw error(413, 'conversation too large to save');

	const title = (typeof body.title === 'string' && body.title.trim()) || deriveTitle(messages);

	if (typeof body.id === 'string' && body.id) {
		const [row] = await db
			.update(chats)
			.set({ messages, title, updatedAt: new Date() })
			.where(eq(chats.id, body.id))
			.returning({ id: chats.id });
		if (!row) throw error(404, 'chat not found');
		return json({ id: row.id });
	}

	const [row] = await db.insert(chats).values({ title, messages }).returning({ id: chats.id });
	return json({ id: row.id });
}
