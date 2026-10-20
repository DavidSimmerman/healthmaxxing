// Runnable check for the Google Health → metrics mapping:
//   npx tsx src/lib/fitbitParse.selfcheck.ts
// No test framework — just asserts. Exits non-zero on failure.
// Shapes mirror real responses captured via the sync's {"debug":true} mode
// (note: minute totals come as int64 → JSON STRINGS).
import assert from 'node:assert/strict';
import { parseHealthData, parseSleepSessions, parseVitalSamples } from './fitbitParse.ts';

const TZ = 'America/New_York'; // EDT (-4) in June
const FIT = { dataSource: { platform: 'FITBIT' } };
const APPLE = { dataSource: { platform: 'HEALTH_KIT' } };

// One sleep session ending 7am EDT on 2026-06-22. asleep 414 / inBed 450 = 92%.
const sleepSession = (
	endIso: string,
	asleep: string,
	inBed: string,
	awake: string,
	stages: [string, string][],
	startIso = '2026-06-22T03:00:00Z'
) => ({
	...FIT,
	sleep: {
		interval: { startTime: startIso, endTime: endIso },
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
				{
					...FIT,
					dailyRestingHeartRate: { date: { year: 2026, month: 6, day: 22 }, beatsPerMinute: '54' }
				},
				{
					...APPLE,
					dailyRestingHeartRate: { date: { year: 2026, month: 6, day: 22 }, beatsPerMinute: '70' }
				}
			]
		},
		respRate: {
			dataPoints: [
				{
					...FIT,
					dailyRespiratoryRate: { date: { year: 2026, month: 6, day: 22 }, breathsPerMinute: 15.7 }
				}
			]
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
				{
					...FIT,
					heartRateVariability: {
						sampleTime: { physicalTime: '2026-06-22T05:00:00Z' },
						rootMeanSquareOfSuccessiveDifferencesMilliseconds: 40
					}
				},
				{
					...FIT,
					heartRateVariability: {
						sampleTime: { physicalTime: '2026-06-22T06:00:00Z' },
						rootMeanSquareOfSuccessiveDifferencesMilliseconds: 44
					}
				},
				// Apple HRV sample on the same night must NOT pull the average:
				{
					...APPLE,
					heartRateVariability: {
						sampleTime: { physicalTime: '2026-06-22T05:30:00Z' },
						rootMeanSquareOfSuccessiveDifferencesMilliseconds: 999
					}
				}
			]
		},
		spo2: {
			dataPoints: [
				{
					...FIT,
					oxygenSaturation: { sampleTime: { physicalTime: '2026-06-22T05:00:00Z' }, percentage: 96 }
				},
				{
					...FIT,
					oxygenSaturation: { sampleTime: { physicalTime: '2026-06-22T06:00:00Z' }, percentage: 97 }
				},
				// non-physiological noise read — must be dropped (floor 70), not averaged in:
				{
					...FIT,
					oxygenSaturation: { sampleTime: { physicalTime: '2026-06-22T06:30:00Z' }, percentage: 50 }
				}
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
assert.equal(
	rows.every((r) => r.date === '2026-06-22'),
	true
);

// An Apple-only payload yields nothing (platform filter).
assert.deepEqual(
	parseHealthData(
		{
			restingHr: {
				dataPoints: [
					{
						...APPLE,
						dailyRestingHeartRate: { date: { year: 2026, month: 6, day: 22 }, beatsPerMinute: '70' }
					}
				]
			}
		},
		TZ
	),
	[]
);

// Pre-dawn UTC-next-day sample buckets to the local night's date.
const cross = parseHealthData(
	{
		spo2: {
			dataPoints: [
				{
					...FIT,
					oxygenSaturation: { sampleTime: { physicalTime: '2026-06-22T03:30:00Z' }, percentage: 95 }
				}
			]
		}
	},
	TZ
);
assert.deepEqual(cross, [{ date: '2026-06-21', metric: 'sleep_spo2_pct', value: 95 }]);

// Multiple sleep sessions on one date → ONE row per (date, metric), from the
// LONGEST session only (a nap never inflates the night's totals).
const two = parseHealthData(
	{
		sleep: {
			dataPoints: [
				sleepSession('2026-06-22T11:00:00Z', '360', '400', '40', []), // 8h interval, eff 90
				sleepSession('2026-06-22T18:00:00Z', '35', '50', '15', [], '2026-06-22T17:10:00Z') // 50m nap
			]
		}
	},
	TZ
);
const keys = two.map((r) => `${r.date} ${r.metric}`);
assert.equal(new Set(keys).size, keys.length, 'no duplicate (date,metric) rows');
const tm = Object.fromEntries(two.map((r) => [r.metric, r.value]));
assert.equal(tm.sleep_min, 360); // main sleep only — the nap is discarded
assert.equal(tm.sleep_efficiency_pct, 90);

// Empty / missing → no rows, no throw.
assert.deepEqual(parseHealthData({}, TZ), []);

// parseSleepSessions: build the hypnogram timeline; keep the LONGEST session per
// wake date (main sleep, not a nap), with minute offsets from sleep start.
{
	const sess = parseSleepSessions(
		{
			dataPoints: [
				// a short nap earlier the same wake date — must be discarded
				{
					...FIT,
					sleep: {
						interval: { startTime: '2026-06-22T18:00:00Z', endTime: '2026-06-22T18:30:00Z' },
						stages: [
							{ startTime: '2026-06-22T18:00:00Z', endTime: '2026-06-22T18:30:00Z', type: 'LIGHT' }
						]
					}
				},
				// the main sleep
				{
					...FIT,
					sleep: {
						interval: { startTime: '2026-06-22T04:00:00Z', endTime: '2026-06-22T11:00:00Z' },
						stages: [
							{ startTime: '2026-06-22T04:00:00Z', endTime: '2026-06-22T04:30:00Z', type: 'LIGHT' },
							{ startTime: '2026-06-22T04:30:00Z', endTime: '2026-06-22T05:30:00Z', type: 'DEEP' }
						]
					}
				}
			]
		},
		TZ
	);
	assert.equal(sess.length, 1);
	assert.equal(sess[0].date, '2026-06-22');
	assert.equal(sess[0].source, 'fitbit');
	assert.equal(sess[0].segments.length, 2); // the 7h main session, not the nap
	assert.deepEqual(sess[0].segments[1], { stage: 'DEEP', startMin: 30, durationMin: 60 });
}
assert.deepEqual(parseSleepSessions({}, TZ), []);

// ── Apple Watch as the backup sleep source ────────────────────────────────
// One night, one device: the longest session wins, ties go to Fitbit. Never a
// merge of the two, so nothing can be double-counted.
const night = (
	platform: typeof FIT | typeof APPLE,
	start: string,
	end: string,
	stages: [string, string, string][] = []
) => ({
	...platform,
	sleep: {
		interval: { startTime: start, endTime: end },
		stages: stages.map(([type, s, e]) => ({ type, startTime: s, endTime: e }))
	}
});
const one = (points: unknown[]) => {
	const s = parseSleepSessions({ dataPoints: points }, TZ);
	assert.equal(s.length, 1, 'exactly one session per night');
	return s[0];
};

// Fitbit only → Fitbit wins.
assert.equal(one([night(FIT, '2026-06-22T03:00:00Z', '2026-06-22T11:00:00Z')]).source, 'fitbit');
// Apple only (the forgot-to-swap night) → Apple is kept, not dropped.
assert.equal(one([night(APPLE, '2026-06-22T03:00:00Z', '2026-06-22T11:00:00Z')]).source, 'apple');
// Both worn, overlapping, Fitbit longer → Fitbit, exactly one row.
assert.equal(
	one([
		night(FIT, '2026-06-22T03:00:00Z', '2026-06-22T11:00:00Z'),
		night(APPLE, '2026-06-22T03:30:00Z', '2026-06-22T10:30:00Z')
	]).source,
	'fitbit'
);
// Exactly equal duration → tie goes to Fitbit (today's behaviour), either order.
for (const order of [0, 1]) {
	const pts = [
		night(APPLE, '2026-06-22T03:00:00Z', '2026-06-22T11:00:00Z'),
		night(FIT, '2026-06-22T03:00:00Z', '2026-06-22T11:00:00Z')
	];
	assert.equal(one(order ? pts.reverse() : pts).source, 'fitbit');
}
// Fitbit stub (band on the nightstand) vs a real Apple night → Apple wins.
assert.equal(
	one([
		night(FIT, '2026-06-22T06:00:00Z', '2026-06-22T06:20:00Z'), // 20m of wear, 2am local
		night(APPLE, '2026-06-22T03:00:00Z', '2026-06-22T11:00:00Z')
	]).source,
	'apple'
);
// Apple stage names: CORE ≙ light; IN_BED spans the whole night and must be
// dropped (counting it would double the night).
{
	const appleStaged = night(APPLE, '2026-06-22T03:00:00Z', '2026-06-22T05:00:00Z', [
		['IN_BED', '2026-06-22T03:00:00Z', '2026-06-22T05:00:00Z'],
		['CORE', '2026-06-22T03:00:00Z', '2026-06-22T04:00:00Z'],
		['DEEP', '2026-06-22T04:00:00Z', '2026-06-22T04:30:00Z'],
		['AWAKE', '2026-06-22T04:30:00Z', '2026-06-22T05:00:00Z']
	]);
	const s = one([appleStaged]);
	assert.deepEqual(
		s.segments.map((x) => x.stage),
		['LIGHT', 'DEEP', 'AWAKE']
	);
	const am = Object.fromEntries(
		parseHealthData({ sleep: { dataPoints: [appleStaged] } }, TZ).map((r) => [r.metric, r.value])
	);
	assert.equal(am.time_in_bed_min, 120);
	assert.equal(am.sleep_min, 90); // 60 light + 30 deep — IN_BED not counted twice
	assert.equal(am.sleep_awake_min, 30);
	assert.equal(am.sleep_light_min, 60);
	assert.equal(am.sleep_deep_min, 30);
	assert.equal(am.sleep_efficiency_pct, 75);
	assert.equal(am.sleep_resting_hr, undefined); // Fitbit-only metrics stay absent
}
// Apple session with NO stage breakdown → one solid asleep block + sane minutes,
// and no fabricated efficiency/awake split.
{
	const s = one([night(APPLE, '2026-06-22T03:00:00Z', '2026-06-22T11:00:00Z')]);
	assert.deepEqual(s.segments, [{ stage: 'ASLEEP', startMin: 0, durationMin: 480 }]);
	const am = Object.fromEntries(
		parseHealthData(
			{ sleep: { dataPoints: [night(APPLE, '2026-06-22T03:00:00Z', '2026-06-22T11:00:00Z')] } },
			TZ
		).map((r) => [r.metric, r.value])
	);
	assert.equal(am.sleep_min, 480);
	assert.equal(am.time_in_bed_min, 480);
	assert.equal(am.sleep_efficiency_pct, undefined);
	assert.equal(am.sleep_awake_min, undefined);
}
// The winning session drives the aggregates too: an Apple night that beats a
// Fitbit stub reports Apple's minutes, not the stub's, and never their sum.
{
	const rows2 = parseHealthData(
		{
			sleep: {
				dataPoints: [
					// 20-minute Fitbit stub, same wake date as the Apple night
					sleepSession(
						'2026-06-22T06:20:00Z',
						'18',
						'20',
						'2',
						[['LIGHT', '18']],
						'2026-06-22T06:00:00Z'
					),
					night(APPLE, '2026-06-22T03:00:00Z', '2026-06-22T11:00:00Z')
				]
			}
		},
		TZ
	);
	const mixed = Object.fromEntries(rows2.map((r) => [r.metric, r.value]));
	assert.equal(rows2.filter((r) => r.metric === 'sleep_min').length, 1, 'one sleep_min row');
	assert.equal(mixed.sleep_min, 480); // Apple's night, not the stub and not their sum
	assert.equal(mixed.sleep_light_min, undefined); // the stub's breakdown doesn't leak in
}

// On an Apple-won night the Fitbit-only vitals must NOT come along: the band was
// on during the day, so Google still reports a daily resting HR / HRV for that
// date. Cross-sourcing them onto an Apple night would be inventing a night.
{
	const day = { year: 2026, month: 6, day: 22 };
	const vitals = {
		restingHr: {
			dataPoints: [{ ...FIT, dailyRestingHeartRate: { date: day, beatsPerMinute: '54' } }]
		},
		respRate: {
			dataPoints: [{ ...FIT, dailyRespiratoryRate: { date: day, breathsPerMinute: 15.7 } }]
		},
		skinTemp: {
			dataPoints: [
				{
					...FIT,
					dailySleepTemperatureDerivations: {
						date: day,
						nightlyTemperatureCelsius: 36.1,
						baselineTemperatureCelsius: 36.5
					}
				}
			]
		},
		hrv: {
			dataPoints: [
				{
					...FIT,
					heartRateVariability: {
						sampleTime: { physicalTime: '2026-06-22T05:00:00Z' },
						rootMeanSquareOfSuccessiveDifferencesMilliseconds: 40
					}
				}
			]
		},
		spo2: {
			dataPoints: [
				{
					...FIT,
					oxygenSaturation: { sampleTime: { physicalTime: '2026-06-22T05:00:00Z' }, percentage: 96 }
				}
			]
		}
	};
	const appleNight = Object.fromEntries(
		parseHealthData(
			{
				sleep: { dataPoints: [night(APPLE, '2026-06-22T03:00:00Z', '2026-06-22T11:00:00Z')] },
				...vitals
			},
			TZ
		).map((r) => [r.metric, r.value])
	);
	assert.equal(appleNight.sleep_min, 480);
	for (const k of [
		'sleep_resting_hr',
		'sleep_resp_rate',
		'sleep_skin_temp_dev_c',
		'sleep_hrv_ms',
		'sleep_spo2_pct'
	]) {
		assert.equal(appleNight[k], undefined, `${k} must be absent on an Apple night`);
	}
	// Same vitals on a Fitbit night still land (the suppression is per night).
	const fitbitNight = Object.fromEntries(
		parseHealthData(
			{
				sleep: { dataPoints: [sleepSession('2026-06-22T11:00:00Z', '414', '450', '36', [])] },
				...vitals
			},
			TZ
		).map((r) => [r.metric, r.value])
	);
	assert.equal(fitbitNight.sleep_resting_hr, 54);
	assert.equal(fitbitNight.sleep_hrv_ms, 40);
}

// A session whose only stages are in-bed markers tracked time in bed, not sleep —
// reporting it as a night's sleep would over-report it, so it's dropped entirely.
{
	const inBedOnly = [
		night(APPLE, '2026-06-22T03:00:00Z', '2026-06-22T11:00:00Z', [
			['IN_BED', '2026-06-22T03:00:00Z', '2026-06-22T11:00:00Z']
		])
	];
	assert.deepEqual(parseSleepSessions({ dataPoints: inBedOnly }, TZ), []);
	assert.deepEqual(parseHealthData({ sleep: { dataPoints: inBedOnly } }, TZ), []);
}

// One undifferentiated "asleep" stretch: minutes yes, awake/efficiency no.
{
	const asleepOnly = Object.fromEntries(
		parseHealthData(
			{
				sleep: {
					dataPoints: [
						night(APPLE, '2026-06-22T03:00:00Z', '2026-06-22T11:00:00Z', [
							['ASLEEP_UNSPECIFIED', '2026-06-22T03:30:00Z', '2026-06-22T10:30:00Z']
						])
					]
				}
			},
			TZ
		).map((r) => [r.metric, r.value])
	);
	assert.equal(asleepOnly.sleep_min, 420); // the 7h stretch, not the 8h in bed
	assert.equal(asleepOnly.time_in_bed_min, 480);
	assert.equal(asleepOnly.sleep_efficiency_pct, undefined);
	assert.equal(asleepOnly.sleep_awake_min, undefined);
}

// ── Restlessness, onset, nightly HRV summary, per-stage breathing, raw samples ──────
{
	const night = {
		...FIT,
		sleep: {
			// 11:00 PM → 7:00 AM EDT, wake date 2026-06-22.
			interval: { startTime: '2026-06-22T03:00:00Z', endTime: '2026-06-22T11:00:00Z' },
			summary: {
				minutesInSleepPeriod: '480',
				minutesAsleep: '440',
				minutesAwake: '40',
				minutesToFallAsleep: '12',
				stagesSummary: [{ type: 'DEEP', minutes: '90' }]
			},
			shortAwakenings: [
				{ startTime: '2026-06-22T05:00:00Z', endTime: '2026-06-22T05:01:00Z', type: 'AWAKE' },
				{ startTime: '2026-06-22T07:00:00Z', endTime: '2026-06-22T07:02:00Z', type: 'AWAKE' },
				{ startTime: '2026-06-22T08:30:00Z', endTime: '2026-06-22T08:31:00Z', type: 'AWAKE' }
			],
			outOfBedSegments: [{ startTime: '2026-06-22T06:00:00Z', endTime: '2026-06-22T06:04:00Z' }]
		}
	};
	const raw = {
		sleep: { dataPoints: [night] },
		dailyHrv: {
			dataPoints: [
				{
					...FIT,
					dailyHeartRateVariability: {
						date: { year: 2026, month: 6, day: 22 },
						averageHeartRateVariabilityMilliseconds: 61.5,
						deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds: 72.1,
						nonRemHeartRateBeatsPerMinute: '52', // int64 → string
						entropy: 2.4
					}
				}
			]
		},
		respSummary: {
			dataPoints: [
				{
					...FIT,
					respiratoryRateSleepSummary: {
						// 11:30 PM EDT on the 21st — inside the night, so it's the 22nd's.
						sampleTime: { physicalTime: '2026-06-22T03:30:00Z' },
						deepSleepStats: { breathsPerMinute: 13.1 },
						lightSleepStats: { breathsPerMinute: 14.2 },
						remSleepStats: { breathsPerMinute: 15.0 },
						fullSleepStats: { breathsPerMinute: 14.1 }
					}
				}
			]
		},
		hrv: {
			dataPoints: [
				{
					...FIT,
					heartRateVariability: {
						// 11:40 PM EDT on the 21st: belongs to the night that wakes on the 22nd.
						sampleTime: { physicalTime: '2026-06-22T03:40:00Z' },
						rootMeanSquareOfSuccessiveDifferencesMilliseconds: 50,
						standardDeviationMilliseconds: 60,
						metadata: { lowFrequencyPower: 900, highFrequencyPower: 400 }
					}
				},
				{
					...FIT,
					heartRateVariability: {
						sampleTime: { physicalTime: '2026-06-22T08:00:00Z' },
						rootMeanSquareOfSuccessiveDifferencesMilliseconds: 70
					}
				}
			]
		},
		spo2: {
			dataPoints: [
				{
					...FIT,
					oxygenSaturation: { sampleTime: { physicalTime: '2026-06-22T06:00:00Z' }, percentage: 96 }
				},
				{
					...FIT,
					oxygenSaturation: { sampleTime: { physicalTime: '2026-06-22T06:01:00Z' }, percentage: 50 }
				}, // non-wear
				{
					...APPLE,
					oxygenSaturation: { sampleTime: { physicalTime: '2026-06-22T06:02:00Z' }, percentage: 99 }
				}
			]
		},
		skinTemp: {
			dataPoints: [
				{
					...FIT,
					dailySleepTemperatureDerivations: {
						date: { year: 2026, month: 6, day: 22 },
						nightlyTemperatureCelsius: 34.2,
						baselineTemperatureCelsius: 34.0,
						relativeNightlyStddev30dCelsius: 0.15
					}
				}
			]
		}
	};
	const m = new Map(
		parseHealthData(raw, TZ)
			.filter((r) => r.date === '2026-06-22')
			.map((r) => [r.metric, r.value])
	);
	assert.equal(m.get('sleep_onset_min'), 12);
	assert.equal(m.get('sleep_short_awakenings'), 3);
	assert.equal(m.get('sleep_out_of_bed_count'), 1);
	assert.equal(m.get('sleep_out_of_bed_min'), 4);
	assert.equal(m.get('sleep_hrv_daily_ms'), 61.5);
	assert.equal(m.get('sleep_hrv_deep_ms'), 72.1);
	assert.equal(m.get('sleep_nonrem_hr'), 52);
	assert.equal(m.get('sleep_hrv_entropy'), 2.4);
	assert.equal(m.get('sleep_resp_deep'), 13.1);
	assert.equal(m.get('sleep_resp_full'), 14.1);
	assert.equal(m.get('sleep_skin_temp_sd30_c'), 0.15);
	// Both HRV samples (incl. the one before midnight) average into the 22nd's night.
	assert.equal(m.get('sleep_hrv_ms'), 60);
	assert.equal(m.get('sleep_spo2_pct'), 96);

	// Raw series: 4 HRV fields off the first sample, RMSSD only off the second, one SpO2
	// (non-wear floored out, Apple dropped).
	const samples = parseVitalSamples(raw);
	const count = (metric: string) => samples.filter((x) => x.metric === metric).length;
	assert.equal(count('hrv_rmssd_ms'), 2);
	assert.equal(count('hrv_sdnn_ms'), 1);
	assert.equal(count('hrv_lf_power'), 1);
	assert.equal(count('hrv_hf_power'), 1);
	assert.deepEqual(
		samples.filter((x) => x.metric === 'spo2_pct').map((x) => x.value),
		[96]
	);

	// An Apple-won night gets NONE of the Fitbit-only extras (no invented zeros either).
	const appleNight = {
		...APPLE,
		sleep: {
			interval: { startTime: '2026-06-22T02:00:00Z', endTime: '2026-06-22T11:30:00Z' }, // longer → wins
			stages: [{ startTime: '2026-06-22T02:00:00Z', endTime: '2026-06-22T11:30:00Z', type: 'CORE' }]
		}
	};
	const a = new Set(
		parseHealthData({ ...raw, sleep: { dataPoints: [night, appleNight] } }, TZ)
			.filter((r) => r.date === '2026-06-22')
			.map((r) => r.metric)
	);
	for (const k of [
		'sleep_onset_min',
		'sleep_short_awakenings',
		'sleep_hrv_deep_ms',
		'sleep_resp_deep',
		'sleep_hrv_ms'
	])
		assert(!a.has(k), `${k} must not attach to an Apple night`);
}

console.log('fitbitParse.selfcheck: OK');
