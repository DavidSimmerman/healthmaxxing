// MCP server for the health dashboard. The write tools (log_food, prep_food)
// let Claude.ai resolve and log foods; the read tools (get_energy_ledger,
// get_body_trends, get_nutrition) let Claude review the user's nutrition & health
// data and suggest improvements. More signals (blood sugar, insulin, sleep) will
// be added later, so tools should degrade gracefully when a metric has no data.
import { json } from '@sveltejs/kit';
import { validateAccessToken } from '$lib/server/oauth';
import { keycloakEnabled, validateMcpToken } from '$lib/server/keycloak';
import {
	createAndLogFood,
	prepFood,
	searchFoods,
	lookupBarcodeMacros,
	patchFoodNutrients,
	correctLogEntry,
	FoodInputError,
	type CreateAndLogInput,
	type LogEntryPatch,
	type PrepFoodInput
} from '$lib/server/foods';
import { deficitDays } from '$lib/server/deficit';
import { fillBmrGaps, bodyInsights } from '$lib/server/projections';
import { todayLabel } from '$lib/server/day';
import { addDays } from '$lib/energy';
import { nutritionReport, logEntries } from '$lib/server/nutrition';
import { sanitizeNutrients } from '$lib/nutrients';
import { searchFdc, lookupFdcByUpc } from '$lib/server/fdc';
import { bolusableCarbsPerServing, bolusableForLoggedEntry } from '$lib/netCarbs';
import { getFiberMode } from '$lib/server/prefs';

const PROTOCOL_VERSION = '2025-03-26';

// ── JSON-RPC helpers ──────────────────────────────────────────────────────────
type Id = string | number | null;

function rpcResult(id: Id, result: unknown) {
	return json({ jsonrpc: '2.0', id, result });
}
function rpcError(id: Id, code: number, message: string) {
	return json({ jsonrpc: '2.0', id, error: { code, message } });
}
function toolResult(id: Id, text: string, isError = false) {
	return rpcResult(id, { content: [{ type: 'text', text }], isError });
}

// ── Tools ───────────────────────────────────────────────────────────────────
const NUTRIENT_KEYS =
	'fiberG, sugarG, addedSugarG, sugarAlcoholG, satFatG, transFatG, monoFatG, polyFatG, ' +
	'omega3G, omega6G, cholesterolMg, sodiumMg, potassiumMg, calciumMg, ironMg, magnesiumMg, ' +
	'zincMg, phosphorusMg, vitAUg, vitCMg, vitDUg, vitEMg, vitKUg, vitB6Mg, vitB12Ug, folateUg, ' +
	'caffeineMg, alcoholG';

const LOG_FOOD_TOOL = {
	name: 'log_food',
	description:
		'Create or update a food in the health dashboard and optionally log it to today. ' +
		'Resolve macros per serving from a photo, description, or barcode before calling. ' +
		'Set logToday=true to add it to today (default true unless the user only wants to catalog it). ' +
		'Only include nutrient fields you are confident about; omit unknowns. ' +
		'IMPORTANT: if you are unsure of an ingredient’s or food’s macros — a packaged item ' +
		'whose barcode lookup failed, or anything you would otherwise have to estimate — ASK ' +
		'the user to send a photo of the nutrition label before logging, rather than guessing. ' +
		'Only fall back to an estimate (source="estimate", note the assumptions in resolverNote) ' +
		'if the user says they can’t provide a label. ' +
		'BEFORE submitting, double-check your work: verify the macros roughly satisfy the ' +
		'Atwater check (proteinG×4 + carbsG×4 + fatG×9 should be within ~10% of calories), that ' +
		'values are per the intended serving (not accidentally per-100g or per-package), and that ' +
		'recipe totals equal the sum of the scaled ingredients. Call out to the user — in your ' +
		'reply, not silently — anything that seems off or low-confidence (Atwater mismatch, an ' +
		'implausible value, a guessed serving size, a barcode whose data looked stale or wrong) ' +
		'so they can give it a second look, and record the caveat in resolverNote.',
	inputSchema: {
		type: 'object',
		properties: {
			name: {
				type: 'string',
				description: 'Food name, e.g. "Chobani Greek Yogurt - Plain Nonfat"'
			},
			brand: { type: 'string' },
			barcode: { type: 'string', description: 'UPC/EAN if known; upserts on barcode' },
			servingSize: { type: 'string', description: 'e.g. "1 container (170g)"' },
			servingGrams: { type: 'number' },
			calories: { type: 'number', description: 'Per serving, kcal' },
			proteinG: { type: 'number', description: 'Per serving' },
			carbsG: { type: 'number', description: 'Per serving' },
			fatG: { type: 'number', description: 'Per serving' },
			nutrients: {
				type: 'object',
				description: `Optional extended nutrients per serving. Allowed keys: ${NUTRIENT_KEYS}. Unknown keys are ignored.`
			},
			source: {
				type: 'string',
				enum: ['claude_code', 'label_ocr', 'estimate'],
				description: 'Provenance of the macros'
			},
			resolverNote: {
				type: 'string',
				description: 'Confidence / assumptions, e.g. "plate estimate, ±25%"'
			},
			logToday: { type: 'boolean', description: 'Add to the log (default true)' },
			date: {
				type: 'string',
				description:
					'YYYY-MM-DD to log a MISSED food to a past day instead of today. Omit for today.'
			},
			servings: { type: 'number', description: 'Servings actually eaten (default 1)' },
			amount: {
				type: 'number',
				description:
					'Amount eaten in `unit` (e.g. 188 with unit="gram"). Overrides servings; needs servingGrams for non-serving units.'
			},
			unit: {
				type: 'string',
				enum: ['serving', 'gram', 'cup', 'tbsp', 'tsp'],
				description: 'Unit for `amount` (default serving)'
			},
			pinToQuickAdds: { type: 'boolean' }
		},
		required: ['name', 'calories']
	}
};

