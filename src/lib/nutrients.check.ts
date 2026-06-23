// Self-check for the back-correction primitives. Run: npx tsx src/lib/nutrients.check.ts
import assert from 'node:assert/strict';
import { mergeNutrients, nutrientCoverage } from './nutrients';

// merge: patch wins, untouched keys kept, junk/negative dropped
assert.deepEqual(mergeNutrients({ vitB12Ug: 1, ironMg: 5 }, { vitB12Ug: 2.4 }), {
	vitB12Ug: 2.4,
	ironMg: 5
});
assert.deepEqual(mergeNutrients(null, { vitB12Ug: 2.4 }), { vitB12Ug: 2.4 });
assert.equal(mergeNutrients(null, {}), null);
// bogus key + negative value are sanitized away; existing iron survives
assert.deepEqual(mergeNutrients({ ironMg: 5 }, { bogusKey: 9, vitCMg: -1 } as never), {
	ironMg: 5
});

// coverage: calorie-weighted share of intake whose food recorded each nutrient
const entries = [
	{ calories: 300, nutrients: { vitB12Ug: 2 } },
	{ calories: 700, nutrients: null }
];
const cov = nutrientCoverage(entries, 1000);
assert.equal(cov.vitB12Ug, 0.3); // only the 300-kcal food carried B12
assert.equal(cov.ironMg, undefined); // nothing carried iron
assert.deepEqual(nutrientCoverage([], 1000), {}); // nothing logged → no coverage keys

// zero-calorie supplement: the only B12 source has 0 kcal → explicitly logged, so it
// must still appear in coverage (contract: every nutrient in totals has a coverage),
// at full confidence — not absent, not 0.
const supp = [
	{ calories: 0, nutrients: { vitB12Ug: 500 } },
	{ calories: 2000, nutrients: {} }
];
assert.equal(nutrientCoverage(supp, 2000).vitB12Ug, 1);

// recipe coverage: a 600-kcal recipe where only a 50-kcal ingredient recorded B12
// must NOT read as fully covered — weight by ingredient calories.
const recipe = [
	{
		calories: 600,
		nutrients: { vitB12Ug: 1 }, // aggregated bag has the key (any ingredient had it)
		ingredients: [
			{ calories: 50, nutrients: { vitB12Ug: 1 } },
			{ calories: 550, nutrients: {} }
		]
	}
];
const rcov = nutrientCoverage(recipe, 600);
assert.equal(rcov.vitB12Ug, 0.08); // 50/600 ≈ 0.083 → 0.08, not 1.0

console.log('nutrients.check.ts OK');
