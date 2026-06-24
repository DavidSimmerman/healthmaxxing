// Runnable check: `npx tsx src/lib/sleepInsights.selfcheck.ts`. Asserts only.
import assert from 'node:assert/strict';
import { sleepInsights } from './sleepInsights.ts';

const byKey = (a: ReturnType<typeof sleepInsights>) => Object.fromEntries(a.map((i) => [i.key, i]));

// Healthy night: 7.5h, deep 18%, rem 22%, eff 92%.
{
	const i = byKey(sleepInsights({ sleepMin: 450, deepMin: 81, remMin: 99, lightMin: 270, efficiencyPct: 92, restingHr: 55, hrvMs: 60 }));
	assert.equal(i.total.status, 'good');
	assert.equal(i.deep.status, 'good');
	assert.equal(i.rem.status, 'good');
	assert.equal(i.efficiency.status, 'good');
	assert.equal(i.light.status, 'unknown'); // light is reported, never graded
	assert.equal(i.deep.value, '18%');
}

// Short night, low deep, poor efficiency.
{
	const i = byKey(sleepInsights({ sleepMin: 360, deepMin: 36, remMin: 54, lightMin: 270, efficiencyPct: 78, restingHr: 60, hrvMs: 40 }));
	assert.equal(i.total.status, 'low'); // 6h < 7h
	assert.equal(i.deep.status, 'low'); // 10% < 13%
	assert.equal(i.efficiency.status, 'low'); // 78% < 85%
}

// Missing data → those insights are simply omitted, no throw.
{
	const i = sleepInsights({ sleepMin: null, deepMin: null, remMin: null, lightMin: null, efficiencyPct: null, restingHr: null, hrvMs: null });
	assert.deepEqual(i, []);
}

// Stage % is of time ASLEEP, not time in bed.
{
	const i = byKey(sleepInsights({ sleepMin: 400, deepMin: 100, remMin: null, lightMin: null, efficiencyPct: null, restingHr: null, hrvMs: null }));
	assert.equal(i.deep.value, '25%'); // 100/400, and 25 > 23 → high
	assert.equal(i.deep.status, 'high');
}

console.log('sleepInsights.selfcheck: OK');
