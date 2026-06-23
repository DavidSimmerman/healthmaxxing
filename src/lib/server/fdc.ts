// USDA FoodData Central (FDC) lookup — ground-truth micronutrients for foods/
// ingredients that Open Food Facts is missing. https://fdc.nal.usda.gov/api-guide
// We return per-100g panels in OUR nutrient keys; callers scale by grams used.
// The pure FDC→key mapping lives in fdcMap.ts (unit-tested separately).
import { env } from '$env/dynamic/private';
import type { Nutrients } from '$lib/nutrients';
import { mapFdcNutrients, fdcValue, type FdcNutrientItem } from './fdcMap';

const BASE = 'https://api.nal.usda.gov/fdc/v1';
const key = () => env.FDC_API_KEY || 'DEMO_KEY'; // set FDC_API_KEY in prod; DEMO_KEY is rate-limited

export type FdcMatch = {
	fdcId: number;
	description: string;
	dataType: string;
	brand: string | null;
	gtinUpc: string | null;
	// all per 100g
	macros: {
		calories: number | null;
		proteinG: number | null;
		carbsG: number | null;
		fatG: number | null;
	};
	nutrients: Partial<Nutrients>;
};

type FdcFood = {
	fdcId: number;
	description?: string;
	dataType?: string;
	brandOwner?: string;
	brandName?: string;
	gtinUpc?: string;
	foodNutrients?: FdcNutrientItem[];
};

function toMatch(f: FdcFood): FdcMatch {
	const fn = f.foodNutrients;
	return {
		fdcId: f.fdcId,
		description: f.description ?? '(unnamed)',
		dataType: f.dataType ?? 'Unknown',
		brand: f.brandOwner ?? f.brandName ?? null,
		gtinUpc: f.gtinUpc ?? null,
		macros: {
			calories: fdcValue(fn, '1008'),
			proteinG: fdcValue(fn, '1003'),
			carbsG: fdcValue(fn, '1005'),
			fatG: fdcValue(fn, '1004')
		},
		nutrients: mapFdcNutrients(fn)
	};
}

async function fdcFetch(path: string, timeoutMs = 8000): Promise<unknown> {
	const sep = path.includes('?') ? '&' : '?';
	// Bound the request so a slow/stalled USDA call can't hang a caller (e.g. a
	// barcode scan that should fall back to Open Food Facts). Aborts the fetch, not
	// just rejects late — keeps FDC genuinely best-effort.
	const res = await fetch(`${BASE}${path}${sep}api_key=${encodeURIComponent(key())}`, {
		headers: { Accept: 'application/json' },
		signal: AbortSignal.timeout(timeoutMs)
	});
	if (!res.ok) throw new Error(`FDC ${res.status}`);
	return res.json();
}

// Search FDC by free text. Prefers clean reference data (Foundation, SR Legacy) over
// Branded by default — those carry the fullest micronutrient panels.
export async function searchFdc(
	query: string,
	opts: { dataType?: string[]; pageSize?: number; timeoutMs?: number } = {}
): Promise<FdcMatch[]> {
	const dataType = (opts.dataType ?? ['Foundation', 'SR Legacy']).join(',');
	const pageSize = Math.min(Math.max(opts.pageSize ?? 5, 1), 25);
	const body = (await fdcFetch(
		`/foods/search?query=${encodeURIComponent(query)}&dataType=${encodeURIComponent(dataType)}&pageSize=${pageSize}`,
		opts.timeoutMs
	)) as { foods?: FdcFood[] };
	return (body.foods ?? []).map(toMatch);
}

// Exact match by UPC/GTIN (Branded dataset). Safe to use automatically — no fuzzy
// matching, it's the same product. Returns null if FDC has no entry for the code.
// `timeoutMs` lets latency-sensitive callers (a barcode scan) keep it snappy.
export async function lookupFdcByUpc(upc: string, timeoutMs?: number): Promise<FdcMatch | null> {
	const digits = upc.replace(/\D/g, '');
	if (!digits) return null;
	const body = (await fdcFetch(
		`/foods/search?query=${encodeURIComponent(digits)}&dataType=Branded&pageSize=5`,
		timeoutMs
	)) as { foods?: FdcFood[] };
	// Require an exact GTIN match (FDC pads to 14 digits); never accept a fuzzy hit.
	const want = digits.padStart(14, '0');
	const hit = (body.foods ?? []).find(
		(f) => (f.gtinUpc ?? '').replace(/\D/g, '').padStart(14, '0') === want
	);
	return hit ? toMatch(hit) : null;
}
