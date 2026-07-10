// Claude sandbox for healthmaxxing — a locked-down Claude Code sidecar bundled in
// the app container (loopback 127.0.0.1). Auth is the user's Max subscription via
// CLAUDE_CODE_OAUTH_TOKEN (no API billing). Jobs:
//   POST /describe  {image?, mediaType?, text?}  -> validated food JSON (vision, NO tools)
//   POST /report    {period?, from?, to?, instruction?} -> Claude reads/writes via the
//                                                          app's /mcp + web, calls save_report
//   POST /insight   {prompt} -> one-shot analysis text (read-only tools + web); used by
//                               the app's scheduled daily/weekly/monthly report chats
//   POST /chat      SSE streaming chat (read-only tools + web + propose_action)
// Everything not in the allowlist is DENIED by canUseTool, so even though Claude Code
// ships Bash/Write/etc., none of them can run here.
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { parseFood } from './parseFood.mjs';

// Own port var (NOT the generic PORT) — bundled in the app container, PORT=3000 is the app's,
// so reading PORT here would collide. HOST defaults to loopback: the app calls us on 127.0.0.1
// and nothing outside the container should reach the sidecar.
const PORT = Number(process.env.AGENT_PORT || 8787);
const HOST = process.env.AGENT_HOST || '127.0.0.1';
const SECRET = process.env.AGENT_SECRET;
const MCP_URL = process.env.APP_MCP_URL; // e.g. http://127.0.0.1:3000/mcp
const MCP_TOKEN = process.env.MCP_TOKEN; // RW service token — /report may save_report
// Read-only service token for /chat (the /mcp side refuses write tools on it —
// defense in depth against prompt injection). Falls back to the RW token so
// nothing breaks before MCP_TOKEN_RO/MCP_SERVICE_TOKEN_RO are set in Coolify.
const MCP_TOKEN_RO = process.env.MCP_TOKEN_RO || MCP_TOKEN;
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
 "nutrients":{"fiberG"?:number,"sugarG"?:number,"sugarAlcoholG"?:number,"alluloseG"?:number,"sodiumMg"?:number,"satFatG"?:number} | null,
 "source":"label_ocr"|"estimate","confidence":"high"|"medium"|"low"}
