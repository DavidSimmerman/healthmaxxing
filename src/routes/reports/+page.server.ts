import { db } from '$lib/server/db';
import { chats, reports } from '$lib/server/db/schema';
import { desc, eq, or, sql } from 'drizzle-orm';

// The Assistant page: a single list of saved chats AND scheduled reports, newest first.
// Scheduled report CHATS (kind daily/weekly/monthly) are chats here — replyable. Legacy
// reports keep living in their own table (rendered read-only at /reports/[id]); we just
// surface them alongside.
export async function load() {
	const [chatRows, reportRows] = await Promise.all([
		db
			.select({
				id: chats.id,
				title: chats.title,
				updatedAt: chats.updatedAt,
				kind: chats.kind,
				dateLabel: chats.dateLabel,
				unread: chats.unread
			})
			.from(chats)
			// Empty report rows are in-progress generation claims — hide until content lands.
			.where(or(eq(chats.kind, 'chat'), sql`jsonb_array_length(${chats.messages}) > 0`))
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
			tag: null as string | null,
			// 'daily' | 'weekly' | 'monthly' rows get a label chip + unread dot in the list.
			chatKind: c.kind as 'chat' | 'daily' | 'weekly' | 'monthly',
			dateLabel: c.dateLabel,
			unread: c.unread
		})),
		...reportRows.map((r) => ({
			kind: 'report' as const,
			id: r.id,
			title: r.title,
			at: r.createdAt.toISOString(),
			tag: r.tag,
			chatKind: null,
			dateLabel: null as string | null,
			unread: false
		}))
	].sort((a, b) => (a.at < b.at ? 1 : -1));

	return { items };
}
