// Barcode normalization + macro-snapshot comparison.
//
// A product's UPC-A (12-digit) and EAN-13 (13-digit, leading 0) codes are the
// SAME item — UPC-A is just EAN-13 with a leading zero. Scanners emit one form,
// Open Food Facts / Claude often use the other, and a naive exact-string match
// then treats them as two different foods (duplicate rows + a saved override the
// scan never finds). Canonicalize to a GTIN-14 (left-pad digits to 14) so every
// representation of the same product collapses to one key.

/**
 * Canonical key for matching/upsert. '' if there are no digits.
 *
 * UPC-A (12), EAN-13 (13) and GTIN-14 (14) are the same numbering space — a
 * UPC-A is an EAN-13 with a leading zero — so those collapse to a 14-digit
 * GTIN. Other lengths (EAN-8, short/internal/manual codes) are left as-is:
 * padding them would make distinct codes that merely share a suffix collide
 * (e.g. `123456` and a 14-digit ending in `123456`).
 *
 * NOTE: `findFoodByBarcode` mirrors this exact rule in SQL — keep them in sync.
 */
export function canonicalBarcode(code: string | null | undefined): string {
	const raw = (code ?? '').trim();
	if (!raw) return '';
	// Alphanumeric scanner formats (Code39/Code128) carry letters and have no
	// leading-zero equivalence — preserve them verbatim so a saved code round-trips
	// on the next scan instead of collapsing to its digits.
	if (/[A-Za-z]/.test(raw)) return raw;
	const digits = raw.replace(/\D/g, '');
	return digits.length >= 12 && digits.length <= 14 ? digits.padStart(14, '0') : digits;
}

/** Per-serving macro snapshot we store as the source-of-truth baseline. */
export type MacroSnapshot = {
	calories: number;
	proteinG: number;
	carbsG: number;
	fatG: number;
};

// Tiny epsilon so floating-point round-trips don't read as a change. Open Food
// Facts returns stable numbers, so anything past this is a real reformulation —
// which is what the user asked to be flagged ("any difference").
const EPS = 0.01;

/** True if any of the four macros differ beyond floating-point noise. */
export function macrosDiffer(
	a: MacroSnapshot | null | undefined,
	b: MacroSnapshot | null | undefined
): boolean {
	if (!a || !b) return false; // no baseline / no source value → nothing to compare
	return (
		Math.abs(a.calories - b.calories) > EPS ||
		Math.abs(a.proteinG - b.proteinG) > EPS ||
		Math.abs(a.carbsG - b.carbsG) > EPS ||
		Math.abs(a.fatG - b.fatG) > EPS
	);
}

/** Pull a MacroSnapshot out of any object carrying the four macro fields. */
export function toSnapshot(m: {
	calories: number;
	proteinG: number;
	carbsG: number;
	fatG: number;
}): MacroSnapshot {
	return { calories: m.calories, proteinG: m.proteinG, carbsG: m.carbsG, fatG: m.fatG };
}
