import { json, error } from '@sveltejs/kit';
import { generateReport } from '$lib/server/agent';

// POST /api/reports/generate  { period?, from?, to?, instruction? }
// Claude reads the user's data via the app's /mcp and calls save_report. The new
// report then shows up in the reports list on reload. Session-gated by hooks.
export async function POST({ request }) {
	const body = await request.json().catch(() => ({}));
	try {
		const result = await generateReport({
			period: body.period,
			from: body.from,
			to: body.to,
			instruction: body.instruction
		});
		return json({ result });
	} catch (e) {
		throw error(502, `report failed: ${(e as Error).message}`);
	}
}
