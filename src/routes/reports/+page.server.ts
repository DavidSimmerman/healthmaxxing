import { db } from '$lib/server/db';
import { chats, reports } from '$lib/server/db/schema';
import { desc } from 'drizzle-orm';

// The Assistant page: a single list of saved chats AND scheduled reports, newest first.
// Reports keep living in their own table (rendered read-only at /reports/[id]); we just
// surface them here alongside conversations.
export async function load() {
	const [chatRows, reportRows] = await Promise.all([
		db
			.select({ id: chats.id, title: chats.title, updatedAt: chats.updatedAt })
			.from(chats)
			.orderBy(desc(chats.updatedAt))
			.limit(100),
		db
			.select({
				id: reports.id,
				title: reports.title,
				createdAt: reports.createdAt,
				tag: reports.tag
			})
			.from(reports)
			.orderBy(desc(reports.createdAt))
			.limit(100)
	]);

	const items = [
		...chatRows.map((c) => ({
			kind: 'chat' as const,
			id: c.id,
			title: c.title,
			at: c.updatedAt.toISOString(),
			tag: null as string | null
		})),
		...reportRows.map((r) => ({
			kind: 'report' as const,
			id: r.id,
			title: r.title,
			at: r.createdAt.toISOString(),
			tag: r.tag
		}))
	].sort((a, b) => (a.at < b.at ? 1 : -1));

	return { items };
}
