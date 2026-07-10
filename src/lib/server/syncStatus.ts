import { db } from '$lib/server/db';
import { syncStatus } from '$lib/server/db/schema';

export type SyncSource = 'fitbit' | 'dexcom' | 'tandem' | 'healthkit';

// Record the latest sync attempt per source (one upserted row each; the table is a
// "last known status" board, not a history). NEVER throws — status writing must not
// fail a sync — so callers can await it unguarded on both success and error paths.
export async function recordSync(source: SyncSource, ok: boolean, detail?: string) {
	try {
		const row = { at: new Date(), ok, detail: detail?.slice(0, 200) ?? null };
		await db
			.insert(syncStatus)
			.values({ source, ...row })
			.onConflictDoUpdate({ target: syncStatus.source, set: row });
	} catch (e) {
		console.error(`recordSync(${source}) failed:`, e);
	}
}

// '3 days · 812 readings' from a sync result's numeric fields, in key order.
export function syncDetail(result: Record<string, unknown>): string {
	return Object.entries(result)
		.filter(([, v]) => typeof v === 'number')
		.map(([k, v]) => `${v} ${k}`)
		.join(' · ');
}
