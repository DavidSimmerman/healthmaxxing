import { db } from '$lib/server/db';
import { foods, dailyLog, quickAdds, type Ingredient } from '$lib/server/db/schema';
import { and, desc, eq, ilike, isNull } from 'drizzle-orm';
import { sanitizeNutrients, scaleNutrients, sumNutrients } from '$lib/nutrients';
import type { Nutrients } from '$lib/nutrients';
import { toServings, UNITS, type Unit } from '$lib/units';
import { lookupBarcodeRich, type MacroBundle } from '$lib/server/openFoodFacts';

export class FoodInputError extends Error {}

type FoodRow = typeof foods.$inferSelect;
type LogRow = typeof dailyLog.$inferSelect;

const posNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// ── Recipe macros ───────────────────────────────────────────────────────────
// Ingredient macros are whole-recipe contributions; per-serving = sum / makesServings.
function perServingFromIngredients(ingredients: Ingredient[], makesServings: number) {
	const serv = makesServings > 0 ? makesServings : 1;
	let calories = 0;
	let proteinG = 0;
	let carbsG = 0;
	let fatG = 0;
	const bags: (Partial<Nutrients> | null | undefined)[] = [];
	for (const ing of ingredients) {
		calories += posNum(ing.calories);
		proteinG += posNum(ing.proteinG);
		carbsG += posNum(ing.carbsG);
		fatG += posNum(ing.fatG);
		bags.push(ing.nutrients);
	}
	return {
		calories: calories / serv,
		proteinG: proteinG / serv,
		carbsG: carbsG / serv,
		fatG: fatG / serv,
		nutrients: scaleNutrients(sumNutrients(bags), 1 / serv)
	};
}

// Strip ingredient input down to valid rows with finite, non-negative macros.
function sanitizeIngredients(input: unknown): Ingredient[] {
	if (!Array.isArray(input)) return [];
	const out: Ingredient[] = [];
	for (const raw of input) {
		if (!raw || typeof raw !== 'object') continue;
		const r = raw as Record<string, unknown>;
		const name = typeof r.name === 'string' ? r.name.trim() : '';
		if (!name) continue;
		out.push({
			name,
			amount: typeof r.amount === 'string' && r.amount.trim() ? r.amount.trim() : null,
			barcode: typeof r.barcode === 'string' && r.barcode.trim() ? r.barcode.trim() : null,
			calories: posNum(r.calories),
			proteinG: posNum(r.proteinG),
			carbsG: posNum(r.carbsG),
			fatG: posNum(r.fatG),
			nutrients: sanitizeNutrients(r.nutrients)
		});
	}
	return out;
}

// ── prep / upsert a food ──────────────────────────────────────────────────────
export type PrepFoodInput = {
	id?: string | null; // update this existing food when provided
	name?: string;
	brand?: string | null;
	barcode?: string | null;
	servingSize?: string | null;
	servingGrams?: number | null;
	calories?: number; // direct per-serving macros (ignored when ingredients are given)
	proteinG?: number;
	carbsG?: number;
	fatG?: number;
	nutrients?: Partial<Nutrients> | null;
	categories?: string | null;
	source?: string;
	sourcePayload?: unknown;
	resolverNote?: string | null;
	ingredients?: Ingredient[] | null; // recipe breakdown (whole-recipe contributions)
	makesServings?: number | null;
	totalGrams?: number | null; // cooked batch weight, enables logging by grams
	pinToQuickAdds?: boolean;
};

