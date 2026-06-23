// Runnable check for the bolusable (net glycemic) carb math.
// Run: npx tsx src/lib/netCarbs.check.ts
//
// David is T1D and doses insulin off the bolusable number. These assertions pin
// the formula's behavior, especially the safe-direction defaults (when data is
// uncertain we UNDER-subtract → slightly higher carbs).
import assert from 'node:assert/strict';
import {
	netCarbs,
	bolusableCarbsPerServing,
	bolusableForLoggedEntry,
	fiberAdjustment,
	POLYOL_FACTOR
} from './netCarbs.ts';

const close = (a: number, b: number, eps = 1e-9) => assert(Math.abs(a - b) < eps, `${a} !≈ ${b}`);

// 1. Plain food, no fiber → net == total. Fiber field absent → lowConfidence.
{
	const r = netCarbs({ carbsG: 25 }, { fiberMode: 'full' });
	close(r.bolusableCarbsG, 25);
	assert.equal(r.totalCarbsG, 25);
	assert.equal(r.lowConfidence, true); // carbs present, fiber unknown
}

// Known fiber = 0 → not low confidence (we know there's no fiber).
{
	const r = netCarbs({ carbsG: 25, fiberG: 0 }, { fiberMode: 'full' });
	close(r.bolusableCarbsG, 25);
	assert.equal(r.lowConfidence, false);
}

// Zero-carb food → never low confidence (nothing to dose for).
{
	const r = netCarbs({ carbsG: 0 }, { fiberMode: 'full' });
	close(r.bolusableCarbsG, 0);
	assert.equal(r.lowConfidence, false);
}

// 2. High-fiber tortilla (total 32, fiber 28, mode=full) → net 4.
{
	const r = netCarbs({ carbsG: 32, fiberG: 28 }, { fiberMode: 'full' });
	close(r.bolusableCarbsG, 4);
	assert.equal(r.lowConfidence, false);
}

// 3. Same tortilla, mode=half_over_5 → 32 - 14 = 18.
{
	const r = netCarbs({ carbsG: 32, fiberG: 28 }, { fiberMode: 'half_over_5' });
	close(r.bolusableCarbsG, 18);
}

// half_over_5 threshold: fiber ≤ 5 subtracts nothing; just over 5 subtracts half.
close(fiberAdjustment(5, 'half_over_5'), 0); // not > 5
close(fiberAdjustment(6, 'half_over_5'), 3);
close(fiberAdjustment(5, 'full'), 5);

// 4. Erythritol dessert (total 30, sugarAlcohol 30, erythritol) → net 0.
{
	const r = netCarbs(
		{ carbsG: 30, fiberG: 0, sugarAlcoholG: 30, polyolType: 'erythritol' },
		{ fiberMode: 'full' }
	);
	close(r.bolusableCarbsG, 0);
}

// 5. Maltitol product (total 30, sugarAlcohol 30, maltitol) → net 15 (0.5 factor).
{
	const r = netCarbs(
		{ carbsG: 30, fiberG: 0, sugarAlcoholG: 30, polyolType: 'maltitol' },
		{ fiberMode: 'full' }
	);
	close(r.bolusableCarbsG, 15);
}

// 6. Unknown polyol (total 30, sugarAlcohol 30) → net 15 (default 0.5, conservative).
{
	const r = netCarbs({ carbsG: 30, fiberG: 0, sugarAlcoholG: 30 }, { fiberMode: 'full' });
	close(r.bolusableCarbsG, 15);
	assert.equal(POLYOL_FACTOR.unknown, 0.5);
}

// Allulose subtracts fully (separate field, when ever populated).
{
	const r = netCarbs({ carbsG: 20, fiberG: 0, alluloseG: 8 }, { fiberMode: 'full' });
	close(r.bolusableCarbsG, 12);
}

// Never goes negative.
{
	const r = netCarbs({ carbsG: 5, fiberG: 40 }, { fiberMode: 'full' });
	close(r.bolusableCarbsG, 0);
}

