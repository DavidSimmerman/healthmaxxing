import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { chats, type ChatMessage } from '$lib/server/db/schema';
import { chatStream, type ChatHistoryLine } from '$lib/server/agent';
import { UUID_RE } from '$lib/uuid';

// Persisted messages → replayable text lines for the sidecar. Action cards become a
// compact assistant line so the model knows what was actually logged/cancelled.
function toHistory(messages: ChatMessage[]): ChatHistoryLine[] {
	const lines: ChatHistoryLine[] = [];
	for (const m of messages) {
		if (m.role === 'user') {
			const photos = m.imageCount ? ` [${m.imageCount} photo(s) attached]` : '';
			if (m.text || photos) lines.push({ role: 'user', text: `${m.text ?? ''}${photos}`.trim() });
		} else if (m.role === 'assistant') {
			if (m.text) lines.push({ role: 'assistant', text: m.text });
		} else if (m.role === 'action') {
			const verb =
				m.status === 'done' ? 'Logged' : m.status === 'cancelled' ? 'Cancelled' : 'Proposed';
			const mac = m.macros;
			lines.push({
				role: 'assistant',
				text: `[${verb}: ${m.name} — ${Math.round(mac.calories)} kcal, ${Math.round(mac.proteinG)}p/${Math.round(mac.carbsG)}c/${Math.round(mac.fatG)}f${m.scheduled ? ' (scheduled)' : ''}]`
			});
		}
	}
	// Cap what we ship to the sidecar: newest 60 turns, ~12k chars.
	const out = lines.slice(-60);
	let total = out.reduce((a, l) => a + l.text.length, 0);
	while (out.length > 1 && total > 12_000) total -= out.shift()!.text.length;
	return out;
}

// POST /api/chat  { message?, images?: [{data,mediaType}], sessionId?, chatId? }
// Streams the sidecar's SSE (Claude chat) straight through to the browser. Session-gated
// by hooks.server.ts. Continuity: the sidecar resumes its SDK session while it survives;
// when it can't (reopened chat, redeployed container), we replay the persisted history
// from the chats row — the model then actually remembers what the bubbles show.
export async function POST({ request }) {
	const body = await request.json().catch(() => null);
	if (!body || (typeof body.message !== 'string' && !Array.isArray(body.images))) {
		throw error(400, 'message or images required');
	}

	let history: ChatHistoryLine[] | undefined;
	if (typeof body.chatId === 'string' && UUID_RE.test(body.chatId)) {
		const [row] = await db
			.select({ messages: chats.messages })
			.from(chats)
			.where(eq(chats.id, body.chatId));
		if (row?.messages?.length) history = toHistory(row.messages);
	}

	// Connect-timeout: abort if the sidecar doesn't return headers within 20s, so a
	// misconfigured/unreachable AGENT_URL fails fast with a clean error instead of hanging
	// (which the proxy surfaces as a scary 502). Cleared once headers arrive — the SSE body
	// itself then streams unbounded, and client disconnect still aborts via request.signal.
	const connect = new AbortController();
	const timer = setTimeout(() => connect.abort(), 20_000);
	let upstream: Response;
	try {
		upstream = await chatStream(
			{ message: body.message, images: body.images, sessionId: body.sessionId, history },
			AbortSignal.any([request.signal, connect.signal])
		);
	} catch (e) {
		throw error(502, `chat unavailable: ${(e as Error).message}`);
	} finally {
		clearTimeout(timer);
	}

	if (!upstream.ok || !upstream.body) {
		const txt = await upstream.text().catch(() => '');
		throw error(502, `chat upstream ${upstream.status}: ${txt.slice(0, 200)}`);
	}

	return new Response(upstream.body, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache, no-transform',
			connection: 'keep-alive'
		}
	});
}
