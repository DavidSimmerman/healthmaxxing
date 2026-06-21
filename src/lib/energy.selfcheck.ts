// Runnable check for the projection math: `npx tsx src/lib/energy.selfcheck.ts`.
// No test framework — just asserts. Exits non-zero on failure.
import assert from 'node:assert/strict';
import {
	linearRegression,
	interpolateGaps,
	etaDaysToGoal,
	daysBetween,
	addDays,
	bodyFatPctFromLean,
	katchMcArdleBmr,
	tefKcal
} from './energy.ts';

// linearRegression recovers a known line y = 2x + 1
{
	const fit = linearRegression([
		{ x: 0, y: 1 },
		{ x: 1, y: 3 },
		{ x: 2, y: 5 },
		{ x: 3, y: 7 }
	]);
	assert(fit, 'fit should exist');
	assert(Math.abs(fit!.slope - 2) < 1e-9, `slope ${fit!.slope}`);
	assert(Math.abs(fit!.intercept - 1) < 1e-9, `intercept ${fit!.intercept}`);
}
// degenerate inputs → null
assert.equal(linearRegression([{ x: 1, y: 1 }]), null);
assert.equal(linearRegression([{ x: 5, y: 1 }, { x: 5, y: 9 }]), null); // all x equal

// interpolateGaps fills the middle and carries the ends
assert.deepEqual(interpolateGaps([1, null, 3]), [1, 2, 3]);
assert.deepEqual(interpolateGaps([null, 2, null]), [2, 2, 2]);
assert.deepEqual(interpolateGaps([null, null]), [null, null]);
assert.deepEqual(interpolateGaps([1, null, null, 4]), [1, 2, 3, 4]);

// etaDaysToGoal: losing 0.1kg/day from 80 to 75 = 50 days; wrong-way = null
assert.equal(etaDaysToGoal(80, 75, -0.1), 50);
assert.equal(etaDaysToGoal(80, 75, 0.1), null);
assert.equal(etaDaysToGoal(75, 75, -0.1), 0);
assert.equal(etaDaysToGoal(80, 75, 0), null);

// date helpers
assert.equal(daysBetween('2026-01-01', '2026-01-31'), 30);
assert.equal(addDays('2026-01-01', 30), '2026-01-31');
assert.equal(daysBetween('2026-03-01', '2026-03-31'), 30); // spans US DST change

// body fat from lean mass: 80kg, 64kg lean → 20%
assert.equal(bodyFatPctFromLean(80, 64), 20);

// sanity: existing formulas still wired
assert.equal(katchMcArdleBmr(60), 370 + 21.6 * 60);
assert(Math.abs(tefKcal(100, 0, 0) - 0.27 * 4 * 100) < 1e-9);

console.log('energy.selfcheck: all assertions passed ✓');
