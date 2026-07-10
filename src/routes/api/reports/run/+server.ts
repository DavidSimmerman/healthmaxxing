import { json, error } from '@sveltejs/kit';
import { generateReportChat } from '$lib/server/reportChats';

// POST /api/reports/run { kind: 'daily'|'weekly'|'monthly' } — manually trigger a
// report chat. Auth: the global gate in hooks.server.ts ("First-party auth gate")
// already covers /api/* — session cookie or Bearer API token — no extra guard here.
// Default is fire-and-forget (a Cloudflare-proxied request can't outlive ~100s);
// the chat row lands unread when generation finishes. ?wait=1 awaits (local testing).
export async function POST({ request, url }) {
	const body = await request.json().catch(() => ({}));
	const kind = body.kind;
	if (kind !== 'daily' && kind !== 'weekly' && kind !== 'monthly') {
		throw error(400, 'kind must be daily | weekly | monthly');
	}
	if (url.searchParams.get('wait') === '1') {
		return json({ status: await generateReportChat(kind) });
	}
	// .catch: a pre-claim rejection (e.g. DB down) must not become an unhandled rejection.
	void generateReportChat(kind).catch((e) => console.error('[reports] run failed:', e));
	return json({ started: true }, { status: 202 });
}
