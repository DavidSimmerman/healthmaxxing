import {
	pgTable,
	text,
	integer,
	real,
	timestamp,
	uuid,
	jsonb,
	boolean,
	index,
	primaryKey
} from 'drizzle-orm/pg-core';
import type { Nutrients } from '$lib/nutrients';

// One component of a recipe. Macros are this ingredient's contribution to the
// WHOLE recipe (not per serving). `amount` is the free-text quantity as entered
// (e.g. "6 oz", "1 cup cooked") — kept for display and so a single ingredient
// can be tweaked later without re-entering the rest.
export type Ingredient = {
	name: string;
	amount?: string | null;
	barcode?: string | null;
	calories: number;
	proteinG: number;
	carbsG: number;
	fatG: number;
	nutrients?: Partial<Nutrients> | null;
};

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

		// Optional extended nutrients (per serving). Stored for later AI analysis; not displayed.
		nutrients: jsonb('nutrients').$type<Partial<Nutrients>>(),

		// Human-readable category string (e.g. "Cakes, Protein bars"), mainly from
		// Open Food Facts. Not displayed — used to widen fuzzy search coverage.
		categories: text('categories'),

		// Recipe / meal-prep support. A food may be composed of sub-ingredients so a
		// single one can be tweaked later and the per-serving macros recomputed.
		// `ingredients` holds whole-recipe contributions; the per-serving macros above
		// = sum(ingredients) / makesServings. `servingGrams` above = totalGrams /
		// makesServings, which lets a recipe be logged by grams.
		ingredients: jsonb('ingredients').$type<Ingredient[]>(),
		makesServings: real('makes_servings'), // servings the recipe yields (null = not a recipe)
		totalGrams: real('total_grams'), // cooked batch weight, for logging by grams

		// Provenance
		source: text('source').notNull(), // 'off' | 'manual' | 'label_ocr' | 'claude_code' | 'estimate'
		sourcePayload: jsonb('source_payload'), // raw API/OCR response for debugging

		// Source-tracking (so a hand-corrected food isn't silently stale).
		// `overridden` = the stored macros are a deliberate correction, so a scan
		// keeps showing them and only NOTIFIES when the external source changes.
		// Non-overridden rows just mirror the source on each scan. `sourceMacros`
		// is the last external (Open Food Facts) snapshot we reconciled with — the
		// baseline a fresh lookup is compared against; null until first established.
		overridden: boolean('overridden').notNull().default(false),
		sourceMacros: jsonb('source_macros').$type<{
			calories: number;
			proteinG: number;
			carbsG: number;
			fatG: number;
		}>(),
		sourceCheckedAt: timestamp('source_checked_at'),

		// Soft-delete: hidden from search/quick-adds but kept so historical day
		// entries (which reference foodId and render from cached macros) still resolve.
		archivedAt: timestamp('archived_at'),

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

// User-configurable daily targets. Single-row table for now (solo app).
export const settings = pgTable('settings', {
	id: integer('id').primaryKey().default(1),
	calorieTarget: integer('calorie_target').notNull().default(2100),
	proteinTargetG: integer('protein_target_g').notNull().default(180),
	carbsTargetG: integer('carbs_target_g').notNull().default(220),
	fatTargetG: integer('fat_target_g').notNull().default(70),

	// Profile inputs for BMR estimation — Mifflin-St Jeor fallback for when a
	// weigh-in has no body-fat % (Katch-McArdle needs lean mass).
	heightCm: real('height_cm'),
	birthDate: text('birth_date'), // 'YYYY-MM-DD'
	sex: text('sex'), // 'male' | 'female'

	// Body-composition goals — drive the "time to goal" projection. Either, both,
	// or neither may be set.
	goalWeightKg: real('goal_weight_kg'),
	goalBodyFatPct: real('goal_body_fat_pct'), // 0–100

	// Bolusable (net glycemic) carb derivation. CLINICAL CALIBRATION — review with a
	// care team and validate against CGM traces; this is not medical fact. 'full' =
	// subtract all fiber (David's standing rule); 'half_over_5' = subtract half of
	// fiber, only when > 5g (ADA-style). Changing it recomputes the whole history,
	// because bolusable carbs are derived live, never stored.
	fiberMode: text('fiber_mode').notNull().default('full'), // 'full' | 'half_over_5'

	// Free-text notes surfaced to the scheduled Claude review (supplements, current
	// questions, context) so it sees them without a heavier feature. Included in the
	// export_data payload; editable on /settings.
	notes: text('notes')
});

