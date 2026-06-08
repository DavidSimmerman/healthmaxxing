import { db } from '$lib/server/db';
import { pendingItems, foods } from '$lib/server/db/schema';
import { desc, eq, ne } from 'drizzle-orm';

export async function load() {
	const pending = await db
		.select()
		.from(pendingItems)
		.where(eq(pendingItems.status, 'pending'))
		.orderBy(desc(pendingItems.createdAt));

	const resolved = await db
		.select({
			id: pendingItems.id,
			kind: pendingItems.kind,
			barcode: pendingItems.barcode,
			imagePath: pendingItems.imagePath,
			text: pendingItems.text,
			status: pendingItems.status,
			resolverNote: pendingItems.resolverNote,
			resolvedAt: pendingItems.resolvedAt,
			createdAt: pendingItems.createdAt,
			foodName: foods.name,
			foodBrand: foods.brand
		})
		.from(pendingItems)
		.leftJoin(foods, eq(pendingItems.resolvedFoodId, foods.id))
		.where(ne(pendingItems.status, 'pending'))
		.orderBy(desc(pendingItems.resolvedAt))
		.limit(20);

	return { pending, resolved };
}