All numbers are PER SINGLE SERVING. Use "label_ocr" only when reading a Nutrition Facts panel;
use "estimate" when estimating from a food photo or description. If unsure, estimate and set a lower confidence.`;

function parseImage(image, mediaType) {
	if (!image) return null;
	const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/s.exec(image);
	if (m) return { media_type: m[1], data: m[2] };
	return { media_type: mediaType || 'image/jpeg', data: image };
}

async function describe({ image, mediaType, text }, abortController) {
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
		abortController,
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

async function report({ period, from, to, instruction }, abortController) {
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
		abortController,
		mcpServers: {
			health: { type: 'http', url: MCP_URL, headers: { Authorization: `Bearer ${MCP_TOKEN}` } }
		},
		allowedTools: [...REPORT_TOOLS],
		canUseTool: gate(REPORT_TOOLS),
		maxTurns: 40,
		settingSources: []
	});
}

// ── Insight (one-shot analysis for the scheduled report CHATS) ────────────────
// Read-only tools + web, RO bearer, returns the final text — the app saves it as a
// chat row the user can reply to. Unlike /report it never writes anything.
const INSIGHT_SYS = `You are the analyst behind scheduled report chats in a personal health dashboard; the user is a type-1 diabetic tracking food, glucose, insulin, activity, sleep, and weight. Use the read-only "health" MCP tools to pull REAL data before writing — never invent numbers; if a source is empty, say so briefly. Write directly to the user ("you"), as plain conversational text for a chat bubble: short paragraphs, an emoji or two as section markers, NO markdown syntax (no #, no **, no tables). Lead with the single most important takeaway, be specific (real numbers, real dates), and end practical.`;

async function insight({ prompt }, abortController) {
	if (!MCP_URL || !MCP_TOKEN_RO) {
		const e = new Error('insight requires APP_MCP_URL and MCP_TOKEN(_RO)');
		e.status = 503;
		throw e;
	}
	if (typeof prompt !== 'string' || !prompt.trim()) {
		const e = new Error('prompt required');
		e.status = 400;
		throw e;
	}
	const allowed = new Set([...CHAT_READ_TOOLS, 'WebSearch', 'WebFetch']);
	return runToFinalText(prompt, {
		systemPrompt: INSIGHT_SYS,
		abortController,
		tools: ['WebSearch', 'WebFetch'],
		mcpServers: {
			health: { type: 'http', url: MCP_URL, headers: { Authorization: `Bearer ${MCP_TOKEN_RO}` } }
		},
		allowedTools: [...allowed],
		canUseTool: gate(allowed),
		maxTurns: 40,
		settingSources: []
	});
}

// ── Chat (SSE streaming, multi-turn, vision, propose-to-confirm) ─────────────
// Read-only health tools + web + a custom `propose_action` tool. NO write tools exist
// here, so the agent structurally CANNOT log/modify anything — it can only *propose*,
// and the app commits on the user's confirm. Multi-turn context: SDK `resume` while the
// session file survives, else server-side history replay (see below).
const CHAT_READ_TOOLS = [
	'mcp__health__get_nutrition',
	'mcp__health__get_day_log',
	'mcp__health__get_energy_ledger',
	'mcp__health__get_health_metrics',
	'mcp__health__get_body_trends',
	'mcp__health__get_goal_report',
	'mcp__health__list_foods',
	'mcp__health__lookup_barcode',
	'mcp__health__lookup_fdc',
	'mcp__health__get_report',
	'mcp__health__list_reports',
	'mcp__health__list_chats',
	'mcp__health__get_chat'
];

// SDK sessions live at <config>/projects/<cwd with non-alnum → '-'>/<id>.jsonl. When
// that file is gone (sidecar container replaced — no volume), `resume` SILENTLY starts
// a fresh session: the exact "chat forgot everything" bug. Check the disk and fall back
// to history replay instead. Layout change in a future SDK just degrades to replay.
function sessionOnDisk(id) {
	if (!/^[a-zA-Z0-9-]+$/.test(id)) return false;
	const base = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
	const proj = process.cwd().replace(/[^a-zA-Z0-9]/g, '-');
	return existsSync(join(base, 'projects', proj, `${id}.jsonl`));
}

// Persisted turns (from the app's chats table) → one context block. Belt-and-braces
// caps: the app already trims, but never trust the wire.
function historyBlock(history) {
	if (!Array.isArray(history)) return null;
	const lines = [];
	for (const h of history.slice(-80)) {
		if (!h || typeof h.text !== 'string' || !h.text.trim()) continue;
		lines.push(`${h.role === 'user' ? 'User' : 'Assistant'}: ${h.text.trim()}`);
	}
	if (!lines.length) return null;
	let block = lines.join('\n');
	if (block.length > 24_000) block = `…\n${block.slice(-24_000)}`;
	return `Earlier conversation (context — continue it naturally, no re-greeting):\n${block}\n--- end of earlier conversation ---`;
}

const CHAT_SYS = `You are the in-app AI assistant for a personal health & nutrition dashboard used by a type-1 diabetic to track food and macros. Chat naturally: be concise, warm, and practical. Use plain text (short paragraphs, the odd list) — no big markdown headers.

READING DATA: use the health tools to answer questions grounded in the user's real data — e.g. get_nutrition / get_day_log for what they've eaten and macros remaining today, list_foods to find a saved food, lookup_barcode (accepts an array of barcode strings) and lookup_fdc for packaged items. Prefer real data over guessing.

YOU CANNOT log, edit, or schedule anything yourself. When — and only when — the user gives a clear green light ("track it", "add the recipe", "schedule it for 6", "yes do it"), call the propose_action tool. That renders a confirmation card in the app; the user taps Confirm to actually commit. After calling it, say one short line asking them to confirm. Never call propose_action speculatively.

When the user sends photos of barcodes or nutrition labels, read them (look up barcodes for known data) and keep a running tally — e.g. build up a recipe across several photos, then propose it.

MACRO ACCURACY — your numbers get logged and drive insulin dosing, so verify, don't vibe:
- Restaurant/chain/branded items: FIRST look up the CURRENT official nutrition (WebSearch, then WebFetch the chain's nutrition page/PDF) and compute the exact order — size, sides, sauces, dressings, modifications. Name the source in your reply ("per Chipotle's nutrition calculator").
- Packaged/whole foods: lookup_barcode / lookup_fdc before estimating.
- Estimate ONLY when no exact data exists, and say plainly what you assumed (portion weight, oil, prep).
DOUBLE-CHECK before every propose_action: step back and re-derive the totals from your sources — arithmetic (per-unit × quantity), serving basis (per item vs per 100g vs whole order), and the energy identity (calories ≈ 4×protein + 4×carbs + 9×fat, allowing for fiber/sugar alcohols/allulose). Resolve any mismatch before proposing; keep one short line of remaining assumptions.

PAST CONVERSATIONS: list_chats / get_chat read earlier conversations and past daily/weekly/monthly report chats — use them when the user refers to something discussed before ("like last time", "what did my weekly report say").

ALWAYS set propose_action top-level "name" and calories/proteinG/carbsG/fatG to the EXACT totals to log and show on the card — for track & schedule these numbers are logged verbatim (as one entry), so make them the full portion, not per-serving. Whenever you can read them from a label, also include a top-level "nutrients" object (e.g. {"fiberG": 6, "sugarAlcoholG": 3, "alluloseG": 8}) — fiber, sugar alcohols, and allulose are needed for accurate insulin (net-carb) dosing. Then by kind:
- "track"    → no extra payload needed (top-level macros are logged as-is). payload: {}
- "recipe"   → payload: { ingredients: [{ name, amount?, calories, proteinG, carbsG, fatG, nutrients? }], makesServings, totalGrams? }  (ingredient macros are WHOLE-recipe contributions, not per serving; per-serving is derived on save. For recipes, attach fiber/sugar-alcohol to EACH ingredient's own "nutrients" bag — recipe nutrients are summed from ingredients, NOT the top-level bag. All ingredient macros must be numbers.)
- "schedule" → payload: { scheduleAt }  (ISO-8601 instant later TODAY, with timezone offset)`;

function sse(res, event, data) {
	res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function chat(req, res, { message, images, sessionId, history }) {
	if (!MCP_URL || !MCP_TOKEN_RO)
		return send(res, 503, { error: 'chat requires APP_MCP_URL and MCP_TOKEN(_RO)' });
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

	const allowed = new Set([
		...CHAT_READ_TOOLS,
		'mcp__proposer__propose_action',
		'WebSearch',
		'WebFetch'
	]);

	// Resume only when the session file still exists; otherwise replay the persisted
	// history (passed by the app from the chats table) so a reopened/redeployed chat
	// actually remembers what's on screen.
	const resume = typeof sessionId === 'string' && sessionId !== '' && sessionOnDisk(sessionId);
	const context = resume ? null : historyBlock(history);

	const content = [];
	if (context) content.push({ type: 'text', text: context });
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
		// Base built-ins: web only (macro verification needs current restaurant data).
		// `tools` is the availability set — Bash/Write/etc. stay out entirely.
		tools: ['WebSearch', 'WebFetch'],
		mcpServers: {
			// RO token: even if a prompt-injected label tricked the model into a write
			// tool, /mcp itself refuses writes on this bearer.
			health: { type: 'http', url: MCP_URL, headers: { Authorization: `Bearer ${MCP_TOKEN_RO}` } },
			proposer
		},
		allowedTools: [...allowed],
		canUseTool: gate(allowed),
		maxTurns: 20,
		settingSources: []
	};
	if (resume) options.resume = sessionId;

	try {
		let streamedText = false;
		for await (const m of query({ prompt: gen(), options })) {
			if (m.type === 'system' && m.subtype === 'init' && m.session_id) {
				sse(res, 'session', { sessionId: m.session_id });
			} else if (m.type === 'stream_event') {
				const ev = m.event;
				if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
					streamedText = true;
					sse(res, 'delta', { text: ev.delta.text });
				}
			} else if (m.type === 'result') {
				if (m.subtype !== 'success') {
					sse(res, 'error', { message: `chat failed: ${m.subtype}` });
				} else if (!streamedText && typeof m.result === 'string' && m.result) {
					// Deltas didn't stream (env doesn't emit partial text) — send the final
					// answer once so the user always sees the reply instead of nothing.
					sse(res, 'delta', { text: m.result });
				}
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
		if (req.url === '/describe' || req.url === '/report' || req.url === '/insight') {
			// Abort the Claude run when the caller disconnects (the app-side fetch aborts
			// /describe at 90s, /report at 240s, /insight at 300s) — otherwise the SDK
			// keeps burning the Max-subscription rate limit on a response nobody reads.
			const abortController = new AbortController();
			res.on('close', () => abortController.abort()); // no-op after a completed run
			if (req.url === '/describe')
				return send(res, 200, { food: await describe(body, abortController) });
			if (req.url === '/insight')
				return send(res, 200, { result: await insight(body, abortController) });
			return send(res, 200, { result: await report(body, abortController) });
		}
		if (req.url === '/chat') return await chat(req, res, body); // manages its own SSE response
		return send(res, 404, { error: 'not found' });
	} catch (e) {
		if (res.writableEnded || res.destroyed) return; // client hung up (abort) — nobody to answer
		const status = e?.status ?? 500;
		if (status >= 500) console.error(e);
		send(res, status, { error: e?.message ?? 'internal error' });
	}
});

server.listen(PORT, HOST, () => console.log(`agent listening on ${HOST}:${PORT}`));
