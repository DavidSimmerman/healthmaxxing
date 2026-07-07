import { error } from '@sveltejs/kit';
import { chatStream } from '$lib/server/agent';

// POST /api/chat  { message?, images?: [{data,mediaType}], sessionId? }
// Streams the sidecar's SSE (Claude chat) straight through to the browser. Session-gated
// by hooks.server.ts. The client holds conversation state and the sessionId for continuity.
export async function POST({ request }) {
	const body = await request.json().catch(() => null);
	if (!body || (typeof body.message !== 'string' && !Array.isArray(body.images))) {
		throw error(400, 'message or images required');
	}

	let upstream: Response;
	try {
		upstream = await chatStream(
			{ message: body.message, images: body.images, sessionId: body.sessionId },
			request.signal // forward client abort to the sidecar
		);
	} catch (e) {
		throw error(502, `chat unavailable: ${(e as Error).message}`);
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
