import { db } from '$lib/server/db';
import { chats } from '$lib/server/db/schema';
import { count, eq } from 'drizzle-orm';

// Unread-chat count for the nav badge. `depends('app:unread')` lets pages refresh just
// this after marking a chat read (invalidate('app:unread')); invalidateAll() covers the rest.
export async function load({ depends }) {
	depends('app:unread');
	const [row] = await db.select({ n: count() }).from(chats).where(eq(chats.unread, true));
	return { unreadChats: row?.n ?? 0 };
}
