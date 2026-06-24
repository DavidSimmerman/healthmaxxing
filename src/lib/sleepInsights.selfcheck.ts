// Runnable check: `npx tsx src/lib/sleepInsights.selfcheck.ts`. Asserts only.
import assert from 'node:assert/strict';
import {
	sleepInsights,
	sleepTrends,
	awakeningsFor,
	clockStddevNoonOrigin,
	halfSplitDelta,
	type Night,
	type StagesByDate
} from './sleepInsights.ts';

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

// ── Trend helpers ────────────────────────────────────────────────────────────

// awakeningsFor: counts AWAKE segments and sums their minutes; ignores other stages.
{
	const r = awakeningsFor({
		startAt: '2026-06-20T03:00:00Z',
		endAt: '2026-06-20T11:00:00Z',
		segments: [
			{ stage: 'LIGHT', startMin: 0, durationMin: 60 },
			{ stage: 'AWAKE', startMin: 60, durationMin: 5 },
			{ stage: 'DEEP', startMin: 65, durationMin: 90 },
			{ stage: 'AWAKE', startMin: 155, durationMin: 10 },
			{ stage: 'REM', startMin: 165, durationMin: 40 }
		]
	});
	assert.equal(r.count, 2); // two AWAKE segments
	assert.equal(r.awakeMin, 15); // 5 + 10
}

// clockStddevNoonOrigin: the midnight-wrap case. Onsets 23:00 (1380) & 00:30 (30)
// are 90 min apart on the clock — noon-origin must report a SMALL spread (45),
// not the ~675 a naive stddev over [1380, 30] would give.
{
	const sd = clockStddevNoonOrigin([23 * 60, 30]); // 23:00, 00:30
	assert.ok(sd != null && sd < 60, `expected small wrap stddev, got ${sd}`);
	assert.equal(Math.round(sd!), 45); // population stddev of [1380→660+1440%... ] = 45
	// And a naive stddev over the same raw values would be huge — sanity check the
	// helper actually shifted: a tight cluster (1380, 1410) → ~15.
	assert.equal(Math.round(clockStddevNoonOrigin([1380, 1410])!), 15);
	assert.equal(clockStddevNoonOrigin([720]), null); // <2 samples → null
}

// halfSplitDelta: newest-first → front half is the recent half. delta = newer − older.
{
	// Falling series read newest-first: recent values are LOWER → negative delta.
	const d = halfSplitDelta([50, 51, 54, 55]); // newer [50,51]=50.5, older [54,55]=54.5
	assert.ok(d);
	assert.equal(d!.newer, 50.5);
	assert.equal(d!.older, 54.5);
	assert.equal(d!.delta, -4); // improving for RHR (down)
	assert.equal(halfSplitDelta([60, 62, 61]), null); // <4 samples → null
}

// sleepTrends: sleep-debt sum vs 420 floor, plus omission of stage-based cards
// when no stages are present.
{
	const nights: Night[] = [
		{ date: '2026-06-23', m: { sleep_min: 360 } }, // 60 short
		{ date: '2026-06-22', m: { sleep_min: 400 } }, // 20 short
		{ date: '2026-06-21', m: { sleep_min: 450 } } // over floor → 0
	];
	const out = sleepTrends(nights, {}, 'America/New_York');
	const byKey = Object.fromEntries(out.map((i) => [i.key, i]));
	assert.equal(byKey.debt.value, '1h 20m'); // 60 + 20 + 0 = 80 min
	assert.equal(byKey.awakenings, undefined); // no stages → omitted, no throw
	assert.equal(byKey.consistency, undefined);
}

// sleepTrends: RHR trend direction (down = good) over a 4-night newest-first slice.
{
	const nights: Night[] = [
		{ date: '2026-06-23', m: { sleep_min: 450, sleep_resting_hr: 52 } },
		{ date: '2026-06-22', m: { sleep_min: 450, sleep_resting_hr: 53 } },
		{ date: '2026-06-21', m: { sleep_min: 450, sleep_resting_hr: 57 } },
		{ date: '2026-06-20', m: { sleep_min: 450, sleep_resting_hr: 58 } }
	];
	const byKey = Object.fromEntries(sleepTrends(nights, {}, 'America/New_York').map((i) => [i.key, i]));
	assert.equal(byKey['rhr-trend'].status, 'good'); // recent half lower → improving
	assert.ok(byKey['rhr-trend'].value.startsWith('▼'));
}

// sleepTrends: awakenings + consistency populate when stages exist (tz-stable).
{
	const stagesByDate: StagesByDate = {
		'2026-06-23': {
			startAt: '2026-06-23T03:00:00Z', // 23:00 prior day in America/New_York (EDT -4)
			endAt: '2026-06-23T11:00:00Z',
			segments: [
				{ stage: 'LIGHT', startMin: 0, durationMin: 120 },
				{ stage: 'AWAKE', startMin: 120, durationMin: 8 },
				{ stage: 'DEEP', startMin: 128, durationMin: 90 }
			]
		},
		'2026-06-22': {
			startAt: '2026-06-22T04:30:00Z', // 00:30 in EDT
			endAt: '2026-06-22T12:00:00Z',
			segments: [
				{ stage: 'LIGHT', startMin: 0, durationMin: 200 },
				{ stage: 'AWAKE', startMin: 200, durationMin: 6 }
			]
		}
	};
	const nights: Night[] = [
		{ date: '2026-06-23', m: { sleep_min: 450 } },
		{ date: '2026-06-22', m: { sleep_min: 450 } }
	];
	const byKey = Object.fromEntries(sleepTrends(nights, stagesByDate, 'America/New_York').map((i) => [i.key, i]));
	assert.equal(byKey.awakenings.value, '1 / night'); // 1 AWAKE seg each
	// Onsets 23:00 & 00:30 → 90 min apart → small noon-origin spread, not ~22h.
	assert.ok(byKey.consistency, 'consistency card should exist');
	const spread = Number(byKey.consistency.value.replace(/[^\d]/g, ''));
	assert.ok(spread < 60, `onset spread should be small (got ${spread})`);
}

console.log('sleepInsights.selfcheck: OK');
