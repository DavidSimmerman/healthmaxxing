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
	tefKcal,
	targetRatePctPerWeek,
	modeDeficit,
	correctActive,
	activeCorrectionFactor,
	ratchetTarget,
	isTrustedWorkoutSource
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
assert.equal(
	linearRegression([
		{ x: 5, y: 1 },
		{ x: 5, y: 9 }
	]),
	null
); // all x equal

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

// ── Dynamic deficit ──────────────────────────────────────────────────────────
// Cut at 18% bf, ~69.3kg → ≈ −500 kcal/day (≈1 lb/wk).
{
	const d = modeDeficit('cut', 18, 69.3);
	assert(d < 0, `cut is a deficit, got ${d}`);
	assert(Math.abs(d - -503) < 15, `cut@18% ≈ −503, got ${Math.round(d)}`);
}
assert.equal(modeDeficit('recomp', 18, 69.3), 0); // recomp holds at maintenance
assert(modeDeficit('lean_bulk', 18, 69.3) > 0, 'lean bulk is a surplus');
// Leanness scaling: harder when fat to spare, gentler when lean; clamped.
assert.equal(targetRatePctPerWeek('cut', 30), -1.0); // ramp hits the −1.0%/wk cap
assert.equal(targetRatePctPerWeek('cut', 8), -0.3); // eased to the −0.3%/wk floor
assert(targetRatePctPerWeek('cut', 20) < targetRatePctPerWeek('cut', 15)); // more bf ⇒ bigger (more negative) cut

// ── Active-energy correction ─────────────────────────────────────────────────
// 400 trusted (pad) rides at 1.0; only the 600 passive gets ×0.7 → 400 + 420.
assert.equal(correctActive(1000, 400, 0.7), 820);
assert.equal(correctActive(500, 800, 0.7), 800); // trusted ≥ total ⇒ passive floored at 0
// factor: real active 600, raw 900, trusted 300 → passive 600, realPassive 300 → 0.5.
assert.equal(activeCorrectionFactor(600, 900, 300), 0.5);
assert.equal(activeCorrectionFactor(600, 320, 300), 1); // ~no passive signal ⇒ no correction
assert.equal(activeCorrectionFactor(200, 900, 0), 0.4); // clamped to floor

// ── Ratcheting target ────────────────────────────────────────────────────────
const rt = (actualActiveKcal: number) =>
	ratchetTarget({
		maintenanceKcal: 2400,
		modeDeltaKcal: -500,
		avgActiveKcal: 800,
		actualActiveKcal
	});
assert.equal(rt(800), 1900); // typical day (actual = avg) → maintenance − deficit
assert.equal(rt(0), 1100); // conservative start (nothing burned) → maintenance − avgActive − deficit
assert(rt(1200) > rt(400)); // ratchets UP with real burn, never on a projection
assert(rt(400) > rt(0)); // monotonic in actual active

// Trusted workout source: dedicated third-party trackers yes, Apple's own no,
// null (pre-capture) yes (no regression).
assert.equal(isTrustedWorkoutSource(null), true);
assert.equal(isTrustedWorkoutSource('com.kingsmith.walkingpad'), true);
assert.equal(isTrustedWorkoutSource('com.apple.health'), false);
assert.equal(isTrustedWorkoutSource('com.apple.workout.build'), false);

console.log('energy.selfcheck: all assertions passed ✓');
