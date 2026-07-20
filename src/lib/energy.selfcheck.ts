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
	deficitBalance,
	isTrustedWorkoutSource,
	workoutActiveKcal
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
// Burn-anchored: conservative burn estimate = 0.9 × 2400 = 2160; floor = 2160 − 500 = 1660.
// Once actual burn passes 2160, target = burn − 500.
const rt = (actualBurnKcal: number) =>
	ratchetTarget({
		maintenanceKcal: 2400,
		modeDeltaKcal: -500,
		actualBurnKcal
	});
assert.equal(rt(1800), 1660); // burn below the conservative estimate → held at the floor
assert.equal(rt(2160), 1660); // right at the estimate → floor
assert.equal(rt(2900), 2400); // out-burned the estimate → burn − deficit (climbs 1:1)
assert.equal(rt(3000), 2500); // keeps tracking real burn
assert(rt(2900) > rt(2160)); // rises once you out-burn the estimate
assert(rt(3000) >= rt(2900)); // monotonic non-decreasing in actual burn

// The 90% haircut is a CUT-only conservative burn estimate: recomp/lean_bulk assume FULL
// maintenance, so a low-burn day can't floor them below maintenance into an accidental deficit.
assert.equal(targetBaseline(2400, -500), 1660); // cut floor → 0.9×2400 − 500
assert.equal(targetBaseline(2400, 0), 2400); // recomp floor → maintenance, no haircut
assert.equal(targetBaseline(2400, 150), 2550); // lean bulk floor → maintenance + surplus
// recomp on a low-burn day still targets maintenance (no phantom deficit); a high-burn day eats back
assert.equal(
	ratchetTarget({ maintenanceKcal: 2400, modeDeltaKcal: 0, actualBurnKcal: 2000 }),
	2400
);
assert.equal(
	ratchetTarget({ maintenanceKcal: 2400, modeDeltaKcal: 0, actualBurnKcal: 2900 }),
	2900
);

// ── Deficit balance (recovery + debt) ─────────────────────────────────────────
// goal 700, cap ±500. Over-goal days earn RECOVERY (+), under-goal days owe DEBT (−); both
// decay 0.5/day and are symmetric-capped.
const G = 700;
assert.equal(deficitBalance([{ deficitKcal: 700, goalKcal: G }], 500), 0); // exactly on goal → 0
assert.equal(deficitBalance([{ deficitKcal: 900, goalKcal: G }], 500), 200); // +200 over → 200 recovery
assert.equal(deficitBalance([{ deficitKcal: 300, goalKcal: G }], 500), -400); // 400 under → 400 debt
assert.equal(deficitBalance([{ deficitKcal: 5000, goalKcal: G }], 500), 500); // huge deficit → +cap
assert.equal(deficitBalance([{ deficitKcal: -1000, goalKcal: G }], 500), -500); // big surplus → −cap (debt)
// decay: +400 yesterday, on-goal today → 0.5×400 + 0 = 200
assert.equal(
	deficitBalance(
		[
			{ deficitKcal: 1100, goalKcal: G },
			{ deficitKcal: 700, goalKcal: G }
		],
		500
	),
	200
);
// recovery flips to debt when you then eat over: 0.5×200 + (300−700) = −300
assert.equal(
	deficitBalance(
		[
			{ deficitKcal: 900, goalKcal: G },
			{ deficitKcal: 300, goalKcal: G }
		],
		500
	),
	-300
);
assert.equal(deficitBalance([{ deficitKcal: null, goalKcal: G }], 500), 0); // no data → skipped
// balance shifts the eat-to target 1:1: recovery raises it, debt lowers it
assert.equal(
	ratchetTarget({
		maintenanceKcal: 2400,
		modeDeltaKcal: -500,
		actualBurnKcal: 2900,
		balanceKcal: 300
	}),
	2700 // 2900 − 500 + 300 recovery
);
assert.equal(
	ratchetTarget({
		maintenanceKcal: 2400,
		modeDeltaKcal: -500,
		actualBurnKcal: 2900,
		balanceKcal: -300
	}),
	2100 // 2900 − 500 − 300 debt
);
// safety floor: deep debt on a low-burn day can't recommend an unsafely low intake
assert.equal(
	ratchetTarget({
		maintenanceKcal: 2400,
		modeDeltaKcal: -500,
		actualBurnKcal: 1800,
		balanceKcal: -500
	}),
	1500 // 2160 − 500 − 500 = 1160 → floored to MIN_EAT_TO_KCAL
);

// Trusted workout source: dedicated third-party trackers yes, Apple's own no,
// null (pre-capture) yes (no regression).
assert.equal(isTrustedWorkoutSource(null), true);
assert.equal(isTrustedWorkoutSource('com.kingsmith.walkingpad'), true);
assert.equal(isTrustedWorkoutSource('com.apple.health'), false);
assert.equal(isTrustedWorkoutSource('com.apple.workout.build'), false);

// Workout active energy: net cost of transport, distance × weight, split by activity type.
{
	// Run ~1.0 kcal/kg/km, walk ~0.5. Activity word decides, case-insensitive.
	assert.equal(workoutActiveKcal({ name: 'Run', distanceKm: 10, weightKg: 70 }), 700);
	assert.equal(workoutActiveKcal({ name: 'Outdoor Walk', distanceKm: 5, weightKg: 70 }), 175);
	assert.equal(workoutActiveKcal({ name: 'Trail Running', distanceKm: 4, weightKg: 80 }), 320);
	// No distance → null (e.g. strength training — leave it to the existing path).
	assert.equal(workoutActiveKcal({ name: 'Run', distanceKm: null, weightKg: 70 }), null);
	assert.equal(workoutActiveKcal({ name: 'Strength Training', distanceKm: null, weightKg: 70 }), null);
	// Non-transport activity where distance is a poor energy proxy → null (fall back).
	assert.equal(workoutActiveKcal({ name: 'Cycling', distanceKm: 20, weightKg: 70 }), null);
}

console.log('energy.selfcheck: all assertions passed ✓');
