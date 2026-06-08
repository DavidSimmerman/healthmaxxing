import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { foods, pendingItems } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { lookupBarcode } from '$lib/server/openFoodFacts';

// Lookup flow:
//   1. Check personal cache (foods.barcode) — instant if seen before.
//   2. Hit Open Food Facts.
//   3. If both miss, create a pending_items row and let Claude Code resolve later.
export async function GET({ params }) {
	const code = params.code;

	const [cached] = await db.select().from(foods).where(eq(foods.barcode, code));
	if (cached) return json({ food: cached, source: 'cache' });

	const off = await lookupBarcode(code);
	if (off.ok) {
		const [inserted] = await db
			.insert(foods)
			.values({
				name: off.name,
				brand: off.brand,
				barcode: code,
				servingSize: off.servingSize,
				servingGrams: off.servingGrams,
				calories: off.calories,
				proteinG: off.proteinG,
				carbsG: off.carbsG,
				fatG: off.fatG,
				nutrients: off.nutrients,
				source: 'off',
				sourcePayload: off.raw as any
			})
			.returning();
		return json({ food: inserted, source: 'off' });
	}

	// Create a pending item so Claude Code can resolve it later.
	const [pending] = await db
		.insert(pendingItems)
		.values({ kind: 'barcode', barcode: code })
		.returning();

	return json({
		food: null,
		pendingId: pending.id,
		message: `Barcode ${code} not in Open Food Facts (${off.reason}). Saved as pending.`
	});
}
