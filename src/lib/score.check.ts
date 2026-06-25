// Runnable check for the goal scoring engine.
// Run: npx tsx src/lib/score.check.ts
import assert from 'node:assert/strict';
import {
	scoreDay,
	scorePeriod,
	currentStreak,
	attainment,
	overshoot,
	grade,
	SPEC,
	BONUS_CAP_DAY,
	type DayMetrics
} from './score.ts';

const approx = (a: number, b: number, eps = 1e-6) => assert(Math.abs(a - b) < eps, `${a} !≈ ${b}`);

// A day that hits every target exactly.
const perfectDay: DayMetrics = {
	date: '2026-06-20',
	gmi: 6.5,
	tir: 85,
	over250: 0,
	below70: 2,
	steps: 10000,
	sleepMin: 420,
	deficit: 750,
	protein: 160,
	waterOz: 87
};

// ── attainment / overshoot primitives ──
approx(attainment(SPEC.steps, 5000)!, 0.5); // halfway to 10k
approx(attainment(SPEC.steps, 99999)!, 1); // clamped
approx(attainment(SPEC.gmi, 6.5)!, 1); // at target (<=)
approx(attainment(SPEC.gmi, 8.0)!, 0); // at floor
approx(attainment(SPEC.gmi, 7.25)!, 0.5); // midway 6.5→8
assert.equal(attainment(SPEC.tir, null), null); // missing → null
approx(attainment(SPEC.protein, 130)!, 0.5); // 100→160 ramp
approx(attainment(SPEC.protein, 90)!, 0); // below "very bad" floor
approx(attainment(SPEC.no_over_250, 0)!, 1); // 0% over 250 = perfect
approx(attainment(SPEC.no_over_250, 5)!, 0.5); // 5% over, floor 10
approx(overshoot(SPEC.gmi, 5.0), 1); // best-case GMI maxes bonus
approx(overshoot(SPEC.tir, 100), 1);
approx(overshoot(SPEC.deficit, 1500), 1);
approx(overshoot(SPEC.gmi, 6.5), 0); // exactly at target → no bonus

// ── a perfect day ──
{
	const s = scoreDay(perfectDay);
	approx(s.base!, 100);
	assert.equal(s.perfect, true);
	assert.equal(s.veryBad, false);
	approx(s.bonus, 0); // hit targets but didn't beat them
	approx(s.score!, 100);
	assert.equal(
		s.goals.every((g) => g.met),
		true
	);
}

// ── beating the bonus goals on an otherwise-perfect day stays capped at 100 ──
{
	const s = scoreDay({ ...perfectDay, gmi: 5.0, tir: 100, deficit: 1500 });
	approx(s.base!, 100);
	approx(s.bonus, BONUS_CAP_DAY); // all three bonus goals maxed
	approx(s.score!, 100); // capped
	assert.equal(s.perfect, true);
}

// ── a non-perfect day gets BUMPED by bonus but not to a lie ──
{
	// steps half (att .5), everything else met, glucose+deficit beaten → base ~94.4 + 8 → capped 100
	const s = scoreDay({ ...perfectDay, steps: 5000, gmi: 5.0, tir: 100, deficit: 1500 });
	approx(s.base!, ((8 + 0.5) / 9) * 100);
	assert(s.base! < 95 && s.score === 100, 'bonus should bump a ~94 day to 100');
	assert.equal(s.perfect, false); // steps not met
}

// ── bonus can NEVER rescue an awful day ──
// Even with the 3 bonus goals MAXED, a day that's otherwise all-floor stays an F:
// base = 3/9 met = 33.3, +8 bonus = 41.3 — bumped, but nowhere near passing.
{
	const awfulButGreatGlucose: DayMetrics = {
		date: '2026-06-21',
		gmi: 5.0,
		tir: 100,
		deficit: 1500, // beating bonus goals hard...
		over250: 10,
		below70: 8,
		steps: 0,
		sleepMin: 0,
		protein: 50,
		waterOz: 0 // ...rest is the floor
	};
	const s = scoreDay(awfulButGreatGlucose);
	approx(s.base!, (3 / 9) * 100);
	approx(s.bonus, BONUS_CAP_DAY);
	assert(s.score! < 50 && grade(s.score) === 'F', `bonus must not rescue: got ${s.score}`);
	assert.equal(s.veryBad, true);
}

