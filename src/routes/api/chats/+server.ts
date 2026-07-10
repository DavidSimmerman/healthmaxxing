import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { chats, type ChatMessage } from '$lib/server/db/schema';
import { desc, eq, or, sql } from 'drizzle-orm';

// GET /api/chats -> { chats: [{ id, title, kind, dateLabel, unread, updatedAt }] }
// Newest first. Report rows with empty messages are in-progress generation claims
// (idempotency inserts) — hidden until the content lands. Session-gated by hooks.
export async function GET() {
	const rows = await db
		.select({
			id: chats.id,
			title: chats.title,
			kind: chats.kind,
			dateLabel: chats.dateLabel,
			unread: chats.unread,
			updatedAt: chats.updatedAt
		})
		.from(chats)
		.where(or(eq(chats.kind, 'chat'), sql`jsonb_array_length(${chats.messages}) > 0`))
		.orderBy(desc(chats.updatedAt))
		.limit(100);
	return json({ chats: rows });
}

// POST /api/chats  { id?, title?, messages: ChatMessage[] }  -> { id }
// Upsert a saved conversation. New chat (no id) inserts and returns the id the client then
// reuses for subsequent saves in the same session. Session-gated by hooks.
// kind/unread/dateLabel are NEVER writable here — replying to a report must not un-report it.
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
	if (JSON.stringify(messages).length > 512 * 1024)
		throw error(413, 'conversation too large to save');

	const explicit = (typeof body.title === 'string' && body.title.trim()) || null;
	const title = explicit ?? deriveTitle(messages);

	if (typeof body.id === 'string' && body.id) {
		const [row] = await db
			.update(chats)
			.set({
				messages,
				updatedAt: new Date(),
				// Derived titles only apply to plain chats — a reply must not rename a report.
				title:
					explicit ?? sql`case when ${chats.kind} = 'chat' then ${title} else ${chats.title} end`
			})
			.where(eq(chats.id, body.id))
			.returning({ id: chats.id });
		if (!row) throw error(404, 'chat not found');
		return json({ id: row.id });
	}

	const [row] = await db.insert(chats).values({ title, messages }).returning({ id: chats.id });
	return json({ id: row.id });
}