const PREP_FOOD_TOOL = {
	name: 'prep_food',
	description:
		'Create or UPDATE a food/recipe in the catalog WITHOUT logging it to today — for meal prep. ' +
		'The food becomes searchable in the app so the user can log it later when they actually eat it. ' +
		'This never touches today’s macros. ' +
		'TO UPDATE an existing recipe (e.g. the user swapped an ingredient or changed a portion), FIRST ' +
		'call list_foods to find it, then call prep_food with its `id` and the full updated `ingredients` ' +
		'array — keeping the id avoids creating a duplicate. You only need to change the one ingredient ' +
		'that differs; resend the rest as-is from list_foods. ' +
		'For a recipe, pass `ingredients` (each ingredient’s macros are its contribution to the WHOLE ' +
		'recipe, not per serving), `makesServings` (how many servings the batch yields), and `totalGrams` ' +
		'(cooked batch weight, so the user can later log it by grams). Per-serving macros are computed ' +
		'automatically as sum(ingredients) / makesServings. For a simple (non-recipe) food, omit ' +
		'ingredients and pass per-serving calories/macros directly. ' +
		'Resolve each ingredient’s macros from a photo, description, or barcode (use lookup_barcode) ' +
		'before calling; if unsure of a packaged item, ask the user for a nutrition-label photo rather ' +
		'than guessing. Double-check the Atwater balance (protein×4 + carbs×4 + fat×9 ≈ calories within ' +
		'~10%) on the per-serving totals, and call out anything low-confidence in your reply + resolverNote.',
	inputSchema: {
		type: 'object',
		properties: {
			id: {
				type: 'string',
				description: 'Existing food id to UPDATE (from list_foods). Omit to create a new food.'
			},
			name: { type: 'string', description: 'Food/recipe name, e.g. "Chicken & Rice Bowl"' },
			brand: { type: 'string' },
			barcode: {
				type: 'string',
				description: 'UPC/EAN if a packaged item; matches/updates on barcode'
			},
			servingSize: { type: 'string', description: 'e.g. "1 bowl" or "1 container (170g)"' },
			servingGrams: {
				type: 'number',
				description:
					'Grams per serving (for non-recipes). Recipes derive this from totalGrams/makesServings.'
			},
			calories: {
				type: 'number',
				description: 'Per serving — for a simple food (omit when using ingredients)'
			},
			proteinG: { type: 'number', description: 'Per serving (simple food)' },
			carbsG: { type: 'number', description: 'Per serving (simple food)' },
			fatG: { type: 'number', description: 'Per serving (simple food)' },
			nutrients: {
				type: 'object',
				description: `Optional extended nutrients per serving (simple food). Allowed keys: ${NUTRIENT_KEYS}.`
			},
			ingredients: {
				type: 'array',
				description:
					'Recipe breakdown. Each ingredient’s macros are its contribution to the WHOLE recipe.',
				items: {
					type: 'object',
					properties: {
						name: { type: 'string' },
						amount: {
							type: 'string',
							description: 'Quantity as entered, e.g. "6 oz", "1 cup cooked"'
						},
						barcode: { type: 'string' },
						calories: {
							type: 'number',
							description: 'This ingredient’s contribution to the whole recipe'
						},
						proteinG: { type: 'number' },
						carbsG: { type: 'number' },
						fatG: { type: 'number' },
						nutrients: { type: 'object', description: `Allowed keys: ${NUTRIENT_KEYS}` }
					},
					required: ['name', 'calories']
				}
			},
			makesServings: {
				type: 'number',
				description: 'How many servings the recipe yields (default 1)'
			},
			totalGrams: {
				type: 'number',
				description: 'Cooked batch weight in grams (enables logging by grams)'
			},
			source: { type: 'string', enum: ['claude_code', 'label_ocr', 'estimate'] },
			resolverNote: { type: 'string', description: 'Confidence / assumptions to record' },
			pinToQuickAdds: {
				type: 'boolean',
				description: 'Also pin as a one-tap tile on the today view'
			}
		},
		required: ['name']
	}
};

