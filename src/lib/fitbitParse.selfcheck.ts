// Runnable check for the Google Health → metrics mapping:
//   npx tsx src/lib/fitbitParse.selfcheck.ts
// No test framework — just asserts. Exits non-zero on failure.
import assert from 'node:assert/strict';
import { parseHealthData } from './fitbitParse.ts';

const TZ = 'America/New_York'; // EDT (-4) in June

const rows = parseHealthData(
	{
		sleep: {
			dataPoints: [
				{
					sleep: {
						sessionEndTime: { physicalTime: '2026-06-22T11:00:00Z' }, // 7am EDT → 2026-06-22
						sleepSummary: {
							totalSleepDuration: '24900s', // 415 min
							timeInBed: '26880s', // 448 min
							sleepEfficiency: 0.92, // fraction → 92%
							stageSummary: [
								{ stage: 'SLEEP_STAGE_TYPE_DEEP', duration: '4800s' }, // 80
								{ stage: 'SLEEP_STAGE_TYPE_LIGHT', duration: '13800s' }, // 230
								{ stage: 'SLEEP_STAGE_TYPE_REM', duration: '5700s' }, // 95
								{ stage: 'SLEEP_STAGE_TYPE_AWAKE', duration: '1980s' } // 33
							]
						}
					}
				}
			]
		},
		restingHr: {
			dataPoints: [{ dailyRestingHeartRate: { date: { year: 2026, month: 6, day: 22 }, beatsPerMinute: 54 } }]
		},
		respRate: {
			dataPoints: [{ dailyRespiratoryRate: { date: { year: 2026, month: 6, day: 22 }, breathsPerMinute: 15.7 } }]
		},
		skinTemp: {
			dataPoints: [
				{
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
				{ heartRateVariability: { sampleTime: { physicalTime: '2026-06-22T05:00:00Z' }, rmssdMilliseconds: 40 } },
				{ heartRateVariability: { sampleTime: { physicalTime: '2026-06-22T06:00:00Z' }, rmssdMilliseconds: 44 } }
			]
		},
		spo2: {
			dataPoints: [
				{ oxygenSaturation: { sampleTime: { physicalTime: '2026-06-22T05:00:00Z' }, percentage: 96 } },
				{ oxygenSaturation: { sampleTime: { physicalTime: '2026-06-22T06:00:00Z' }, percentage: 97 } }
			]
		}
	},
	TZ
);

const m = Object.fromEntries(rows.map((r) => [r.metric, r.value]));
assert.equal(m.sleep_min, 415);
assert.equal(m.time_in_bed_min, 448);
assert.equal(m.sleep_efficiency_pct, 92); // 0.92 fraction scaled to percent
assert.equal(m.sleep_deep_min, 80);
assert.equal(m.sleep_light_min, 230);
assert.equal(m.sleep_rem_min, 95);
assert.equal(m.sleep_awake_min, 33);
assert.equal(m.sleep_resting_hr, 54);
assert.equal(m.sleep_resp_rate, 15.7);
assert.equal(Math.round(m.sleep_skin_temp_dev_c * 10) / 10, -0.4); // nightly - baseline
assert.equal(m.sleep_hrv_ms, 42); // (40+44)/2
assert.equal(m.sleep_spo2_pct, 96.5); // (96+97)/2
assert.equal(rows.every((r) => r.date === '2026-06-22'), true);

// Efficiency already on a 0–100 scale must pass through unscaled.
const eff100 = parseHealthData(
	{ sleep: { dataPoints: [{ sleep: { sessionEndTime: { physicalTime: '2026-06-22T11:00:00Z' }, sleepSummary: { sleepEfficiency: 88 } } }] } },
	TZ
);
assert.equal(eff100.find((r) => r.metric === 'sleep_efficiency_pct')?.value, 88);

// A pre-dawn sample on the UTC-next-day still buckets to the local night's date.
const cross = parseHealthData(
	{ spo2: { dataPoints: [{ oxygenSaturation: { sampleTime: { physicalTime: '2026-06-22T03:30:00Z' }, percentage: 95 } }] } },
	TZ
);
// 03:30Z = 23:30 EDT on 2026-06-21
assert.deepEqual(cross, [{ date: '2026-06-21', metric: 'sleep_spo2_pct', value: 95 }]);

// Multiple sleep sessions on one local date (main sleep + nap) must fold to ONE
// row per (date, metric) — durations sum, efficiency averages — so the upsert
// can't hit the same (date, metric) conflict target twice. (P1 regression guard.)
const twoSessions = parseHealthData(
	{
		sleep: {
			dataPoints: [
				{ sleep: { sessionEndTime: { physicalTime: '2026-06-22T11:00:00Z' }, sleepSummary: { totalSleepDuration: '24000s', sleepEfficiency: 0.9 } } }, // 400m, 90%
				{ sleep: { sessionEndTime: { physicalTime: '2026-06-22T18:00:00Z' }, sleepSummary: { totalSleepDuration: '1800s', sleepEfficiency: 0.7 } } } // 30m nap, 70%
			]
		}
	},
	TZ
);
const keys = twoSessions.map((r) => `${r.date} ${r.metric}`);
assert.equal(new Set(keys).size, keys.length, 'no duplicate (date,metric) rows');
const tm = Object.fromEntries(twoSessions.map((r) => [r.metric, r.value]));
assert.equal(tm.sleep_min, 430); // 400 + 30 summed
assert.equal(tm.sleep_efficiency_pct, 80); // (90 + 70) / 2 averaged

// Empty / missing → no rows, no throw.
assert.deepEqual(parseHealthData({}, TZ), []);
assert.deepEqual(parseHealthData({ sleep: { dataPoints: [] }, hrv: null }, TZ), []);

console.log('fitbitParse.selfcheck: OK');
