import { json } from '@sveltejs/kit';
import { validateAccessToken } from '$lib/server/oauth';
import { createAndLogFood, FoodInputError, type CreateAndLogInput } from '$lib/server/foods';

const PROTOCOL_VERSION = '2025-03-26';

// ── JSON-RPC helpers ──────────────────────────────────────────────────────────
type Id = string | number | null;

function rpcResult(id: Id, result: unknown) {
	return json({ jsonrpc: '2.0', id, result });
}
function rpcError(id: Id, code: number, message: string) {
	return json({ jsonrpc: '2.0', id, error: { code, message } });
}
function toolResult(id: Id, text: string, isError = false) {
	return rpcResult(id, { content: [{ type: 'text', text }], isError });
}

// ── The one tool ──────────────────────────────────────────────────────────────
const NUTRIENT_KEYS =
	'fiberG, sugarG, addedSugarG, sugarAlcoholG, satFatG, transFatG, monoFatG, polyFatG, ' +
	'omega3G, omega6G, cholesterolMg, sodiumMg, potassiumMg, calciumMg, ironMg, magnesiumMg, ' +
	'zincMg, phosphorusMg, vitAUg, vitCMg, vitDUg, vitEMg, vitKUg, vitB6Mg, vitB12Ug, folateUg, ' +
	'caffeineMg, alcoholG';

const LOG_FOOD_TOOL = {
	name: 'log_food',
	description:
		'Create or update a food in the health dashboard and optionally log it to today. ' +
		'Resolve macros per serving from a photo, description, or barcode before calling. ' +
		'Set logToday=true to add it to today (default true unless the user only wants to catalog it). ' +
		'Only include nutrient fields you are confident about; omit unknowns.',
	inputSchema: {
		type: 'object',
		properties: {
			name: {
				type: 'string',
				description: 'Food name, e.g. "Chobani Greek Yogurt - Plain Nonfat"'
			},
			brand: { type: 'string' },
			barcode: { type: 'string', description: 'UPC/EAN if known; upserts on barcode' },
			servingSize: { type: 'string', description: 'e.g. "1 container (170g)"' },
			servingGrams: { type: 'number' },
			calories: { type: 'number', description: 'Per serving, kcal' },
			proteinG: { type: 'number', description: 'Per serving' },
			carbsG: { type: 'number', description: 'Per serving' },
			fatG: { type: 'number', description: 'Per serving' },
			nutrients: {
				type: 'object',
				description: `Optional extended nutrients per serving. Allowed keys: ${NUTRIENT_KEYS}. Unknown keys are ignored.`
			},
			source: {
				type: 'string',
				enum: ['claude_code', 'label_ocr', 'estimate'],
				description: 'Provenance of the macros'
			},
			resolverNote: {
				type: 'string',
				description: 'Confidence / assumptions, e.g. "plate estimate, ±25%"'
			},
			logToday: { type: 'boolean', description: 'Add to today’s log (default true)' },
			servings: { type: 'number', description: 'Servings actually eaten (default 1)' },
			pinToQuickAdds: { type: 'boolean' }
		},
		required: ['name', 'calories']
	}
};

async function callLogFood(id: Id, args: Record<string, unknown>) {
	try {
		// MCP tools default to logging unless the caller explicitly opts out.
		const logToday = args.logToday === undefined ? true : !!args.logToday;
		// Shape validated at runtime inside createAndLogFood (throws FoodInputError).
		const input = { ...args, logToday } as unknown as CreateAndLogInput;
		const { food, logEntry } = await createAndLogFood(input);
		const servings = logEntry?.servings ?? 1;
		const lines = [
			`Saved "${food.name}"${food.brand ? ` (${food.brand})` : ''}.`,
			logEntry
				? `Logged to today${servings !== 1 ? ` ×${servings}` : ''}: ${Math.round(
						logEntry.calories
					)} kcal, ${round1(logEntry.proteinG)}g protein, ${round1(logEntry.carbsG)}g carbs, ${round1(
						logEntry.fatG
					)}g fat.`
				: `Cataloged only (not added to today): ${Math.round(food.calories)} kcal, ${round1(
						food.proteinG
					)}g protein per serving.`
		];
		return toolResult(id, lines.join(' '));
	} catch (e) {
		if (e instanceof FoodInputError) return toolResult(id, `Could not log: ${e.message}`, true);
		console.error('log_food failed:', e);
		return toolResult(id, 'Could not log: an internal error occurred.', true);
	}
}

function round1(n: number): number {
	return Math.round(n * 10) / 10;
}

// ── HTTP handlers ─────────────────────────────────────────────────────────────
function unauthorized(origin: string) {
	return new Response(JSON.stringify({ error: 'invalid_token' }), {
		status: 401,
		headers: {
			'Content-Type': 'application/json',
			'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`
		}
	});
}

export async function POST({ request, url }) {
	// Auth: every MCP request must carry a valid access token. An unauthenticated
	// request gets a 401 whose WWW-Authenticate points Claude.ai at our metadata,
	// kicking off the OAuth flow.
	const auth = request.headers.get('authorization') ?? '';
	const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
	if (!token || !(await validateAccessToken(token))) {
		return unauthorized(url.origin);
	}

	let msg: { jsonrpc?: string; id?: Id; method?: string; params?: Record<string, unknown> };
	try {
		msg = await request.json();
	} catch {
		return rpcError(null, -32700, 'Parse error');
	}

	const { id, method, params } = msg;

	// Notifications (no id) — e.g. notifications/initialized. Ack with 202.
	if (id === undefined || id === null) {
		return new Response(null, { status: 202 });
	}

	switch (method) {
		case 'initialize': {
			const requested =
				typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
			return rpcResult(id, {
				protocolVersion: requested,
				capabilities: { tools: {} },
				serverInfo: { name: 'health-dashboard-mcp', version: '1.0.0' }
			});
		}
		case 'tools/list':
			return rpcResult(id, { tools: [LOG_FOOD_TOOL] });
		case 'tools/call': {
			const name = params?.name;
			const args = (params?.arguments ?? {}) as Record<string, unknown>;
			if (name === 'log_food') return callLogFood(id, args);
			return rpcError(id, -32602, `Unknown tool: ${String(name)}`);
		}
		case 'ping':
			return rpcResult(id, {});
		default:
			return rpcError(id, -32601, `Method not found: ${String(method)}`);
	}
}

// We're a stateless server — no server-initiated SSE stream.
export function GET() {
	return new Response('Method Not Allowed', { status: 405 });
}
