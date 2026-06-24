import { db } from '$lib/server/db';
import { reports } from '$lib/server/db/schema';
import { desc } from 'drizzle-orm';

// Recent analysis reports written by the scheduled Claude review (via save_report).
// The list intentionally omits `content` (markdown) — that's rendered/sanitized in
// the detail loader, keeping this query light.
export async function load() {
	const rows = await db
		.select({
			id: reports.id,
			createdAt: reports.createdAt,
			title: reports.title,
			period: reports.period,
			rangeFrom: reports.rangeFrom,
			rangeTo: reports.rangeTo,
			tag: reports.tag
		})
		.from(reports)
		.orderBy(desc(reports.createdAt))
		.limit(100);

	return { reports: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })) };
}