// 8. Recipe roll-up sums at the INGREDIENT level (matters under half_over_5's
// nonlinear threshold). Two ingredients each 4g fiber, 1 serving:
//  - food-level would sum fiber=8 (>5) → subtract 4
//  - ingredient-level: neither 4g is >5 → subtract 0 → net = total
{
	const recipe = {
		carbsG: 40,
		nutrients: { fiberG: 8 },
		makesServings: 1,
		ingredients: [
			{ carbsG: 20, nutrients: { fiberG: 4 } },
			{ carbsG: 20, nutrients: { fiberG: 4 } }
		]
	};
	const r = bolusableCarbsPerServing(recipe, { fiberMode: 'half_over_5' });
	close(r.bolusableCarbsG, 40); // ingredient-level → no subtraction
}

// Recipe roll-up under full mode, divided by makesServings.
// Burrito-like: total 80 over 2 servings, tortilla fiber 28, beans fiber 4.
{
	const recipe = {
		carbsG: 40, // per serving (unused by ingredient path)
		makesServings: 2,
		ingredients: [
			{ carbsG: 60, nutrients: { fiberG: 28 } }, // (60-28)=32
			{ carbsG: 20, nutrients: { fiberG: 4 } } // (20-4)=16
		]
	};
	const r = bolusableCarbsPerServing(recipe, { fiberMode: 'full' });
	close(r.bolusableCarbsG, (32 + 16) / 2); // = 24 per serving
}

// Recipe with an ingredient missing fiber → lowConfidence bubbles up.
{
	const recipe = {
		carbsG: 30,
		makesServings: 1,
		ingredients: [
			{ carbsG: 20, nutrients: { fiberG: 5 } },
			{ carbsG: 10 } // no nutrients → fiber unknown
		]
	};
	const r = bolusableCarbsPerServing(recipe, { fiberMode: 'full' });
	assert.equal(r.lowConfidence, true);
}

// Simple food via bolusableCarbsPerServing matches netCarbs.
{
	const food = { carbsG: 32, nutrients: { fiberG: 28 } };
	const r = bolusableCarbsPerServing(food, { fiberMode: 'full' });
	close(r.bolusableCarbsG, 4);
}

// Logged-entry helper (simple food): scales per-serving fiber by servings, derives
// from snapshot total. 2nd arg is the food object (nutrients live on food.nutrients).
{
	// 2 servings of the tortilla: total carbs 64 (snapshot), fiber 28/serving → 56 subtracted.
	const r = bolusableForLoggedEntry(64, { nutrients: { fiberG: 28 } }, 2, { fiberMode: 'full' });
	close(r.bolusableCarbsG, 8);
	assert.equal(r.lowConfidence, false);
}
{
	// Missing fiber on a carby entry → net == total, lowConfidence.
	const r = bolusableForLoggedEntry(40, { nutrients: null }, 1, { fiberMode: 'full' });
	close(r.bolusableCarbsG, 40);
	assert.equal(r.lowConfidence, true);
}
{
	// Never exceeds the snapshot total (fiber can't push it up).
	const r = bolusableForLoggedEntry(10, { nutrients: { fiberG: 0 } }, 1, { fiberMode: 'full' });
	close(r.bolusableCarbsG, 10);
	assert.equal(r.lowConfidence, false);
}

// Logged-entry helper (recipe): uses ingredient-level rollup × servings — matches the
// pre-log card exactly, so the meal-review preview and the logged history agree even
// under half_over_5. Per-serving net (full) = (32+16)/2 = 24.
{
	const recipeFood = {
		carbsG: 40,
		makesServings: 2,
		ingredients: [
			{ carbsG: 60, nutrients: { fiberG: 28 } },
			{ carbsG: 20, nutrients: { fiberG: 4 } }
		]
	};
	const r = bolusableForLoggedEntry(80, recipeFood, 2, { fiberMode: 'full' });
	close(r.bolusableCarbsG, 48); // 24/serving × 2 servings
	// Cap at the snapshot total if the food was edited UP after logging.
	const capped = bolusableForLoggedEntry(10, recipeFood, 2, { fiberMode: 'full' });
	close(capped.bolusableCarbsG, 10);
}

console.log('netCarbs.check.ts OK');