// Analysis reports written back by the scheduled Claude review (via the save_report
// MCP tool) and read in-app at /reports. Content is markdown, rendered + sanitized
// server-side. `rangeFrom`/`rangeTo` record the date window the analysis covered;
// `period` is the optional label ('day'|'week'|'month'); `tag` is an optional theme.
export const reports = pgTable(
	'reports',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		createdAt: timestamp('created_at').notNull().defaultNow(),
		title: text('title').notNull(),
		content: text('content').notNull(), // markdown
		period: text('period'), // 'day' | 'week' | 'month' | null
		rangeFrom: text('range_from'), // 'YYYY-MM-DD' covered (inclusive), nullable
		rangeTo: text('range_to'),
		tag: text('tag') // optional theme, e.g. 'sleep'
	},
	(t) => [index('reports_created_at_idx').on(t.createdAt)]
);

// ── HealthKit sync (pushed by the iOS wrapper app) ──────────────────────────

// One row per weigh-in. Sourced from HealthKit (smart scale → Fit Days → Apple
// Health → iOS app). `hkUuid` is the HealthKit sample UUID — the upsert key, so
// re-syncs are idempotent. Body fat / lean mass are nullable: a manual weight
// entry in Apple Health has no composition data.
export const bodyComp = pgTable(
	'body_comp',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		hkUuid: text('hk_uuid').notNull().unique(),
		measuredAt: timestamp('measured_at').notNull(),
		weightKg: real('weight_kg').notNull(),
		bodyFatPct: real('body_fat_pct'), // 0–100, not 0–1
		leanMassKg: real('lean_mass_kg'),
		source: text('source'), // HK source bundle id (e.g. the Fit Days app)
		createdAt: timestamp('created_at').notNull().defaultNow()
	},
	(t) => [index('body_comp_measured_at_idx').on(t.measuredAt)]
);

// One row per local calendar day of activity, aggregated on-device by the iOS
// app (HKStatisticsCollectionQuery already dedupes overlapping Watch/iPhone
// samples). The current day gets re-pushed with growing totals — upsert by date.
export const activityDays = pgTable('activity_days', {
	date: text('date').primaryKey(), // 'YYYY-MM-DD' in the device's local time
	activeKcal: real('active_kcal'),
	basalKcal: real('basal_kcal'), // Apple's basal estimate — kept to compare against our BMR
	steps: integer('steps'),
	exerciseMin: integer('exercise_min'),
	updatedAt: timestamp('updated_at').notNull().defaultNow()
});

// One row per HKWorkout session, pushed by the iOS app (anchored query — only
// new/edited workouts arrive). `hkUuid` is the upsert key, so a re-sync or an
// edit in Apple Health (same UUID) is idempotent. avg/max HR are from the
// workout's heart-rate samples; null when none were recorded.
export const workouts = pgTable(
	'workouts',
	{
		hkUuid: text('hk_uuid').primaryKey(),
		name: text('name').notNull(), // activity type, e.g. 'Strength Training'
		startedAt: timestamp('started_at').notNull(),
		endedAt: timestamp('ended_at'),
		kcal: real('kcal'), // total energy burned, if recorded
		avgHr: real('avg_hr'),
		maxHr: real('max_hr'),
		createdAt: timestamp('created_at').notNull().defaultNow()
	},
	(t) => [index('workouts_started_at_idx').on(t.startedAt)]
);

// Daily vitals from HealthKit — water, resting/avg/min/max HR, HRV, SpO2,
// respiratory rate, VO2max, BMI. One value per (date, metric), recomputed and
// re-pushed for a trailing window each sync (same upsert-by-day idea as
// activity_days). The metric name is free-form so the iOS app can ship a new
// metric without a server release.
export const dailyMetrics = pgTable(
	'daily_metrics',
	{
		date: text('date').notNull(), // 'YYYY-MM-DD' in device-local time
		metric: text('metric').notNull(), // e.g. 'water_l', 'resting_hr', 'hrv_ms'
		value: real('value').notNull(),
		updatedAt: timestamp('updated_at').notNull().defaultNow()
	},
	(t) => [primaryKey({ columns: [t.date, t.metric] })]
);

