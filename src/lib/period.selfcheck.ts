// Runnable check for the period->range windowing: `npx tsx src/lib/period.selfcheck.ts`.
// No test framework — just asserts. Exits non-zero on failure.
import assert from 'node:assert/strict';
import { periodRange } from './period.ts';

// day = single day; week = trailing 7; month = trailing 30. Anchor is the end.
assert.deepEqual(periodRange('day', '2026-06-23'), { from: '2026-06-23', to: '2026-06-23' });
assert.deepEqual(periodRange('week', '2026-06-23'), { from: '2026-06-17', to: '2026-06-23' });
assert.deepEqual(periodRange('month', '2026-06-23'), { from: '2026-05-25', to: '2026-06-23' });

// unknown/empty period falls back to week
assert.deepEqual(periodRange('', '2026-06-23'), { from: '2026-06-17', to: '2026-06-23' });

// crosses a month boundary correctly
assert.deepEqual(periodRange('week', '2026-03-02'), { from: '2026-02-24', to: '2026-03-02' });

// bad anchor rejected: garbage, impossible day, impossible month
assert.throws(() => periodRange('day', 'nope'));
assert.throws(() => periodRange('day', '2026-02-31')); // Feb 31 doesn't exist
assert.throws(() => periodRange('day', '2026-13-01')); // month 13 doesn't exist
assert.throws(() => periodRange('week', '2026-06-1')); // wrong shape
// a real leap day is fine
assert.deepEqual(periodRange('day', '2024-02-29'), { from: '2024-02-29', to: '2024-02-29' });

console.log('period.selfcheck: OK');
