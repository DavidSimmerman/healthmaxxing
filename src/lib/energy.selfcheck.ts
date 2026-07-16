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
	targetBaseline,
	deficitBank,
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

// ── Daily eat-to target ──────────────────────────────────────────────────────
// base = 0.9 × 2400 − 500 = 1660; only active ABOVE the 800 typical bumps it up.
const rt = (actualActiveKcal: number) =>
	ratchetTarget({
		maintenanceKcal: 2400,
		modeDeltaKcal: -500,
		avgActiveKcal: 800,
		actualActiveKcal
	});
assert.equal(rt(800), 1660); // typical day (actual = avg) → 90% maintenance − deficit (the cushioned base)
assert.equal(rt(400), 1660); // below-average day stays at the base — never drops below the cushion
assert.equal(rt(0), 1660); // rest day → still the base
assert.equal(rt(1200), 2060); // 400 over typical → base + 400 (extra exercise added on)
assert(rt(1200) > rt(800)); // ratchets UP only for burn above the typical day
assert(rt(1200) >= rt(400)); // monotonic non-decreasing in actual active

// The 90% cushion is CUT-ONLY: recomp eats AT maintenance, lean bulk ABOVE it — the
// haircut must NOT turn a maintenance/surplus goal into a deficit.
assert.equal(targetBaseline(2400, -500), 1660); // cut → 0.9×2400 − 500
assert.equal(targetBaseline(2400, 0), 2400); // recomp → maintenance, no haircut
assert.equal(targetBaseline(2400, 150), 2550); // lean bulk → maintenance + surplus, no haircut
// and the full target for a typical recomp day is exactly maintenance (no phantom deficit)
assert.equal(
	ratchetTarget({
		maintenanceKcal: 2400,
		modeDeltaKcal: 0,
		avgActiveKcal: 800,
		actualActiveKcal: 800
	}),
	2400
);

// ── Recovery bank ─────────────────────────────────────────────────────────────
// goal 700, cap 500. Ordinary on-goal days build nothing; overshoots earn a decaying,
// capped credit that a low-deficit day bleeds back to zero.
const G = 700;
assert.equal(deficitBank([{ deficitKcal: 700, goalKcal: G }], 500), 0); // exactly on goal → 0
assert.equal(deficitBank([{ deficitKcal: 300, goalKcal: G }], 500), 0); // under goal → floored at 0 (no debt)
assert.equal(deficitBank([{ deficitKcal: 900, goalKcal: G }], 500), 200); // +200 overshoot → 200 credit
assert.equal(deficitBank([{ deficitKcal: 5000, goalKcal: G }], 500), 500); // huge day → capped at 500
// decay: +400 yesterday, on-goal today → 0.5×400 + 0 = 200
assert.equal(
	deficitBank(
		[
			{ deficitKcal: 1100, goalKcal: G },
			{ deficitKcal: 700, goalKcal: G }
		],
		500
	),
	200
);
// a low-deficit day clears a standing bank fast: 0.5×200 + (300−700) = −300 → floored 0
assert.equal(
	deficitBank(
		[
			{ deficitKcal: 900, goalKcal: G },
			{ deficitKcal: 300, goalKcal: G }
		],
		500
	),
	0
);
assert.equal(deficitBank([{ deficitKcal: null, goalKcal: G }], 500), 0); // no data → skipped
// bank raises the eat-to baseline 1:1 (recovery = eat more), still on top of the ratchet
assert.equal(
	ratchetTarget({
		maintenanceKcal: 2400,
		modeDeltaKcal: -500,
		avgActiveKcal: 800,
		actualActiveKcal: 800,
		bankKcal: 300
	}),
	1960 // 1660 base + 300 recovery
);

// Trusted workout source: dedicated third-party trackers yes, Apple's own no,
// null (pre-capture) yes (no regression).
assert.equal(isTrustedWorkoutSource(null), true);
assert.equal(isTrustedWorkoutSource('com.kingsmith.walkingpad'), true);
assert.equal(isTrustedWorkoutSource('com.apple.health'), false);
assert.equal(isTrustedWorkoutSource('com.apple.workout.build'), false);

console.log('energy.selfcheck: all assertions passed ✓');