const LIST_FOODS_TOOL = {
	name: 'list_foods',
	description:
		'Search the food catalog (read-only). Use this to find an existing food/recipe before updating ' +
		'it with prep_food — match on name, grab its `id`, and reuse its `ingredients`. Returns per-serving ' +
		'macros plus, for recipes, the ingredient breakdown, makesServings and totalGrams. Archived ' +
		'(deleted-from-search) foods are excluded. Omit `query` to list the most recently updated foods.',
	inputSchema: {
		type: 'object',
		properties: {
			query: { type: 'string', description: 'Substring to match against food names' },
			limit: { type: 'number', description: 'Max results (default 25, max 100)' }
		}
	}
};

const LOOKUP_BARCODE_TOOL = {
	name: 'lookup_barcode',
	description:
		'Look up precise nutrition for one or more product barcodes (UPC/EAN) from the personal ' +
		'cache and Open Food Facts. Read-only — nothing is logged. Returns macros on BOTH bases: ' +
		'per100g (use this to scale an ingredient to the grams actually used in a recipe) and ' +
		'perServing. To build a recipe: pass every ingredient barcode at once, multiply each ' +
		'food’s per100g macros by (grams used / 100), sum across ingredients, then log the result ' +
		'with log_food. If a barcode comes back found:false (or the data looks wrong/incomplete), ' +
		'treat it as unknown: ask the user to send a photo of the product’s nutrition label and read ' +
		'the macros from that. Never invent or estimate macros for an ingredient you couldn’t resolve.',
	inputSchema: {
		type: 'object',
		properties: {
			barcodes: {
				type: 'array',
				items: { type: 'string' },
				description: 'One or more UPC/EAN barcodes to resolve'
			}
		},
		required: ['barcodes']
	}
};

const LOOKUP_FDC_TOOL = {
	name: 'lookup_fdc',
	description:
		'Read-only. Look up ground-truth nutrition from USDA FoodData Central (FDC) to fill in ' +
		'vitamins/minerals Open Food Facts is missing — especially for whole-food ingredients and ' +
		'recipes. Returns PER-100g panels (macros for reference + extended `nutrients` in this ' +
		'dashboard’s keys) for the top matches. TO BUILD A RECIPE’S MICRONUTRIENT PANEL: for each ' +
		'ingredient, look it up here, multiply the per-100g `nutrients` by (grams used / 100), set that ' +
		'as the ingredient’s `nutrients`, then call prep_food — it sums the ingredients and divides by ' +
		'makesServings automatically. Prefer Foundation / SR Legacy matches (clean per-100g reference ' +
		'data) for whole foods; for a packaged product pass its `upc` for an exact Branded match. ' +
		'IMPORTANT: FDC search is FUZZY — "chicken breast" can return a deli roll — so read each ' +
		'match’s description/dataType and pick the closest real equivalent; record any substitution in ' +
		'the recipe’s resolverNote. Do NOT use this to change macros (calories/protein/carbs/fat) — ' +
		'those are source of truth; only ADD micronutrients. Values are per 100g; nutrients FDC reports ' +
		'only in IU are omitted rather than guessed.',
	inputSchema: {
		type: 'object',
		properties: {
			query: { type: 'string', description: 'Food/ingredient name, e.g. "white rice, cooked"' },
			upc: { type: 'string', description: 'UPC/EAN for an exact Branded match (instead of query)' },
			dataType: {
				type: 'array',
				items: { type: 'string', enum: ['Foundation', 'SR Legacy', 'Branded', 'Survey (FNDDS)'] },
				description: 'Restrict datasets (default Foundation + SR Legacy — the richest micro panels)'
			},
			pageSize: { type: 'number', description: 'Max matches to return (default 5, max 25)' }
		}
	}
};

async function callLookupFdc(id: Id, args: Record<string, unknown>) {
	const query = typeof args.query === 'string' ? args.query.trim() : '';
	const upc = typeof args.upc === 'string' ? args.upc.trim() : '';
	if (!query && !upc) return toolResult(id, 'Provide a `query` or a `upc`.', true);
	try {
		if (upc) {
			const match = await lookupFdcByUpc(upc);
			return toolResult(
				id,
				match
					? `FDC exact UPC match for ${upc} (per 100g).\n${JSON.stringify({ matches: [match] }, null, 2)}`
					: `No FDC Branded entry for UPC ${upc}. Try a name \`query\`, or trust the Open Food Facts / label values.`
			);
		}
		const dataType = Array.isArray(args.dataType)
			? args.dataType.filter((d): d is string => typeof d === 'string')
			: undefined;
		const pageSize = typeof args.pageSize === 'number' ? args.pageSize : undefined;
		const matches = await searchFdc(query, { dataType, pageSize });
		const summary = matches.length
			? `FDC: ${matches.length} match${matches.length === 1 ? '' : 'es'} for "${query}" (per 100g). Pick the closest whole-food equivalent.`
			: `FDC: no matches for "${query}". Try a simpler/generic name (e.g. "rice, white, cooked").`;
		return toolResult(id, `${summary}\n${JSON.stringify({ matches }, null, 2)}`);
	} catch (e) {
		console.error('lookup_fdc failed:', e);
		const msg = e instanceof Error && e.message.startsWith('FDC ') ? ` (${e.message})` : '';
		return toolResult(
			id,
			`Could not reach USDA FDC${msg}. It may be rate-limited (set FDC_API_KEY) — retry shortly.`,
			true
		);
	}
}

