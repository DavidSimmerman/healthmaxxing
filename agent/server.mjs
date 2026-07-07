// Claude sandbox for healthmaxxing — a locked-down Claude Code container the app
// calls over the private network. Auth is the user's Max subscription via
// CLAUDE_CODE_OAUTH_TOKEN (no API billing). Two jobs:
//   POST /describe  {image?, mediaType?, text?}  -> validated food JSON (vision, NO tools)
//   POST /report    {period?, from?, to?, instruction?} -> Claude reads/writes via the
//                                                          app's /mcp + web, calls save_report
// Everything not in the allowlist is DENIED by canUseTool, so even though Claude Code
// ships Bash/Write/etc., none of them can run here.
import { createServer } from 'node:http';
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { parseFood } from './parseFood.mjs';

// Own port var (NOT the generic PORT) — bundled in the app container, PORT=3000 is the app's,
// so reading PORT here would collide. HOST defaults to loopback: the app calls us on 127.0.0.1
// and nothing outside the container should reach the sidecar.
const PORT = Number(process.env.AGENT_PORT || 8787);
const HOST = process.env.AGENT_HOST || '127.0.0.1';
const SECRET = process.env.AGENT_SECRET;
const MCP_URL = process.env.APP_MCP_URL; // e.g. http://healthmaxxing:3000/mcp
const MCP_TOKEN = process.env.MCP_TOKEN;
const MAX_BODY = 20 * 1024 * 1024; // 20 MB — room for a phone photo as base64

if (!SECRET) throw new Error('AGENT_SECRET is required');
if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) throw new Error('CLAUDE_CODE_OAUTH_TOKEN is required');

// ── Tool policy ─────────────────────────────────────────────────────────────
const REPORT_TOOLS = new Set([
	'mcp__health__get_nutrition',
	'mcp__health__get_body_trends',
	'mcp__health__get_health_metrics',
	'mcp__health__get_energy_ledger',
	'mcp__health__get_day_log',
	'mcp__health__list_foods',
	'mcp__health__get_report',
	'mcp__health__list_reports',
	'mcp__health__save_report',
	'WebSearch',
	'WebFetch'
]);

// Deny-by-default gate. Any tool not explicitly allowed is refused with no prompt —
// this is what actually contains the agent, not the permission mode.
const gate = (allowed) => async (toolName, input) =>
	allowed.has(toolName)
		? { behavior: 'allow', updatedInput: input }
		: { behavior: 'deny', message: `tool "${toolName}" is not permitted in this sandbox` };

// ── Claude runners ──────────────────────────────────────────────────────────
async function runToFinalText(prompt, options) {
	let out = '';
	for await (const m of query({ prompt, options })) {
		if (m.type === 'result') {
			if (m.subtype !== 'success') throw new Error(`agent run failed: ${m.subtype}`);
			out = m.result ?? '';
		}
	}
	return out;
}

const DESCRIBE_SYS = `You identify food from a photo and/or a text description and return its nutrition.
Respond with ONLY a JSON object (no prose, no markdown fences) of this shape:
{"name":string,"brand":string|null,"servingSize":string|null,"servingGrams":number|null,
 "calories":number,"proteinG":number,"carbsG":number,"fatG":number,
 "nutrients":{"fiberG"?:number,"sugarG"?:number,"sodiumMg"?:number,"satFatG"?:number} | null,
 "source":"label_ocr"|"estimate","confidence":"high"|"medium"|"low"}
All numbers are PER SINGLE SERVING. Use "label_ocr" only when reading a Nutrition Facts panel;
use "estimate" when estimating from a food photo or description. If unsure, estimate and set a lower confidence.`;

function parseImage(image, mediaType) {
	if (!image) return null;
	const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/s.exec(image);
	if (m) return { media_type: m[1], data: m[2] };
	return { media_type: mediaType || 'image/jpeg', data: image };
}

async function describe({ image, mediaType, text }) {
	const img = parseImage(image, mediaType);
	if (!img && !(typeof text === 'string' && text.trim())) {
		const e = new Error('provide an image and/or text');
		e.status = 400;
		throw e;
	}
	const content = [
		{ type: 'text', text: 'Identify this food and return the JSON described in your instructions.' }
	];
	if (text && text.trim()) content.push({ type: 'text', text: `Context: ${text.trim()}` });
	if (img) content.push({ type: 'image', source: { type: 'base64', ...img } });

	async function* gen() {
		// Full SDKUserMessage shape — streaming input is serialized as-is to the CLI,
		// which requires parent_tool_use_id (null for a top-level turn).
		yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
	}
	const result = await runToFinalText(gen(), {
		systemPrompt: DESCRIBE_SYS,
		allowedTools: [],
		canUseTool: gate(new Set()),
		maxTurns: 1,
		settingSources: []
	});
	return parseFood(result); // throws on anything that isn't valid food JSON
}