// ── a truly awful day (nothing good) → ~0, no bonus ──
{
	const rockBottom: DayMetrics = {
		date: '2026-06-21',
		gmi: 8,
		tir: 0,
		over250: 10,
		below70: 8,
		steps: 0,
		sleepMin: 0,
		deficit: 0,
		protein: 50,
		waterOz: 0
	};
	const s = scoreDay(rockBottom);
	approx(s.base!, 0);
	approx(s.bonus, 0);
	approx(s.score!, 0);
	assert.equal(s.veryBad, true);
}

// ── missing glucose (Dexcom not connected): those goals excluded, can't be "perfect" ──
{
	const noGlucose: DayMetrics = {
		...perfectDay,
		gmi: null,
		tir: null,
		over250: null,
		below70: null
	};
	const s = scoreDay(noGlucose);
	approx(s.base!, 100); // the 5 remaining goals all met
	assert.equal(s.perfect, false); // not every goal had data
	assert.equal(s.goals.find((g) => g.key === 'gmi')!.display, '—');
}

// ── all data missing → null score, not 0 ──
{
	const empty: DayMetrics = {
		date: '2026-06-22',
		gmi: null,
		tir: null,
		over250: null,
		below70: null,
		steps: null,
		sleepMin: null,
		deficit: null,
		protein: null,
		waterOz: null
	};
	const s = scoreDay(empty);
	assert.equal(s.base, null);
	assert.equal(s.score, null);
	assert.equal(s.perfect, false);
}

// ── streak: trailing perfect days only ──
assert.equal(
	currentStreak([{ perfect: true }, { perfect: false }, { perfect: true }, { perfect: true }]),
	2
);
assert.equal(currentStreak([{ perfect: false }]), 0);
assert.equal(currentStreak([{ perfect: true }, { perfect: true }]), 2);

// ── period: weekly goals blend + prorated month target ──
{
	const week = Array.from({ length: 7 }, (_, i) => ({ ...perfectDay, date: `2026-06-${14 + i}` }));
	const p = scorePeriod(week, { strengthCount: 5, runningMiles: 8, days: 7 });
	approx(p.base!, 100); // perfect days + weekly goals met
	assert.equal(p.perfectDays, 7);
	assert.equal(p.streak, 7);
	approx(p.score!, 100);

	// month: 5/wk strength over 30 days prorates to ~21.4 target; 21 done → just under
	const month = Array.from({ length: 30 }, (_, i) => ({
		...perfectDay,
		date: `2026-06-${String(i + 1).padStart(2, '0')}`
	}));
	const pm = scorePeriod(month, { strengthCount: 21, runningMiles: 30, days: 30 });
	assert(pm.score! > 90, 'near-target month should score high');
	assert(
		pm.weeklyGoals.find((g) => g.key === 'strength')!.attainment! < 1,
		'prorated strength target not quite met'
	);
}

// ── weekly goals missing (no workouts logged) → fall back to daily mean ──
{
	const week = Array.from({ length: 7 }, (_, i) => ({ ...perfectDay, date: `2026-06-${14 + i}` }));
	const p = scorePeriod(week, { strengthCount: null, runningMiles: null, days: 7 });
	approx(p.base!, 100); // daily-only
}

// ── grade boundaries ──
assert.equal(grade(100), 'A+');
assert.equal(grade(85), 'B');
assert.equal(grade(50), 'F');
assert.equal(grade(null), '—');

console.log('score.check.ts OK');
