// Runnable check for the CGM summary math.
// Run: npx tsx src/lib/glucose.check.ts
import assert from 'node:assert/strict';
import { glucoseStats, gmiPct, TIR_LOW, TIR_HIGH } from './glucose.ts';

const close = (a: number, b: number, eps = 1e-9) => assert(Math.abs(a - b) < eps, `${a} !≈ ${b}`);

// Empty / all-invalid → null (no bogus zero-day).
assert.equal(glucoseStats([]), null);
assert.equal(glucoseStats([0, -5, NaN]), null);

// GMI formula pinned (Bergenstal 2018): 154 mg/dL ≈ 7.0% A1C.
close(gmiPct(154), 3.31 + 0.02392 * 154);
assert(Math.abs(gmiPct(154) - 7.0) < 0.02, 'GMI(154) should be ~7.0%');

// Boundaries are inclusive: 70 and 180 count as in-range, not low/high.
{
	const s = glucoseStats([TIR_LOW, TIR_HIGH])!;
	close(s.tirPct, 100);
	close(s.belowPct, 0);
	close(s.abovePct, 0);
}

// Mixed day: 60 (low), 120 & 150 (in range), 200 (high) → 50% TIR, 25/25 below/above.
{
	const s = glucoseStats([60, 120, 150, 200])!;
	assert.equal(s.n, 4);
	close(s.avgMgdl, (60 + 120 + 150 + 200) / 4);
	close(s.tirPct, 50);
	close(s.belowPct, 25);
	close(s.abovePct, 25);
	// Splits always sum to 100%.
	close(s.tirPct + s.belowPct + s.abovePct, 100);
}

// Invalid readings are dropped before stats (sensor gaps don't skew the average).
{
	const s = glucoseStats([100, 0, 140, NaN])!;
	assert.equal(s.n, 2);
	close(s.avgMgdl, 120);
}

console.log('glucose.check.ts OK');