async function callLookupBarcode(id: Id, args: Record<string, unknown>) {
	const raw = args.barcodes;
	const codes = (Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [])
		.map((c) => String(c).trim())
		.filter(Boolean);
	if (codes.length === 0) {
		return toolResult(id, 'Provide at least one barcode in `barcodes`.', true);
	}
	if (codes.length > 50) {
		return toolResult(id, 'Too many barcodes in one call (max 50).', true);
	}
	try {
		// De-dupe so a recipe listing the same ingredient twice hits OFF once.
		const unique = [...new Set(codes)];
		const results = await Promise.all(unique.map((c) => lookupBarcodeMacros(c)));
		const found = results.filter((r) => r.found).length;
		const summary = `Resolved ${found}/${results.length} barcode${
			results.length === 1 ? '' : 's'
		}.`;
		return toolResult(id, `${summary}\n${JSON.stringify({ results }, null, 2)}`);
	} catch (e) {
		console.error('lookup_barcode failed:', e);
		return toolResult(id, 'Could not look up barcodes: an internal error occurred.', true);
	}
}

async function callLogFood(id: Id, args: Record<string, unknown>) {
	try {
		// MCP tools default to logging unless the caller explicitly opts out.
		const logToday = args.logToday === undefined ? true : !!args.logToday;
		// Shape validated at runtime inside createAndLogFood (throws FoodInputError).
		const input = { ...args, logToday } as unknown as CreateAndLogInput;
		const { food, logEntry } = await createAndLogFood(input);
		const servings = logEntry?.servings ?? 1;
		const fiberMode = await getFiberMode();
		// Reflect the actual day written — "today" or the backfilled date — so a
		// correction workflow can confirm the entry landed where intended.
		const day = logEntry ? todayLabel(logEntry.loggedAt) : todayLabel();
		const dayLabel = day === todayLabel() ? 'today' : day;
		const entryBolus = logEntry
			? bolusableForLoggedEntry(logEntry.carbsG, food, servings, { fiberMode })
			: null;
		const perServingBolus = bolusableCarbsPerServing(food, { fiberMode });
		const carbsBit = (total: number, bolus: number, lowConf: boolean) =>
			`${round1(total)}g carbs (${round1(bolus)}g bolusable${lowConf ? ', fiber unknown — verify from label' : ''})`;
		const lines = [
			`Saved "${food.name}"${food.brand ? ` (${food.brand})` : ''}.`,
			logEntry
				? `Logged to ${dayLabel}${servings !== 1 ? ` ×${servings}` : ''}: ${Math.round(
						logEntry.calories
					)} kcal, ${round1(logEntry.proteinG)}g protein, ${carbsBit(
						logEntry.carbsG,
						entryBolus!.bolusableCarbsG,
						entryBolus!.lowConfidence
					)}, ${round1(logEntry.fatG)}g fat.`
				: `Cataloged only (not added to today): ${Math.round(food.calories)} kcal, ${round1(
						food.proteinG
					)}g protein, ${carbsBit(
						food.carbsG,
						perServingBolus.bolusableCarbsG,
						perServingBolus.lowConfidence
					)} per serving.`
		];
		return toolResult(id, lines.join(' '));
	} catch (e) {
		if (e instanceof FoodInputError) return toolResult(id, `Could not log: ${e.message}`, true);
		console.error('log_food failed:', e);
		return toolResult(id, 'Could not log: an internal error occurred.', true);
	}
}

function round1(n: number): number {
	return Math.round(n * 10) / 10;
}

async function callPrepFood(id: Id, args: Record<string, unknown>) {
	try {
		const input = { ...args } as unknown as PrepFoodInput;
		const food = await prepFood(input);
		const isRecipe = Array.isArray(food.ingredients) && food.ingredients.length > 0;
		const verb = args.id ? 'Updated' : 'Saved';
		const bolus = bolusableCarbsPerServing(food, { fiberMode: await getFiberMode() });
		const recipeBit = isRecipe
			? ` Recipe of ${food.ingredients!.length} ingredient${
					food.ingredients!.length === 1 ? '' : 's'
				}, makes ${round1(food.makesServings ?? 1)} serving${food.makesServings === 1 ? '' : 's'}${
					food.totalGrams ? `, ${Math.round(food.totalGrams)}g batch` : ''
				}.`
			: '';
		return toolResult(
			id,
			`${verb} "${food.name}"${food.brand ? ` (${food.brand})` : ''} — not logged to today.${recipeBit} ` +
				`Per serving: ${Math.round(food.calories)} kcal, ${round1(food.proteinG)}g protein, ${round1(
					food.carbsG
				)}g carbs (${round1(bolus.bolusableCarbsG)}g bolusable${
					bolus.lowConfidence ? ', fiber unknown — verify from label' : ''
				}), ${round1(food.fatG)}g fat. It’s now searchable in the app to log when eaten.`
		);
	} catch (e) {
		if (e instanceof FoodInputError) return toolResult(id, `Could not prep: ${e.message}`, true);
		console.error('prep_food failed:', e);
		return toolResult(id, 'Could not prep: an internal error occurred.', true);
	}
}

