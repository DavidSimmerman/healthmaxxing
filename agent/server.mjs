// Claude sandbox for healthmaxxing — a locked-down Claude Code container the app
// calls over the private network. Auth is the user's Max subscription via
// CLAUDE_CODE_OAUTH_TOKEN (no API billing). Two jobs:
//   POST /describe  {image?, mediaType?, text?}  -> validated food JSON (vision, NO tools)
//   POST /report    {period?, from?, to?, instruction?} -> Claude reads/writes via the
//                                                          app's /mcp + web, calls save_report
// Everything not in the allowlist is DENIED by canUseTool, so even though Claude Code
// ships Bash/Write/etc., none of them can run here.
import { createServer } from 'node:http';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { parseFood } from './parseFood.mjs';

const PORT = Number(process.env.PORT || 8787);
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
	const content = [{ type: 'text', text: 'Identify this food and return the JSON described in your instructions.' }];
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
	const prompt = `Generate a health analysis report for the "${period || 'recent'}" period${range}. ${instruction || ''}`.trim();

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
		if (req.headers.authorization !== `Bearer ${SECRET}`) return send(res, 401, { error: 'unauthorized' });

		const body = await readJson(req);
		if (req.url === '/describe') return send(res, 200, { food: await describe(body) });
		if (req.url === '/report') return send(res, 200, { result: await report(body) });
		return send(res, 404, { error: 'not found' });
	} catch (e) {
		const status = e?.status ?? 500;
		if (status >= 500) console.error(e);
		send(res, status, { error: e?.message ?? 'internal error' });
	}
});

server.listen(PORT, '0.0.0.0', () => console.log(`agent listening on :${PORT}`));
