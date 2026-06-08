import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { quickAdds } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

// PUT — accepts { order: string[] } (array of quick-add ids) and rewrites sort_order.
export async function PUT({ request }) {
	const body = await request.json();
	const order: unknown = body.order;
	if (!Array.isArray(order) || !order.every((id) => typeof id === 'string')) {
		throw error(400, 'order must be string[]');
	}

	await db.transaction(async (tx) => {
		for (let i = 0; i < order.length; i++) {
			await tx.update(quickAdds).set({ sortOrder: i }).where(eq(quickAdds.id, order[i]));
		}
	});

	return json({ ok: true });
}