async function callListFoods(id: Id, args: Record<string, unknown>) {
	try {
		const query = typeof args.query === 'string' ? args.query : undefined;
		const limit = typeof args.limit === 'number' ? args.limit : undefined;
		const results = await searchFoods(query, limit);
		const summary = `Found ${results.length} food${results.length === 1 ? '' : 's'}${
			query ? ` matching "${query}"` : ''
		}.`;
		return toolResult(id, `${summary}\n${JSON.stringify({ results }, null, 2)}`);
	} catch (e) {
		console.error('list_foods failed:', e);
		return toolResult(id, 'Could not list foods: an internal error occurred.', true);
	}
}

// ── Read-only review tools ────────────────────────────────────────────────────
// These let Claude.ai review the user's nutrition & health data and suggest
// improvements. They never modify data. More signals (blood sugar, insulin,
// sleep) will be added later, so each tool degrades gracefully when a metric has
// no data rather than erroring.

const GET_ENERGY_LEDGER_TOOL = {
	name: 'get_energy_ledger',
	description:
		'Read-only. The daily calorie-in/out ledger over a date range: for each day, ' +
		'intake (kcal + protein), resting burn (BMR), active burn, digestion burn (TEF), ' +
		'total burned, and the resulting deficit (positive = burned more than eaten), plus ' +
		'the latest weigh-in carried forward. Use this to assess whether the user’s calorie ' +
		'deficit is healthy and sustainable (e.g. not too aggressive, adequate intake). ' +
		'Days with no expenditure estimate have null burn/deficit; protein/intake may be 0 on ' +
		'unlogged days. Default range is the last 14 days ending today.',
	inputSchema: {
		type: 'object',
		properties: {
			from: { type: 'string', description: 'Start date YYYY-MM-DD (inclusive)' },
			to: { type: 'string', description: 'End date YYYY-MM-DD (inclusive, default today)' },
			days: {
				type: 'number',
				description:
					'Number of trailing days ending at `to` (default 14, max 370). Ignored if `from` is given.'
			}
		}
	}
};

const GET_BODY_TRENDS_TOOL = {
	name: 'get_body_trends',
	description:
		'Read-only. Weight, body-fat %, and lean/muscle mass trends with future projections ' +
		'(+1/2/3 months) and time-to-goal estimates. Use this to judge the rate of weight loss, ' +
		'whether muscle is being retained, and whether goals are feasible at the current pace. ' +
		'`leanMass` is HealthKit lean body mass — the best available proxy for muscle mass. ' +
		'ratePerWeek negative = decreasing. Trends/projections are null when there aren’t enough ' +
		'weigh-ins to fit a line; degrades gracefully when composition data is sparse.',
	inputSchema: {
		type: 'object',
		properties: {
			windowDays: {
				type: 'number',
				description: 'Trailing window of weigh-ins to fit the trend over (default 90)'
			},
			targetDate: {
				type: 'string',
				description: 'Optional extra future date YYYY-MM-DD to project to'
			}
		}
	}
};

const GET_NUTRITION_TOOL = {
	name: 'get_nutrition',
	description:
		'Read-only. Total and daily-average intake over a date range: calories, macros, water, ' +
		'and ALL extended nutrients that were logged — fiber, sugar, sodium, potassium, calcium, ' +
		'iron, magnesium, zinc, vitamins A/C/D/E/K/B6/B12, folate, omega-3/6, saturated/trans fat, ' +
		'cholesterol, caffeine, and more. Use this to flag nutrient deficiencies or excesses, an ' +
		'over-restrictive diet, or imbalanced macros, and to recommend improvements. Daily averages ' +
		'are per logged day. Extended nutrients are only as complete as what has been logged per ' +
		'food, so a missing nutrient may just mean it wasn’t recorded. The `coverage` map gives, per ' +
		'nutrient, the share (0–1) of logged calories whose food actually recorded it: LOW coverage ' +
		'means treat that total as UNKNOWN, not as a real deficiency. To fix sparse data, use ' +
		'get_day_log to find the foods missing a nutrient, then correct_food_nutrients to fill it in. ' +
		'Default range is the last 7 days.',
	inputSchema: {
		type: 'object',
		properties: {
			from: { type: 'string', description: 'Start date YYYY-MM-DD (inclusive)' },
			to: { type: 'string', description: 'End date YYYY-MM-DD (inclusive, default today)' },
			days: {
				type: 'number',
				description:
					'Number of trailing days ending at `to` (default 7). Ignored if `from` is given.'
			}
		}
	}
};