// Create or update a food/recipe WITHOUT logging it. The seam for meal prep.
// Resolves the row to update by `id`, else by `barcode`; otherwise inserts.
// When ingredients are supplied, per-serving macros (and servingGrams) are derived
// from them; otherwise the direct macro fields are used. Updates merge field-by-field
// so the caller can change one thing (e.g. a single ingredient) without resending all.
export async function prepFood(input: PrepFoodInput): Promise<FoodRow> {
	let existing: FoodRow | null = null;
	if (input.id) {
		[existing] = await db.select().from(foods).where(eq(foods.id, input.id));
		if (!existing) throw new FoodInputError(`No food with id ${input.id}`);
	} else if (input.barcode) {
		[existing] = await db.select().from(foods).where(eq(foods.barcode, input.barcode));
	}

	// Effective ingredients: explicit input wins, else keep what's stored.
	const ingredients =
		input.ingredients !== undefined
			? sanitizeIngredients(input.ingredients)
			: (existing?.ingredients ?? []);
	const isRecipe = ingredients.length > 0;

	const makesServings = input.makesServings ?? existing?.makesServings ?? 1;
	const totalGrams = input.totalGrams ?? existing?.totalGrams ?? null;

	if (!existing) {
		if (!input.name?.trim()) throw new FoodInputError('name required to create a food');
		if (!isRecipe && input.calories == null) {
			throw new FoodInputError('calories or ingredients required to create a food');
		}
	}

	// Per-serving macros: derived from ingredients for a recipe, else direct fields.
	const macros = isRecipe
		? perServingFromIngredients(ingredients, makesServings)
		: {
				calories: input.calories ?? existing?.calories ?? 0,
				proteinG: input.proteinG ?? existing?.proteinG ?? 0,
				carbsG: input.carbsG ?? existing?.carbsG ?? 0,
				fatG: input.fatG ?? existing?.fatG ?? 0,
				nutrients:
					input.nutrients !== undefined
						? sanitizeNutrients(input.nutrients)
						: (existing?.nutrients ?? null)
			};

	// A recipe with a known batch weight derives its per-serving grams (for gram logging).
	const servingGrams =
		isRecipe && totalGrams && makesServings > 0
			? totalGrams / makesServings
			: (input.servingGrams ?? existing?.servingGrams ?? null);

	const payload =
		input.resolverNote || input.sourcePayload
			? {
					...(typeof input.sourcePayload === 'object' && input.sourcePayload
						? input.sourcePayload
						: {}),
					...(input.resolverNote ? { note: input.resolverNote } : {})
				}
			: (existing?.sourcePayload ?? null);

	const values = {
		name: input.name?.trim() ?? existing!.name,
		brand: input.brand !== undefined ? (input.brand ?? null) : (existing?.brand ?? null),
		barcode: input.barcode !== undefined ? input.barcode || null : (existing?.barcode ?? null),
		servingSize:
			input.servingSize !== undefined
				? (input.servingSize ?? null)
				: (existing?.servingSize ?? null),
		servingGrams,
		calories: macros.calories,
		proteinG: macros.proteinG,
		carbsG: macros.carbsG,
		fatG: macros.fatG,
		nutrients: macros.nutrients,
		categories:
			input.categories !== undefined ? (input.categories ?? null) : (existing?.categories ?? null),
		ingredients: isRecipe ? ingredients : null,
		makesServings: isRecipe ? makesServings : null,
		totalGrams: isRecipe ? totalGrams : null,
		source: input.source ?? existing?.source ?? 'claude_code',
		sourcePayload: payload as unknown,
		archivedAt: null, // prepping/curating a food revives it into search
		updatedAt: new Date()
	};

	let food: FoodRow;
	if (existing) {
		[food] = await db.update(foods).set(values).where(eq(foods.id, existing.id)).returning();
	} else if (values.barcode) {
		// Atomic upsert: two concurrent creates with the same barcode would otherwise
		// race past the earlier `select` and collide on the unique constraint — the
		// loser failing without logging. On conflict, update to the new values.
		[food] = await db
			.insert(foods)
			.values(values)
			.onConflictDoUpdate({ target: foods.barcode, set: values })
			.returning();
	} else {
		[food] = await db.insert(foods).values(values).returning();
	}

	if (input.pinToQuickAdds) {
		const [pinned] = await db.select().from(quickAdds).where(eq(quickAdds.foodId, food.id));
		if (!pinned) await db.insert(quickAdds).values({ foodId: food.id });
	}

	return food;
}

export type CreateAndLogInput = PrepFoodInput & {
	name: string;
	calories?: number;
	logToday?: boolean;
	servings?: number;
	amount?: number | null;
	unit?: Unit | null;
};

