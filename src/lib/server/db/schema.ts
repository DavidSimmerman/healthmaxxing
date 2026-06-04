import { pgTable, text, integer, real, timestamp, uuid, jsonb, index } from 'drizzle-orm/pg-core';

// Master food catalog. Populated as you scan/log new foods.
// Acts as your personal cache — a barcode looked up once is local forever.
export const foods = pgTable(
	'foods',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		name: text('name').notNull(),
		brand: text('brand'),
		barcode: text('barcode').unique(),

		// Per-serving macros
		servingSize: text('serving_size'), // e.g. "1 container (170g)"
		servingGrams: real('serving_grams'),
		calories: real('calories').notNull(),
		proteinG: real('protein_g').notNull(),
		carbsG: real('carbs_g').notNull(),
		fatG: real('fat_g').notNull(),

		// Provenance
		source: text('source').notNull(), // 'off' | 'manual' | 'label_ocr' | 'claude_code' | 'estimate'
		sourcePayload: jsonb('source_payload'), // raw API/OCR response for debugging

		createdAt: timestamp('created_at').notNull().defaultNow(),
		updatedAt: timestamp('updated_at').notNull().defaultNow()
	},
	(t) => [index('foods_barcode_idx').on(t.barcode), index('foods_name_idx').on(t.name)]
);

// Each thing you ate today (and historically).
export const dailyLog = pgTable(
	'daily_log',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		foodId: uuid('food_id')
			.notNull()
			.references(() => foods.id),
		servings: real('servings').notNull().default(1),
		// What the user actually entered (display + edit). `servings` above is the canonical multiplier.
		amount: real('amount'),
		unit: text('unit'), // 'serving' | 'gram' | 'cup' | 'tbsp' | 'tsp'
		loggedAt: timestamp('logged_at').notNull().defaultNow(),

		// Cached macros (so historical entries don't change if the food's macros are edited later)
		calories: real('calories').notNull(),
		proteinG: real('protein_g').notNull(),
		carbsG: real('carbs_g').notNull(),
		fatG: real('fat_g').notNull()
	},
	(t) => [index('daily_log_logged_at_idx').on(t.loggedAt)]
);

// Foods you want surfaced as quick-add tiles on the today view.
export const quickAdds = pgTable('quick_adds', {
	id: uuid('id').primaryKey().defaultRandom(),
	foodId: uuid('food_id')
		.notNull()
		.references(() => foods.id),
	sortOrder: integer('sort_order').notNull().default(0),
	createdAt: timestamp('created_at').notNull().defaultNow()
});

// Items captured but not yet resolved into a real Food.
// Examples: a label photo, a pasted description, a barcode OFF didn't know.
// Claude Code reads this table, resolves each item, posts back via API.
export const pendingItems = pgTable(
	'pending_items',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		kind: text('kind').notNull(), // 'barcode' | 'label_photo' | 'paste' | 'photo_with_caption'
		barcode: text('barcode'), // for kind='barcode' or 'photo_with_caption'
		imagePath: text('image_path'), // path to uploaded image in /static/uploads or similar
		text: text('text'), // pasted description or caption
		servings: real('servings').notNull().default(1),
		status: text('status').notNull().default('pending'), // 'pending' | 'resolved' | 'failed'
		resolvedFoodId: uuid('resolved_food_id').references(() => foods.id),
		resolverNote: text('resolver_note'), // Claude Code can leave a note (assumptions, confidence, etc)
		createdAt: timestamp('created_at').notNull().defaultNow(),
		resolvedAt: timestamp('resolved_at')
	},
	(t) => [index('pending_status_idx').on(t.status)]
);

// User-configurable daily targets. Single-row table for now (solo app).
export const settings = pgTable('settings', {
	id: integer('id').primaryKey().default(1),
	calorieTarget: integer('calorie_target').notNull().default(2100),
	proteinTargetG: integer('protein_target_g').notNull().default(180),
	carbsTargetG: integer('carbs_target_g').notNull().default(220),
	fatTargetG: integer('fat_target_g').notNull().default(70)
});