const REPORT_SYS = `You are the analyst for a personal health dashboard. Use the "health" MCP tools to
read the user's nutrition, body, and health-metric data for the requested period, analyze trends and
adherence, and then call save_report to persist a concise, useful markdown report (give it a clear title,
the period, the date range, and a short tag). Do not log or modify foods. Reply with a one-line confirmation.`;

async function report({ period, from, to, instruction }) {
	if (!MCP_URL || !MCP_TOKEN) {
		const e = new Error('reports require APP_MCP_URL and MCP_TOKEN to be configured');
		e.status = 503;
		throw e;
	}
	const range = from || to ? ` covering ${from ?? '…'} to ${to ?? '…'}` : '';
	const prompt =
		`Generate a health analysis report for the "${period || 'recent'}" period${range}. ${instruction || ''}`.trim();

	return runToFinalText(prompt, {
		systemPrompt: REPORT_SYS,
		mcpServers: {
			health: { type: 'http', url: MCP_URL, headers: { Authorization: `Bearer ${MCP_TOKEN}` } }
		},
		allowedTools: [...REPORT_TOOLS],
		canUseTool: gate(REPORT_TOOLS),
		maxTurns: 40,
		settingSources: []
	});
}

// ── Chat (SSE streaming, multi-turn, vision, propose-to-confirm) ─────────────
// Read-only health tools + a custom `propose_action` tool. NO write tools exist here,
// so the agent structurally CANNOT log/modify anything — it can only *propose*, and the
// app commits on the user's confirm. Multi-turn context via SDK session `resume`.
const CHAT_READ_TOOLS = [
	'mcp__health__get_nutrition',
	'mcp__health__get_day_log',
	'mcp__health__get_energy_ledger',
	'mcp__health__get_health_metrics',
	'mcp__health__get_body_trends',
	'mcp__health__list_foods',
	'mcp__health__lookup_barcode',
	'mcp__health__lookup_fdc',
	'mcp__health__get_report',
	'mcp__health__list_reports'
];

const CHAT_SYS = `You are the in-app AI assistant for a personal health & nutrition dashboard used by a type-1 diabetic to track food and macros. Chat naturally: be concise, warm, and practical. Use plain text (short paragraphs, the odd list) — no big markdown headers.

READING DATA: use the health tools to answer questions grounded in the user's real data — e.g. get_nutrition / get_day_log for what they've eaten and macros remaining today, list_foods to find a saved food, lookup_barcode (accepts an array of barcode strings) and lookup_fdc for packaged items. Prefer real data over guessing.

YOU CANNOT log, edit, or schedule anything yourself. When — and only when — the user gives a clear green light ("track it", "add the recipe", "schedule it for 6", "yes do it"), call the propose_action tool. That renders a confirmation card in the app; the user taps Confirm to actually commit. After calling it, say one short line asking them to confirm. Never call propose_action speculatively.

When the user sends photos of barcodes or nutrition labels, read them (look up barcodes for known data) and keep a running tally — e.g. build up a recipe across several photos, then propose it.

ALWAYS set propose_action top-level "name" and calories/proteinG/carbsG/fatG to the EXACT totals to log and show on the card — for track & schedule these numbers are logged verbatim (as one entry), so make them the full portion, not per-serving. Whenever you can read them from a label, also include a top-level "nutrients" object (e.g. {"fiberG": 6, "sugarAlcoholG": 3}) — fiber and sugar alcohols are needed for accurate insulin (net-carb) dosing. Then by kind:
- "track"    → no extra payload needed (top-level macros are logged as-is). payload: {}
- "recipe"   → payload: { ingredients: [{ name, amount?, calories, proteinG, carbsG, fatG, nutrients? }], makesServings, totalGrams? }  (ingredient macros are WHOLE-recipe contributions, not per serving; per-serving is derived on save. For recipes, attach fiber/sugar-alcohol to EACH ingredient's own "nutrients" bag — recipe nutrients are summed from ingredients, NOT the top-level bag. All ingredient macros must be numbers.)
- "schedule" → payload: { scheduleAt }  (ISO-8601 instant later TODAY, with timezone offset)`;

