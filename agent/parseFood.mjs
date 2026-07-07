// Parse Claude's describe/scan output (a JSON string, maybe fenced) into a
// validated food object shaped for the app's POST /api/foods body.
// Pure + no deps so it can be unit-checked without the SDK. See parseFood.check.mjs.

const SOURCES = new Set(['label_ocr', 'estimate']);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function stripFences(s) {
	const t = String(s).trim();
	const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
	return (m ? m[1] : t).trim();
}

export function parseFood(text) {
	let obj;
	try {
		obj = JSON.parse(stripFences(text));
	} catch {
		throw new Error(`model did not return JSON: ${String(text).slice(0, 200)}`);
	}
	if (!obj || typeof obj !== 'object') throw new Error('model returned non-object');

	const name = typeof obj.name === 'string' ? obj.name.trim() : '';
	if (!name) throw new Error('missing food name');

	// The four macros are required — reject if any is absent/non-numeric/negative so
	// we never log a food with silently-zeroed or nonsense nutrition.
	const macros = {
		calories: num(obj.calories),
		proteinG: num(obj.proteinG),
		carbsG: num(obj.carbsG),
		fatG: num(obj.fatG)
	};
	for (const [k, v] of Object.entries(macros)) {
		if (v === null) throw new Error(`missing or non-numeric ${k}`);
		if (v < 0) throw new Error(`${k} is negative`);
	}

	return {
		name,
		brand: typeof obj.brand === 'string' ? obj.brand.trim() || null : null,
		servingSize: typeof obj.servingSize === 'string' ? obj.servingSize.trim() || null : null,
		servingGrams: num(obj.servingGrams),
		...macros,
		nutrients: obj.nutrients && typeof obj.nutrients === 'object' ? obj.nutrients : undefined,
		source: SOURCES.has(obj.source) ? obj.source : 'estimate',
		resolverNote:
			[
				typeof obj.confidence === 'string' ? `confidence: ${obj.confidence}` : null,
				typeof obj.resolverNote === 'string' ? obj.resolverNote : null
			]
				.filter(Boolean)
				.join(' — ') || null
	};
}
