import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { foods } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

// PATCH /api/foods/[id]
// Edit a food's catalog fields. Used to correct names that came in incomplete
// from Open Food Facts (which often omits the product line, e.g. "Puff").
// Session-gated like the rest of /api/* — browser-only.
export async function PATCH({ params, request }) {
	const body = await request.json();
	const updates: Partial<typeof foods.$inferInsert> = {};

	if (typeof body.name === 'string') {
		const name = body.name.trim();
		if (!name) throw error(400, 'name cannot be empty');
		updates.name = name;
	}
	if ('brand' in body) {
		const brand = body.brand == null ? null : String(body.brand).trim();
		updates.brand = brand || null;
	}

	if (Object.keys(updates).length === 0) throw error(400, 'nothing to update');
	updates.updatedAt = new Date();

	const [food] = await db.update(foods).set(updates).where(eq(foods.id, params.id)).returning();
	if (!food) throw error(404, 'food not found');
	return json({ food });
}