const GET_DAY_LOG_TOOL = {
	name: 'get_day_log',
	description:
		'Read-only. The individual food entries logged over a date range — the worklist for ' +
		'reviewing and back-correcting a day. Each entry returns its date, logId, foodId, name, brand, ' +
		'servings, its logged macros (calories/proteinG/carbsG/fatG), and the food’s CURRENT per-serving ' +
		'`nutrients` (vitamins, minerals, etc.). Two kinds of fix: (1) wrong/missing VITAMINS or other ' +
		'extended nutrients → correct_food_nutrients(foodId); these are read live, so one fix applies to ' +
		'every day the food was eaten. (2) a wrong MACRO or portion on one day → correct_log_entry(logId); ' +
		'macros are snapshotted per entry, so this changes only that day. To add a food you MISSED on a ' +
		'past day, use log_food with its `date`. The same food eaten on several days appears once per day. ' +
		'Default range is the last 7 days ending today.',
	inputSchema: {
		type: 'object',
		properties: {
			from: { type: 'string', description: 'Start date YYYY-MM-DD (inclusive)' },
			to: { type: 'string', description: 'End date YYYY-MM-DD (inclusive, default today)' },
			days: {
				type: 'number',
				description:
					'Number of trailing days ending at `to` (default 7, max 370). Ignored if `from` is given.'
			}
		}
	}
};

const CORRECT_FOOD_NUTRIENTS_TOOL = {
	name: 'correct_food_nutrients',
	description:
		'Back-correct a food’s extended nutrients (per serving) — e.g. fill in vitamins or minerals ' +
		'Open Food Facts didn’t have, or fix a wrong value. Pass the foodId (from get_day_log or ' +
		'list_foods) and ONLY the nutrient keys you’re correcting; they are merged into what’s stored, ' +
		'so existing keys you don’t mention are kept. Because reports read a food’s nutrients live, this ' +
		'RETROACTIVELY fixes every past day the food was eaten — there’s no need to edit each day. Macros ' +
		'(calories/protein/carbs/fat) are not touched. Recipes are rejected (their nutrients come from ' +
		'their ingredients — update those via prep_food). Only set values you’re confident about; resolve ' +
		'from a nutrition label or a reliable source rather than guessing, and tell the user what you ' +
		'changed and where the numbers came from.',
	inputSchema: {
		type: 'object',
		properties: {
			foodId: {
				type: 'string',
				description: 'The food to correct (from get_day_log or list_foods)'
			},
			nutrients: {
				type: 'object',
				description: `Per-serving nutrient values to merge in. Allowed keys: ${NUTRIENT_KEYS}. Unknown/negative values are ignored.`
			}
		},
		required: ['foodId', 'nutrients']
	}
};

const CORRECT_LOG_ENTRY_TOOL = {
	name: 'correct_log_entry',
	description:
		'Back-correct a single past (or today’s) log entry’s MACROS — for a portion that was off or a ' +
		'bad estimate on one day. Pass the logId (from get_day_log). Two ways to fix: pass `servings` ' +
		'alone to recompute calories/protein/carbs/fat from the food’s current per-serving values (e.g. ' +
		'the user actually ate 2 servings, not 1); or pass any of calories/proteinG/carbsG/fatG to ' +
		'override those directly (only the fields you send change). This edits ONLY this one day — macros ' +
		'are snapshotted per entry. To fix vitamins/extended nutrients instead, use correct_food_nutrients; ' +
		'to add a food missed on a past day, use log_food with `date`. Verify the Atwater balance ' +
		'(protein×4 + carbs×4 + fat×9 ≈ calories within ~10%) and tell the user what you changed and why.',
	inputSchema: {
		type: 'object',
		properties: {
			logId: { type: 'string', description: 'The log entry to correct (from get_day_log)' },
			servings: {
				type: 'number',
				description:
					'New servings — recomputes all four macros from the food (unless macros are also given)'
			},
			calories: { type: 'number', description: 'Override entry total kcal for this day' },
			proteinG: { type: 'number', description: 'Override entry total protein (g)' },
			carbsG: { type: 'number', description: 'Override entry total carbs (g)' },
			fatG: { type: 'number', description: 'Override entry total fat (g)' }
		},
		required: ['logId']
	}
};

async function callGetEnergyLedger(id: Id, args: Record<string, unknown>) {
	try {
		const to = typeof args.to === 'string' ? args.to : todayLabel();
		let days = typeof args.days === 'number' ? Math.floor(args.days) : 14;
		if (!Number.isFinite(days) || days < 1) days = 14;
		if (days > 370) days = 370;
		const from = typeof args.from === 'string' ? args.from : addDays(to, -(days - 1));

		const ledger = fillBmrGaps(await deficitDays(from, to));
		const counted = ledger.filter((d) => d.deficitKcal != null && d.intakeKcal > 0);
		const n = counted.length;
		const avg = (sum: number) => (n ? Math.round(sum / n) : null);
		const summary = {
			countedDays: n,
			avgDeficitKcal: avg(counted.reduce((a, d) => a + (d.deficitKcal ?? 0), 0)),
			avgIntakeKcal: avg(counted.reduce((a, d) => a + d.intakeKcal, 0)),
			avgProteinG: avg(counted.reduce((a, d) => a + d.proteinG, 0))
		};
		const payload = { from, to, summary, days: ledger };
		const line = n
			? `Energy ledger ${from} → ${to}: ${n} counted day${n === 1 ? '' : 's'}, ` +
				`avg deficit ${summary.avgDeficitKcal} kcal, avg intake ${summary.avgIntakeKcal} kcal, ` +
				`avg protein ${summary.avgProteinG}g.`
			: `Energy ledger ${from} → ${to}: no days with both intake and an expenditure estimate.`;
		return toolResult(id, `${line}\n${JSON.stringify(payload, null, 2)}`);
	} catch (e) {
		console.error('get_energy_ledger failed:', e);
		return toolResult(id, 'Could not load the energy ledger: an internal error occurred.', true);
	}
}

