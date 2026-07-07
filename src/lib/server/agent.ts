// Thin client for the Claude sandbox sidecar (agent/). The sidecar runs Claude
// Code on the user's Max subscription; we only ever talk to it over the private
// network with a shared secret. Not configured (no AGENT_URL) => callers get a
// clear error and the feature is simply off.
import { env } from '$env/dynamic/private';

async function call(path: string, body: unknown, timeoutMs: number): Promise<any> {
	const url = env.AGENT_URL;
	const secret = env.AGENT_SECRET;
	if (!url || !secret)
		throw new Error('agent sandbox not configured (set AGENT_URL and AGENT_SECRET)');

	// Tolerate a trailing slash on AGENT_URL — otherwise `${url}/describe` becomes
	// `…//describe`, which the sidecar's exact-path routes 404.
	const r = await fetch(`${url.replace(/\/+$/, '')}${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs)
	});
	const text = await r.text();
	if (!r.ok) throw new Error(`agent ${path} ${r.status}: ${text.slice(0, 300)}`);
	return text ? JSON.parse(text) : {};
}

export type DescribedFood = {
	name: string;
	brand: string | null;
	servingSize: string | null;
	servingGrams: number | null;
	calories: number;
	proteinG: number;
	carbsG: number;
	fatG: number;
	nutrients?: Record<string, number>;
	source: string;
	resolverNote: string | null;
};

/** Photo and/or text -> validated per-serving food. Vision only, no tools. */
export const describeFood = (input: { image?: string; mediaType?: string; text?: string }) =>
	call('/describe', input, 90_000).then((r) => r.food as DescribedFood);

/** Kick Claude to read the user's data via /mcp and save a report. Returns its confirmation line. */
export const generateReport = (input: {
	period?: string;
	from?: string;
	to?: string;
	instruction?: string;
}) => call('/report', input, 240_000).then((r) => r.result as string);

export type ChatImage = { data: string; mediaType?: string };

/**
 * Open a streaming chat turn against the sidecar and return the raw upstream Response so the
 * caller can pipe its SSE body straight through. `signal` forwards client-abort to the sidecar.
 * No JSON timeout here — chat streams are long-lived; the client aborts to stop.
 */
export async function chatStream(
	body: { message?: string; images?: ChatImage[]; sessionId?: string },
	signal?: AbortSignal
): Promise<Response> {
	const url = env.AGENT_URL;
	const secret = env.AGENT_SECRET;
	if (!url || !secret)
		throw new Error('agent sandbox not configured (set AGENT_URL and AGENT_SECRET)');
	return fetch(`${url.replace(/\/+$/, '')}/chat`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
		body: JSON.stringify(body),
		signal
	});
}