// One row per night's sleep-stage timeline (Fitbit via Google Health), kept so the
// /sleep hypnogram can draw the night. The aggregate minutes live in daily_metrics;
// this is the per-segment detail. Keyed by local wake date; the main (longest)
// session of the night wins. `segments` offsets are minutes from `startAt`.
export const sleepStages = pgTable('sleep_stages', {
	date: text('date').primaryKey(), // 'YYYY-MM-DD' in APP_TZ (wake date)
	startAt: timestamp('start_at').notNull(),
	endAt: timestamp('end_at').notNull(),
	segments: jsonb('segments')
		.$type<{ stage: string; startMin: number; durationMin: number }[]>()
		.notNull(),
	updatedAt: timestamp('updated_at').notNull().defaultNow()
});

// ── Fitbit (Google) OAuth — server-side nightly sync ────────────────────────
// Single-row store for the Fitbit refresh token. Fitbit ROTATES the refresh token
// on every refresh, so it must be persisted writably (env won't do). Never
// returned to any client — the owner authorizes once via
// /api/integrations/fitbit/authorize, and the daily sync refreshes from here.
export const fitbitAuth = pgTable('fitbit_auth', {
	id: integer('id').primaryKey().default(1),
	refreshToken: text('refresh_token').notNull(),
	scope: text('scope'),
	updatedAt: timestamp('updated_at').notNull().defaultNow()
});

// ── OAuth 2.1 (for the MCP connector Claude.ai adds) ────────────────────────
// We are our own authorization server. Claude.ai registers dynamically, runs
// auth-code + PKCE against /authorize + /token, and presents the resulting
// access token as a Bearer to /mcp.

// Dynamically-registered OAuth clients (RFC 7591). Claude.ai self-registers.
export const oauthClients = pgTable('oauth_clients', {
	clientId: text('client_id').primaryKey(),
	clientName: text('client_name'),
	redirectUris: jsonb('redirect_uris').$type<string[]>().notNull(),
	createdAt: timestamp('created_at').notNull().defaultNow()
});

// Short-lived single-use authorization codes. Bound to a PKCE challenge.
// Stored hashed; `code` column holds sha256(code).
export const oauthCodes = pgTable(
	'oauth_codes',
	{
		code: text('code').primaryKey(), // sha256 of the issued code
		clientId: text('client_id')
			.notNull()
			.references(() => oauthClients.clientId, { onDelete: 'cascade' }),
		redirectUri: text('redirect_uri').notNull(),
		codeChallenge: text('code_challenge').notNull(),
		codeChallengeMethod: text('code_challenge_method').notNull().default('S256'),
		scope: text('scope'),
		resource: text('resource'),
		expiresAt: timestamp('expires_at').notNull(),
		consumed: boolean('consumed').notNull().default(false),
		createdAt: timestamp('created_at').notNull().defaultNow()
	},
	(t) => [index('oauth_codes_expires_idx').on(t.expiresAt)]
);

// Issued access + refresh tokens. Both stored hashed; lookups hash the
// presented token. Access tokens are short-lived; refresh tokens rotate.
export const oauthTokens = pgTable(
	'oauth_tokens',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		accessTokenHash: text('access_token_hash').notNull().unique(),
		refreshTokenHash: text('refresh_token_hash').unique(),
		clientId: text('client_id')
			.notNull()
			.references(() => oauthClients.clientId, { onDelete: 'cascade' }),
		scope: text('scope'),
		resource: text('resource'),
		accessExpiresAt: timestamp('access_expires_at').notNull(),
		revoked: boolean('revoked').notNull().default(false),
		createdAt: timestamp('created_at').notNull().defaultNow()
	},
	(t) => [
		index('oauth_tokens_access_idx').on(t.accessTokenHash),
		index('oauth_tokens_refresh_idx').on(t.refreshTokenHash)
	]
);
