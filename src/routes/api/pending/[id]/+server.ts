import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { pendingItems } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { unlink } from 'node:fs/promises';
import { uploadPath } from '$lib/server/uploads';

export async function DELETE({ params }) {
	const [item] = await db.select().from(pendingItems).where(eq(pendingItems.id, params.id));
	if (!item) throw error(404, 'pending item not found');

	if (item.imagePath) {
		try {
			await unlink(uploadPath(item.imagePath));
		} catch {
			// file already gone — fine
		}
	}

	await db.delete(pendingItems).where(eq(pendingItems.id, params.id));
	return json({ ok: true });
}
