import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { foods } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { lookupBarcode } from '$lib/server/openFoodFacts';
import { createAndLogFood, FoodInputError } from '$lib/server/foods';

// Lookup flow:
//   1. Check personal cache (foods.barcode) — instant if seen before.
//   2. Hit Open Food Facts.
//   3. If both miss, tell the caller so they can enter the macros by hand (or
//      ask Claude to log it via the MCP connector).
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
				categories: off.categories,
				source: 'off',
				sourcePayload: off.raw as any
			})
			.returning();
		return json({ food: inserted, source: 'off' });
	}

	return json({
		food: null,
		message: `Barcode ${code} not in Open Food Facts (${off.reason}).`
	});
}

// POST /api/barcode/:code — save a food the user entered by hand for a barcode
// Open Food Facts didn't know, caching it under the barcode for next time.
// Browser-only (session-gated by hooks); upserts by barcode and logs to today.
export async function POST({ params, request }) {
	const body = await request.json();
	try {
		const { food, logEntry } = await createAndLogFood({
			...body,
			barcode: params.code,
			source: body.source ?? 'manual',
			logToday: true
		});
		return json({ food, logEntry });
	} catch (e) {
		if (e instanceof FoodInputError) throw error(400, e.message);
		throw e;
	}
}
