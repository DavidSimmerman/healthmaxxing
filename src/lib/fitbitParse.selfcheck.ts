// Runnable check for the Google Health → metrics mapping:
//   npx tsx src/lib/fitbitParse.selfcheck.ts
// No test framework — just asserts. Exits non-zero on failure.
// Shapes mirror real responses captured via the sync's {"debug":true} mode
// (note: minute totals come as int64 → JSON STRINGS).
import assert from 'node:assert/strict';
import { parseHealthData } from './fitbitParse.ts';

const TZ = 'America/New_York'; // EDT (-4) in June
const FIT = { dataSource: { platform: 'FITBIT' } };
const APPLE = { dataSource: { platform: 'HEALTH_KIT' } };

// One sleep session ending 7am EDT on 2026-06-22. asleep 414 / inBed 450 = 92%.
const sleepSession = (endIso: string, asleep: string, inBed: string, awake: string, stages: [string, string][]) => ({
	...FIT,
	sleep: {
		interval: { startTime: '2026-06-22T03:00:00Z', endTime: endIso },
		type: 'STAGES',
		summary: {
			minutesInSleepPeriod: inBed,
			minutesAsleep: asleep,
			minutesAwake: awake,
			stagesSummary: stages.map(([type, minutes]) => ({ type, minutes }))
		}
	}
});

const rows = parseHealthData(
	{
		sleep: {
			dataPoints: [
				sleepSession('2026-06-22T11:00:00Z', '414', '450', '36', [
					['DEEP', '80'],
					['LIGHT', '234'],
					['REM', '100'],
					['AWAKE', '36']
				])
			]
		},
		// beatsPerMinute is an int64 → JSON STRING. Plus an Apple point that must be dropped.
		restingHr: {
			dataPoints: [
				{ ...FIT, dailyRestingHeartRate: { date: { year: 2026, month: 6, day: 22 }, beatsPerMinute: '54' } },
				{ ...APPLE, dailyRestingHeartRate: { date: { year: 2026, month: 6, day: 22 }, beatsPerMinute: '70' } }
			]
		},
		respRate: {
			dataPoints: [{ ...FIT, dailyRespiratoryRate: { date: { year: 2026, month: 6, day: 22 }, breathsPerMinute: 15.7 } }]
		},
		skinTemp: {
			dataPoints: [
				{
					...FIT,
					dailySleepTemperatureDerivations: {
						date: { year: 2026, month: 6, day: 22 },
						nightlyTemperatureCelsius: 36.1,
						baselineTemperatureCelsius: 36.5 // dev = -0.4
					}
				}
			]
		},
		hrv: {
			dataPoints: [
				{ ...FIT, heartRateVariability: { sampleTime: { physicalTime: '2026-06-22T05:00:00Z' }, rootMeanSquareOfSuccessiveDifferencesMilliseconds: 40 } },
				{ ...FIT, heartRateVariability: { sampleTime: { physicalTime: '2026-06-22T06:00:00Z' }, rootMeanSquareOfSuccessiveDifferencesMilliseconds: 44 } },
				// Apple HRV sample on the same night must NOT pull the average:
				{ ...APPLE, heartRateVariability: { sampleTime: { physicalTime: '2026-06-22T05:30:00Z' }, rootMeanSquareOfSuccessiveDifferencesMilliseconds: 999 } }
			]
		},
		spo2: {
			dataPoints: [
				{ ...FIT, oxygenSaturation: { sampleTime: { physicalTime: '2026-06-22T05:00:00Z' }, percentage: 96 } },
				{ ...FIT, oxygenSaturation: { sampleTime: { physicalTime: '2026-06-22T06:00:00Z' }, percentage: 97 } },
				// non-physiological noise read — must be dropped (floor 70), not averaged in:
				{ ...FIT, oxygenSaturation: { sampleTime: { physicalTime: '2026-06-22T06:30:00Z' }, percentage: 50 } }
			]
		}
	},
	TZ
);

const m = Object.fromEntries(rows.map((r) => [r.metric, r.value]));
assert.equal(m.sleep_min, 414); // minutesAsleep "414"
assert.equal(m.time_in_bed_min, 450);
assert.equal(m.sleep_awake_min, 36);
assert.equal(m.sleep_efficiency_pct, 92); // 414/450*100
assert.equal(m.sleep_deep_min, 80);
assert.equal(m.sleep_light_min, 234);
assert.equal(m.sleep_rem_min, 100);
assert.equal(m.sleep_resting_hr, 54); // "54" string parsed, Apple "70" dropped
assert.equal(m.sleep_resp_rate, 15.7);
assert.equal(Math.round(m.sleep_skin_temp_dev_c * 10) / 10, -0.4);
assert.equal(m.sleep_hrv_ms, 42); // (40+44)/2, Apple 999 excluded
assert.equal(m.sleep_spo2_pct, 96.5);
assert.equal(rows.every((r) => r.date === '2026-06-22'), true);

// An Apple-only payload yields nothing (platform filter).
assert.deepEqual(
	parseHealthData({ restingHr: { dataPoints: [{ ...APPLE, dailyRestingHeartRate: { date: { year: 2026, month: 6, day: 22 }, beatsPerMinute: '70' } }] } }, TZ),
	[]
);

// Pre-dawn UTC-next-day sample buckets to the local night's date.
const cross = parseHealthData(
	{ spo2: { dataPoints: [{ ...FIT, oxygenSaturation: { sampleTime: { physicalTime: '2026-06-22T03:30:00Z' }, percentage: 95 } }] } },
	TZ
);
assert.deepEqual(cross, [{ date: '2026-06-21', metric: 'sleep_spo2_pct', value: 95 }]);

// Multiple sleep sessions on one date fold to ONE row per (date, metric):
// durations sum, efficiency averages.
const two = parseHealthData(
	{
		sleep: {
			dataPoints: [
				sleepSession('2026-06-22T11:00:00Z', '360', '400', '40', []), // eff 90
				sleepSession('2026-06-22T18:00:00Z', '35', '50', '15', []) // nap, eff 70
			]
		}
	},
	TZ
);
const keys = two.map((r) => `${r.date} ${r.metric}`);
assert.equal(new Set(keys).size, keys.length, 'no duplicate (date,metric) rows');
const tm = Object.fromEntries(two.map((r) => [r.metric, r.value]));
assert.equal(tm.sleep_min, 395); // 360 + 35 summed
assert.equal(tm.sleep_efficiency_pct, 80); // (90 + 70) / 2 averaged

// Empty / missing → no rows, no throw.
assert.deepEqual(parseHealthData({}, TZ), []);

console.log('fitbitParse.selfcheck: OK');
