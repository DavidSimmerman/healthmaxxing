import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { foods } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { lookupBarcode } from '$lib/server/openFoodFacts';
import { createAndLogFood, FoodInputError, findFoodByBarcode } from '$lib/server/foods';
import { canonicalBarcode, macrosDiffer, toSnapshot, type MacroSnapshot } from '$lib/barcode';
import { lookupFdcByUpc } from '$lib/server/fdc';
import { mergeNutrients, scaleNutrients } from '$lib/nutrients';
import { bolusableCarbsPerServing } from '$lib/netCarbs';
import { getFiberMode } from '$lib/server/prefs';

// Decorate a foods row with derived per-serving bolusable (net glycemic) carbs,
// matching /api/foods/history — so the scan card and meal staging show the dose
// figure (and a barcode food can be staged into a multi-item meal). One getFiberMode
// read per request: only the taken return path calls this.
async function withBolusable(food: typeof foods.$inferSelect) {
	const b = bolusableCarbsPerServing(food, { fiberMode: await getFiberMode() });
	return { ...food, bolusableCarbsG: b.bolusableCarbsG, bolusableLowConfidence: b.lowConfidence };
}

// Lookup flow (a scan ALWAYS re-checks the source so a stale DB copy can't go
// unnoticed — the DB version still provides the final/logged macros):
//   1. Resolve our cached food by canonical barcode (UPC-A 12 ≡ EAN-13 13).
//   2. Always query Open Food Facts too.
//      • Non-overridden (source-mirrored) row → silently sync it to OFF.
//      • Overridden (hand-corrected) row      → keep the user's macros, but if
//        OFF changed since the baseline we recorded, return `sourceUpdate` so
//        the UI can offer Update / Dismiss.
//   3. No cached row → cache OFF if found; else tell the caller to enter by hand.
export async function GET({ params }) {
	const code = params.code;
	// Cache (DB) and source (network) lookups are independent — run them together.
	// Only the variant-form retry below needs the cached row.
	const [cached, offScanned] = await Promise.all([findFoodByBarcode(code), lookupBarcode(code)]);

	let off = offScanned;
	// `findFoodByBarcode` may have matched a UPC-A/EAN-13 variant of the scanned
	// code. If OFF didn't resolve the scanned form, retry with the cached row's
	// stored form so the stale-source check still runs for that exact mismatch.
	if (!off.ok && cached?.barcode && cached.barcode !== code) {
		off = await lookupBarcode(cached.barcode);
	}
	const offData = off.ok ? off : null;
	const offMacros: MacroSnapshot | null = offData ? toSnapshot(offData) : null;

	if (cached) {
		if (!cached.overridden) {
			// Plain source-mirrored food: keep it faithfully in step with OFF — macros,
			// serving size AND weight (a serving-only change still affects gram/volume
			// logging). Mirror OFF's fields exactly instead of coalescing, so a product
			// OFF only has per-100g data for (servingGrams null) doesn't keep a stale
			// serving weight paired with per-100g macros.
			if (offData) {
				const changed =
					macrosDiffer(toSnapshot(cached), offMacros) ||
					cached.servingGrams !== offData.servingGrams ||
					cached.servingSize !== offData.servingSize;
				if (changed) {
					const [updated] = await db
						.update(foods)
						.set({
							calories: offData.calories,
							proteinG: offData.proteinG,
							carbsG: offData.carbsG,
							fatG: offData.fatG,
							servingSize: offData.servingSize,
							servingGrams: offData.servingGrams,
							nutrients: offData.nutrients,
							sourceMacros: offMacros,
							sourceCheckedAt: new Date(),
							updatedAt: new Date()
						})
						.where(eq(foods.id, cached.id))
						.returning();
					return json({ food: await withBolusable(updated), source: 'cache' });
				}
				if (!cached.sourceMacros) {
					await db
						.update(foods)
						.set({ sourceMacros: offMacros, sourceCheckedAt: new Date() })
						.where(eq(foods.id, cached.id));
				}
			}
			return json({ food: await withBolusable(cached), source: 'cache' });
		}

		// Overridden food: keep the user's macros; compare the SOURCE to our baseline.
		if (offData) {
			if (!cached.sourceMacros) {
				// First sighting since the override: record the baseline, don't notify
				// (we have nothing to compare against yet).
				const [updated] = await db
					.update(foods)
					.set({ sourceMacros: offMacros, sourceCheckedAt: new Date() })
					.where(eq(foods.id, cached.id))
					.returning();
				return json({ food: await withBolusable(updated), source: 'cache' });
			}
			if (macrosDiffer(cached.sourceMacros, offMacros)) {
				await db.update(foods).set({ sourceCheckedAt: new Date() }).where(eq(foods.id, cached.id));
				return json({
					food: await withBolusable(cached),
					source: 'cache',
					sourceUpdate: {
						current: toSnapshot(cached),
						incoming: offMacros,
						servingSize: offData.servingSize ?? null
					}
				});
			}
		}
		return json({ food: await withBolusable(cached), source: 'cache' });
	}

	// Not cached yet — cache the OFF product (source-mirrored, baseline = OFF).
	if (off.ok) {
		// Fill micronutrient gaps OFF is missing from an EXACT FDC UPC match (same
		// product — no fuzzy matching). OFF values win; FDC only supplies keys OFF
		// lacks. Best-effort with a tight timeout so a slow/absent FDC never blocks
		// caching the scan. FDC is per-100g while off.nutrients matches the stored
		// macro basis: per serving when servingGrams is known, else per-100g — so
		// scale FDC to the same basis before merging (mirrors the storedIs100g rule).
		const fdc = await lookupFdcByUpc(code, 2500).catch(() => null);
		const factor = off.servingGrams && off.servingGrams > 0 ? off.servingGrams / 100 : 1;
		const nutrients = fdc
			? mergeNutrients(scaleNutrients(fdc.nutrients, factor), off.nutrients)
			: off.nutrients;
		const [inserted] = await db
			.insert(foods)
			.values({
				name: off.name,
				brand: off.brand,
				barcode: canonicalBarcode(code),
				servingSize: off.servingSize,
				servingGrams: off.servingGrams,
				calories: off.calories,
				proteinG: off.proteinG,
				carbsG: off.carbsG,
				fatG: off.fatG,
				nutrients,
				categories: off.categories,
				source: 'off',
				sourcePayload: off.raw,
				overridden: false,
				sourceMacros: offMacros,
				sourceCheckedAt: new Date()
			})
			.returning();
		return json({ food: await withBolusable(inserted), source: 'off' });
	}

	return json({
		food: null,
		message: `Barcode ${code} not in Open Food Facts (${off.reason}).`
	});
}