async function callGetBodyTrends(id: Id, args: Record<string, unknown>) {
	try {
		const windowDays = typeof args.windowDays === 'number' ? args.windowDays : undefined;
		const targetDate = typeof args.targetDate === 'string' ? args.targetDate : undefined;
		const insights = await bodyInsights({ windowDays, targetDate });
		const w = insights.weight;
		const lm = insights.leanMass;
		const line =
			insights.series.length === 0
				? `No weigh-ins synced yet — body trends unavailable.`
				: `Body trends as of ${insights.asOf} over ${insights.series.length} weigh-in${
						insights.series.length === 1 ? '' : 's'
					}: ` +
					`weight ${w ? `${round1(w.current)}kg @ ${round1(w.ratePerWeek)}kg/wk` : 'n/a'}, ` +
					`lean mass ${lm ? `${round1(lm.current)}kg @ ${round1(lm.ratePerWeek)}kg/wk` : 'n/a'}.`;
		return toolResult(id, `${line}\n${JSON.stringify(insights, null, 2)}`);
	} catch (e) {
		console.error('get_body_trends failed:', e);
		return toolResult(id, 'Could not load body trends: an internal error occurred.', true);
	}
}

async function callGetNutrition(id: Id, args: Record<string, unknown>) {
	try {
		const to = typeof args.to === 'string' ? args.to : todayLabel();
		let days = typeof args.days === 'number' ? Math.floor(args.days) : 7;
		if (!Number.isFinite(days) || days < 1) days = 7;
		if (days > 370) days = 370;
		const from = typeof args.from === 'string' ? args.from : addDays(to, -(days - 1));

		const report = await nutritionReport(from, to);
		const line =
			report.loggedDays === 0
				? `Nutrition ${from} → ${to}: nothing logged in this range.`
				: `Nutrition ${from} → ${to}: ${report.loggedDays}/${report.calendarDays} day${
						report.calendarDays === 1 ? '' : 's'
					} logged, ` +
					`avg ${report.dailyAvg.calories} kcal, ${report.dailyAvg.proteinG}g protein, ` +
					`${report.dailyAvg.waterL}L water per logged day.`;
		return toolResult(id, `${line}\n${JSON.stringify(report, null, 2)}`);
	} catch (e) {
		console.error('get_nutrition failed:', e);
		return toolResult(id, 'Could not load nutrition: an internal error occurred.', true);
	}
}

async function callGetDayLog(id: Id, args: Record<string, unknown>) {
	try {
		const to = typeof args.to === 'string' ? args.to : todayLabel();
		let days = typeof args.days === 'number' ? Math.floor(args.days) : 7;
		if (!Number.isFinite(days) || days < 1) days = 7;
		if (days > 370) days = 370;
		const from = typeof args.from === 'string' ? args.from : addDays(to, -(days - 1));

		const entries = await logEntries(from, to);
		const line = entries.length
			? `Day log ${from} → ${to}: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}.`
			: `Day log ${from} → ${to}: nothing logged in this range.`;
		return toolResult(id, `${line}\n${JSON.stringify({ from, to, entries }, null, 2)}`);
	} catch (e) {
		console.error('get_day_log failed:', e);
		return toolResult(id, 'Could not load the day log: an internal error occurred.', true);
	}
}

async function callCorrectFoodNutrients(id: Id, args: Record<string, unknown>) {
	const foodId = typeof args.foodId === 'string' ? args.foodId.trim() : '';
	if (!foodId) return toolResult(id, 'Provide the `foodId` of the food to correct.', true);
	const patch = sanitizeNutrients(args.nutrients);
	if (!patch) {
		return toolResult(id, 'Provide at least one valid nutrient value in `nutrients`.', true);
	}
	try {
		const food = await patchFoodNutrients(foodId, patch);
		const changed = Object.keys(patch).join(', ');
		return toolResult(
			id,
			`Corrected ${changed} on "${food.name}"${food.brand ? ` (${food.brand})` : ''}. ` +
				`This applies to every past and future day it was eaten.`
		);
	} catch (e) {
		if (e instanceof FoodInputError) return toolResult(id, `Could not correct: ${e.message}`, true);
		console.error('correct_food_nutrients failed:', e);
		return toolResult(id, 'Could not correct: an internal error occurred.', true);
	}
}

