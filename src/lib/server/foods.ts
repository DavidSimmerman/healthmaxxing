import { db } from '$lib/server/db';
import { foods, dailyLog, quickAdds } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { sanitizeNutrients, scaleNutrients } from '$lib/nutrients';
import type { Nutrients } from '$lib/nutrients';
import { lookupBarcodeRich, type MacroBundle } from '$lib/server/openFoodFacts';

export type CreateAndLogInput = {
	name: string;
	brand?: string | null;
	barcode?: string | null;
	servingSize?: string | null;
	servingGrams?: number | null;
	calories: number;
	proteinG?: number;
	carbsG?: number;
	fatG?: number;
	nutrients?: Partial<Nutrients> | null;
	categories?: string | null;
	source?: string;
	sourcePayload?: unknown;
	resolverNote?: string | null;
	logToday?: boolean;
	servings?: number;
	pinToQuickAdds?: boolean;
};

export class FoodInputError extends Error {}

type FoodRow = typeof foods.$inferSelect;
type LogRow = typeof dailyLog.$inferSelect;

// Create-or-upsert a food and optionally log it to today. Shared by the REST
// endpoint (POST /api/foods) and the MCP `log_food` tool so both behave identically.
export async function createAndLogFood(
	input: CreateAndLogInput
): Promise<{ food: FoodRow; logEntry: LogRow | null }> {
	const { name, calories } = input;
	if (!name || calories == null) {
		throw new FoodInputError('name and calories required');
	}

	const servings =
		typeof input.servings === 'number' && Number.isFinite(input.servings) && input.servings > 0
			? input.servings
			: 1;

	const cleanNutrients = sanitizeNutrients(input.nutrients);
	const payload =
		input.resolverNote || input.sourcePayload
			? {
					...(typeof input.sourcePayload === 'object' && input.sourcePayload
						? input.sourcePayload
						: {}),
					...(input.resolverNote ? { note: input.resolverNote } : {})
				}
			: null;

	const values = {
		name,
		brand: input.brand ?? null,
		barcode: input.barcode || null,
		servingSize: input.servingSize ?? null,
		servingGrams: input.servingGrams ?? null,
		calories,
		proteinG: input.proteinG ?? 0,
		carbsG: input.carbsG ?? 0,
		fatG: input.fatG ?? 0,
		nutrients: cleanNutrients,
		categories: input.categories ?? null,
		source: input.source ?? 'claude_code',
		sourcePayload: payload as unknown
	};

	// Upsert by barcode when provided; else plain insert.
	let food: FoodRow;
	if (values.barcode) {
		[food] = await db
			.insert(foods)
			.values(values)
			.onConflictDoUpdate({
				target: foods.barcode,
				set: {
					name: values.name,
					brand: values.brand,
					servingSize: values.servingSize,
					servingGrams: values.servingGrams,
					calories: values.calories,
					proteinG: values.proteinG,
					carbsG: values.carbsG,
					fatG: values.fatG,
					nutrients: values.nutrients,
					categories: values.categories,
					source: values.source,
					sourcePayload: values.sourcePayload,
					updatedAt: new Date()
				}
			})
			.returning();
	} else {
		[food] = await db.insert(foods).values(values).returning();
	}

	let logEntry: LogRow | null = null;
	if (input.logToday) {
		[logEntry] = await db
			.insert(dailyLog)
			.values({
				foodId: food.id,
				servings,
				calories: food.calories * servings,
				proteinG: food.proteinG * servings,
				carbsG: food.carbsG * servings,
				fatG: food.fatG * servings
			})
			.returning();
	}

	if (input.pinToQuickAdds) {
		const [existing] = await db.select().from(quickAdds).where(eq(quickAdds.foodId, food.id));
		if (!existing) await db.insert(quickAdds).values({ foodId: food.id });
	}

	return { food, logEntry };
}

// ── Read-only barcode resolution for the MCP `lookup_barcode` tool ─────────────
export type BarcodeLookup = {
	barcode: string;
	found: boolean;
	source: 'cache' | 'off' | null;
	name?: string;
	brand?: string | null;
	servingSize?: string | null;
	servingGrams?: number | null;
	dataBasis?: '100g' | 'serving';
	per100g?: MacroBundle | null;
	perServing?: MacroBundle | null;
	note?: string;
};

// Resolve one barcode to macros on both bases without writing anything. Prefers
// the personal cache (which may hold user-corrected values) over Open Food Facts.
// Recipe ingredients are looked up, not cataloged — so this never inserts.
export async function lookupBarcodeMacros(code: string): Promise<BarcodeLookup> {
	const [cached] = await db.select().from(foods).where(eq(foods.barcode, code));
	if (cached) {
		const grams = cached.servingGrams;
		const hasGrams = !!grams && grams > 0;
		const stored: MacroBundle = {
			calories: cached.calories,
			proteinG: cached.proteinG,
			carbsG: cached.carbsG,
			fatG: cached.fatG,
			nutrients: cached.nutrients ?? null
		};
		const scale = (factor: number): MacroBundle => ({
			calories: stored.calories * factor,
			proteinG: stored.proteinG * factor,
			carbsG: stored.carbsG * factor,
			fatG: stored.fatG * factor,
			nutrients: scaleNutrients(stored.nutrients, factor)
		});
		// Rows the browser /api/barcode route cached from an OFF product that had
		// no serving weight store per-100g macros with servingGrams null. Every
		// other row (manual entries, OFF rows with a weight) stores per-serving.
		const storedIs100g = cached.source === 'off' && !hasGrams;
		const per100g = storedIs100g ? stored : hasGrams ? scale(100 / grams!) : null;
		const perServing = storedIs100g ? null : stored;
		return {
			barcode: code,
			found: true,
			source: 'cache',
			name: cached.name,
			brand: cached.brand,
			servingSize: cached.servingSize,
			servingGrams: grams,
			dataBasis: storedIs100g ? '100g' : 'serving',
			per100g,
			perServing
		};
	}

	const off = await lookupBarcodeRich(code);
	if (off.ok) {
		return {
			barcode: code,
			found: true,
			source: 'off',
			name: off.name,
			brand: off.brand,
			servingSize: off.servingSize,
			servingGrams: off.servingGrams,
			dataBasis: off.dataBasis,
			per100g: off.per100g,
			perServing: off.perServing
		};
	}

	return {
		barcode: code,
		found: false,
		source: null,
		note: `Barcode ${code} not resolvable (${off.reason}). Do not guess macros.`
	};
}
