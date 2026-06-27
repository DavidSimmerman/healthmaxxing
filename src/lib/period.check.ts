// Runnable check: npx tsx src/lib/period.check.ts
import { weekToDate } from './period';
import assert from 'node:assert';

// 2026-06-22 is a Monday; the week's Sunday is 2026-06-21.
assert.deepEqual(weekToDate('2026-06-22'), { from: '2026-06-21', to: '2026-06-22' }); // Mon → Sun..Mon
assert.deepEqual(weekToDate('2026-06-23'), { from: '2026-06-21', to: '2026-06-23' }); // Tue → Sun..Tue
assert.deepEqual(weekToDate('2026-06-24'), { from: '2026-06-21', to: '2026-06-24' }); // Wed → Sun..Wed
assert.deepEqual(weekToDate('2026-06-21'), { from: '2026-06-21', to: '2026-06-21' }); // Sun → itself
assert.deepEqual(weekToDate('2026-06-27'), { from: '2026-06-21', to: '2026-06-27' }); // Sat → full week
assert.throws(() => weekToDate('2026-02-31')); // impossible date rejected

console.log('period.check ok');