async function callCorrectLogEntry(id: Id, args: Record<string, unknown>) {
	const logId = typeof args.logId === 'string' ? args.logId.trim() : '';
	if (!logId) return toolResult(id, 'Provide the `logId` of the entry to correct.', true);
	// Forward only the fields the caller actually sent; correctLogEntry validates them.
	const patch: LogEntryPatch = {};
	for (const k of ['servings', 'calories', 'proteinG', 'carbsG', 'fatG'] as const) {
		if (typeof args[k] === 'number') patch[k] = args[k] as number;
	}
	if (Object.keys(patch).length === 0) {
		return toolResult(id, 'Provide servings and/or macro fields (numbers) to change.', true);
	}
	try {
		const e = await correctLogEntry(logId, patch);
		return toolResult(
			id,
			`Corrected log entry: ×${round1(e.servings)} serving${e.servings === 1 ? '' : 's'}, ` +
				`${Math.round(e.calories)} kcal, ${round1(e.proteinG)}g protein, ${round1(e.carbsG)}g carbs, ` +
				`${round1(e.fatG)}g fat. Only this day’s entry changed.`
		);
	} catch (e) {
		if (e instanceof FoodInputError) return toolResult(id, `Could not correct: ${e.message}`, true);
		console.error('correct_log_entry failed:', e);
		return toolResult(id, 'Could not correct: an internal error occurred.', true);
	}
}

// ── HTTP handlers ─────────────────────────────────────────────────────────────
function unauthorized(origin: string) {
	return new Response(JSON.stringify({ error: 'invalid_token' }), {
		status: 401,
		headers: {
			'Content-Type': 'application/json',
			'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`
		}
	});
}

export async function POST({ request, url }) {
	// Auth: every MCP request must carry a valid access token. An unauthenticated
	// request gets a 401 whose WWW-Authenticate points Claude.ai at our metadata,
	// kicking off the OAuth flow.
	const auth = request.headers.get('authorization') ?? '';
	const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
	// Keycloak mode: validate the realm-issued JWT (signature via JWKS, issuer,
	// and that the audience targets THIS /mcp resource). Legacy mode: look the
	// opaque token up in our own oauthTokens table.
	const tokenOk = keycloakEnabled()
		? !!token && !!(await validateMcpToken(token, `${url.origin}/mcp`))
		: !!token && !!(await validateAccessToken(token));
	if (!tokenOk) {
		return unauthorized(url.origin);
	}

	let msg: { jsonrpc?: string; id?: Id; method?: string; params?: Record<string, unknown> };
	try {
		msg = await request.json();
	} catch {
		return rpcError(null, -32700, 'Parse error');
	}

	const { id, method, params } = msg;

	// Notifications (no id) — e.g. notifications/initialized. Ack with 202.
	if (id === undefined || id === null) {
		return new Response(null, { status: 202 });
	}

	switch (method) {
		case 'initialize': {
			const requested =
				typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
			return rpcResult(id, {
				protocolVersion: requested,
				capabilities: { tools: {} },
				serverInfo: { name: 'healthmaxxing-mcp', version: '1.0.0' }
			});
		}
		case 'tools/list':
			return rpcResult(id, {
				tools: [
					LOG_FOOD_TOOL,
					PREP_FOOD_TOOL,
					LIST_FOODS_TOOL,
					LOOKUP_BARCODE_TOOL,
					LOOKUP_FDC_TOOL,
					GET_ENERGY_LEDGER_TOOL,
					GET_BODY_TRENDS_TOOL,
					GET_NUTRITION_TOOL,
					GET_DAY_LOG_TOOL,
					CORRECT_FOOD_NUTRIENTS_TOOL,
					CORRECT_LOG_ENTRY_TOOL
				]
			});
		case 'tools/call': {
			const name = params?.name;
			const args = (params?.arguments ?? {}) as Record<string, unknown>;
			if (name === 'log_food') return callLogFood(id, args);
			if (name === 'prep_food') return callPrepFood(id, args);
			if (name === 'list_foods') return callListFoods(id, args);
			if (name === 'lookup_barcode') return callLookupBarcode(id, args);
			if (name === 'lookup_fdc') return callLookupFdc(id, args);
			if (name === 'get_energy_ledger') return callGetEnergyLedger(id, args);
			if (name === 'get_body_trends') return callGetBodyTrends(id, args);
			if (name === 'get_nutrition') return callGetNutrition(id, args);
			if (name === 'get_day_log') return callGetDayLog(id, args);
			if (name === 'correct_food_nutrients') return callCorrectFoodNutrients(id, args);
			if (name === 'correct_log_entry') return callCorrectLogEntry(id, args);
			return rpcError(id, -32602, `Unknown tool: ${String(name)}`);
		}
		case 'ping':
			return rpcResult(id, {});
		default:
			return rpcError(id, -32601, `Method not found: ${String(method)}`);
	}
}

// We're a stateless server — no server-initiated SSE stream.
export function GET() {
	return new Response('Method Not Allowed', { status: 405 });
}