// Upsert a food (via prepFood) and optionally log it to today. Shared by the REST
// endpoint (POST /api/foods) and the MCP `log_food` tool so both behave identically.
export async function createAndLogFood(
	input: CreateAndLogInput
): Promise<{ food: FoodRow; logEntry: LogRow | null }> {
	const food = await prepFood(input);

	let logEntry: LogRow | null = null;
	if (input.logToday) {
		// Prefer an explicit amount+unit (e.g. grams); fall back to a servings multiplier.
		const hasAmount = typeof input.amount === 'number' && Number.isFinite(input.amount);
		const unit: Unit = (input.unit as Unit) ?? 'serving';
		if (hasAmount) {
			if (!UNITS.includes(unit)) throw new FoodInputError(`Unknown unit "${input.unit}".`);
			if ((input.amount as number) <= 0) throw new FoodInputError('amount must be greater than 0.');
			// Gram/volume units need a serving weight to convert; without one, toServings
			// silently treats the amount as servings (188g → 188 servings). Reject instead.
			if (unit !== 'serving' && !(food.servingGrams && food.servingGrams > 0)) {
				throw new FoodInputError(`Cannot log "${food.name}" by ${unit}: it has no serving weight.`);
			}
		}
		const servings = hasAmount
			? toServings(input.amount as number, unit, food.servingGrams)
			: typeof input.servings === 'number' && Number.isFinite(input.servings) && input.servings > 0
				? input.servings
				: 1;
		if (!Number.isFinite(servings) || servings <= 0) {
			throw new FoodInputError('Could not resolve a positive amount to log.');
		}

		[logEntry] = await db
			.insert(dailyLog)
			.values({
				foodId: food.id,
				servings,
				amount: hasAmount ? (input.amount as number) : null,
				unit: hasAmount ? unit : null,
				calories: food.calories * servings,
				proteinG: food.proteinG * servings,
				carbsG: food.carbsG * servings,
				fatG: food.fatG * servings
			})
			.returning();
	}

	return { food, logEntry };
}

// ── Soft delete ───────────────────────────────────────────────────────────────
// Hide a food from search (and remove any quick-add tile) without touching the
// daily_log rows that reference it — past days render from their own cached macros.
export async function archiveFood(id: string): Promise<FoodRow | null> {
	const [food] = await db
		.update(foods)
		.set({ archivedAt: new Date() })
		.where(eq(foods.id, id))
		.returning();
	if (!food) return null;
	await db.delete(quickAdds).where(eq(quickAdds.foodId, id));
	return food;
}

// ── Catalog search (for the MCP `list_foods` tool) ─────────────────────────────
export type FoodSearchResult = Pick<
	FoodRow,
	| 'id'
	| 'name'
	| 'brand'
	| 'barcode'
	| 'servingSize'
	| 'servingGrams'
	| 'calories'
	| 'proteinG'
	| 'carbsG'
	| 'fatG'
	| 'ingredients'
	| 'makesServings'
	| 'totalGrams'
	| 'updatedAt'
>;

// Non-archived catalog rows, newest-touched first, optionally filtered by name.
// Returns ingredients so Claude can tweak a single one and resubmit via prep_food.
export async function searchFoods(query?: string, limit = 25): Promise<FoodSearchResult[]> {
	const q = query?.trim();
	const where = q
		? and(isNull(foods.archivedAt), ilike(foods.name, `%${q}%`))
		: isNull(foods.archivedAt);
	return db
		.select({
			id: foods.id,
			name: foods.name,
			brand: foods.brand,
			barcode: foods.barcode,
			servingSize: foods.servingSize,
			servingGrams: foods.servingGrams,
			calories: foods.calories,
			proteinG: foods.proteinG,
			carbsG: foods.carbsG,
			fatG: foods.fatG,
			ingredients: foods.ingredients,
			makesServings: foods.makesServings,
			totalGrams: foods.totalGrams,
			updatedAt: foods.updatedAt
		})
		.from(foods)
		.where(where)
		.orderBy(desc(foods.updatedAt))
		.limit(Math.min(Math.max(limit, 1), 100));
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