// PUT /api/barcode/:code — reconcile a flagged source change. Re-fetches OFF
// (never trusts client-supplied macros) and applies the user's choice:
//   • update  → the company is now correct: macros := OFF and DROP the override,
//     so the food reverts to mirroring the live source from here on.
//   • dismiss → keep my values; re-baseline to the current source so the same
//     change won't nag again (it'll only re-alert if the source changes anew).
// Name/brand are left alone — the override may have fixed an incomplete OFF name.
export async function PUT({ params, request }) {
	const { action } = (await request.json()) as { action?: string };
	const food = await findFoodByBarcode(params.code);
	if (!food) throw error(404, 'food not found');

	let off = await lookupBarcode(params.code);
	// Same UPC-A/EAN-13 variant fallback as GET, so a change surfaced from the
	// cached form can actually be reconciled (not just 409'd).
	if (!off.ok && food.barcode && food.barcode !== params.code) {
		off = await lookupBarcode(food.barcode);
	}
	if (!off.ok) throw error(409, 'source no longer resolvable; nothing to reconcile against');
	const offMacros = {
		calories: off.calories,
		proteinG: off.proteinG,
		carbsG: off.carbsG,
		fatG: off.fatG
	};

	if (action === 'update') {
		// Accepting the source = revert to a faithful OFF mirror: drop the override,
		// reset provenance to 'off' (so the per-100g/per-serving basis logic keys off
		// it correctly), and take OFF's serving fields exactly. Name/brand are kept —
		// the override may have fixed an incomplete OFF name.
		const [updated] = await db
			.update(foods)
			.set({
				calories: offMacros.calories,
				proteinG: offMacros.proteinG,
				carbsG: offMacros.carbsG,
				fatG: offMacros.fatG,
				servingSize: off.servingSize,
				servingGrams: off.servingGrams,
				nutrients: off.nutrients,
				source: 'off',
				overridden: false,
				sourceMacros: offMacros,
				sourceCheckedAt: new Date(),
				updatedAt: new Date()
			})
			.where(eq(foods.id, food.id))
			.returning();
		return json({ food: await withBolusable(updated) });
	}

	if (action === 'dismiss') {
		const [updated] = await db
			.update(foods)
			.set({ sourceMacros: offMacros, sourceCheckedAt: new Date() })
			.where(eq(foods.id, food.id))
			.returning();
		return json({ food: await withBolusable(updated) });
	}

	throw error(400, 'unknown action');
}

// POST /api/barcode/:code — save a food the user entered by hand for a barcode
// Open Food Facts didn't know (or to correct one it got wrong), caching it under
// the canonical barcode. Browser-only (session-gated by hooks); upserts by
// barcode (via prepFood, which flags it as an override) and logs to today.
export async function POST({ params, request }) {
	const body = await request.json();
	try {
		// Create but DON'T log — the capture sheet stages it into the meal (review →
		// one confirm logs everything), matching the found-barcode flow so an
		// in-progress meal is never discarded. Decorate with derived bolusable carbs.
		const { food } = await createAndLogFood({
			...body,
			barcode: params.code,
			source: body.source ?? 'manual',
			logToday: false
		});
		return json({ food: await withBolusable(food) });
	} catch (e) {
		if (e instanceof FoodInputError) throw error(400, e.message);
		throw e;
	}
}