function sse(res, event, data) {
	res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function chat(req, res, { message, images, sessionId }) {
	if (!MCP_URL || !MCP_TOKEN)
		return send(res, 503, { error: 'chat requires APP_MCP_URL and MCP_TOKEN' });
	const hasText = typeof message === 'string' && message.trim().length > 0;
	const imgs = Array.isArray(images) ? images : [];
	if (!hasText && imgs.length === 0)
		return send(res, 400, { error: 'provide a message and/or images' });

	res.writeHead(200, {
		'content-type': 'text/event-stream',
		'cache-control': 'no-cache, no-transform',
		connection: 'keep-alive'
	});

	// Per-request proposer tool: the model calls it to surface a confirmation card; the
	// handler just forwards the args to THIS stream and acks. No side effects.
	const proposer = createSdkMcpServer({
		name: 'proposer',
		tools: [
			tool(
				'propose_action',
				'Show the user a confirmation card to track a food, add a recipe, or schedule a meal. Only call after the user gives a clear go-ahead.',
				{
					kind: z.enum(['track', 'recipe', 'schedule']),
					name: z.string(),
					summary: z.string(),
					calories: z.number(),
					proteinG: z.number(),
					carbsG: z.number(),
					fatG: z.number(),
					nutrients: z.record(z.string(), z.number()).optional(),
					payload: z.any()
				},
				async (args) => {
					sse(res, 'action', args);
					return {
						content: [
							{ type: 'text', text: 'Confirmation card shown. Ask the user to tap Confirm.' }
						]
					};
				}
			)
		]
	});

	const allowed = new Set([...CHAT_READ_TOOLS, 'mcp__proposer__propose_action']);

	const content = [];
	if (hasText) content.push({ type: 'text', text: message });
	for (const im of imgs) {
		const img = parseImage(im?.data ?? im, im?.mediaType);
		if (img) content.push({ type: 'image', source: { type: 'base64', ...img } });
	}
	async function* gen() {
		yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
	}

	// Stop the Claude run if the client hangs up (Stop/close) — otherwise it keeps
	// doing MCP reads and burning rate limit with nobody listening.
	const abortController = new AbortController();
	res.on('close', () => abortController.abort());

	const options = {
		systemPrompt: CHAT_SYS,
		includePartialMessages: true,
		abortController,
		tools: [], // no built-ins (Bash/Write/etc.)
		mcpServers: {
			health: { type: 'http', url: MCP_URL, headers: { Authorization: `Bearer ${MCP_TOKEN}` } },
			proposer
		},
		allowedTools: [...allowed],
		canUseTool: gate(allowed),
		maxTurns: 20,
		settingSources: []
	};
	if (typeof sessionId === 'string' && sessionId) options.resume = sessionId;

	try {
		for await (const m of query({ prompt: gen(), options })) {
			if (m.type === 'system' && m.subtype === 'init' && m.session_id) {
				sse(res, 'session', { sessionId: m.session_id });
			} else if (m.type === 'stream_event') {
				const ev = m.event;
				if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
					sse(res, 'delta', { text: ev.delta.text });
				}
			} else if (m.type === 'result') {
				if (m.subtype !== 'success') sse(res, 'error', { message: `chat failed: ${m.subtype}` });
				break;
			}
		}
		sse(res, 'done', {});
	} catch (e) {
		// Client hung up (abort) → res is already closed; nothing to report.
		if (!res.writableEnded && !abortController.signal.aborted) {
			console.error(e);
			sse(res, 'error', { message: e?.message ?? 'chat error' });
		}
	} finally {
		if (!res.writableEnded) res.end();
	}
}

// ── HTTP ────────────────────────────────────────────────────────────────────
function readJson(req) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on('data', (c) => {
			size += c.length;
			if (size > MAX_BODY) {
				const e = new Error('body too large');
				e.status = 413;
				reject(e);
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on('end', () => {
			try {
				resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
			} catch {
				const e = new Error('invalid JSON body');
				e.status = 400;
				reject(e);
			}
		});
		req.on('error', reject);
	});
}

const send = (res, status, obj) => {
	const body = JSON.stringify(obj);
	res.writeHead(status, { 'content-type': 'application/json' });
	res.end(body);
};

const server = createServer(async (req, res) => {
	try {
		if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
		if (req.method !== 'POST') return send(res, 404, { error: 'not found' });

		// Bearer auth on every job. Internal network + a shared secret (defense in depth).
		if (req.headers.authorization !== `Bearer ${SECRET}`)
			return send(res, 401, { error: 'unauthorized' });

		const body = await readJson(req);
		if (req.url === '/describe') return send(res, 200, { food: await describe(body) });
		if (req.url === '/report') return send(res, 200, { result: await report(body) });
		if (req.url === '/chat') return await chat(req, res, body); // manages its own SSE response
		return send(res, 404, { error: 'not found' });
	} catch (e) {
		const status = e?.status ?? 500;
		if (status >= 500) console.error(e);
		send(res, status, { error: e?.message ?? 'internal error' });
	}
});

server.listen(PORT, HOST, () => console.log(`agent listening on ${HOST}:${PORT}`));
