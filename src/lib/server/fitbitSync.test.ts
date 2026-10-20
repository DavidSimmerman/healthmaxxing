import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// syncHealth end to end against a real database, with Google's API faked at fetch():
// paging is followed to the last page, a rejected sleep filter falls back to the old
// unfiltered read instead of losing sleep, and the raw HRV/SpO2 readings land in
// vital_samples. Writes a fitbit_auth row and sample rows, so it only runs against an
// EMPTY database (no fitbit_auth row yet). Skipped without DATABASE_URL.
const url = process.env.DATABASE_URL;

const FIT = { dataSource: { platform: 'FITBIT' } };

describe.skipIf(!url)('fitbit sync', () => {
	let sql: any; // eslint-disable-line @typescript-eslint/no-explicit-any
	let empty = false;
	let today = '';
	let night = '';
	const calls: string[] = [];

	beforeAll(async () => {
		const { default: postgres } = await import('postgres');
		sql = postgres(url!, { max: 1 });
		empty = Number((await sql`SELECT count(*)::int AS n FROM fitbit_auth`)[0].n) === 0;
		if (!empty) return;
		await sql`INSERT INTO fitbit_auth (id, refresh_token) VALUES (1, 'test-refresh')`;
		const { todayLabel } = await import('./day');
		today = todayLabel();
		night = today;
		const wake = new Date(`${today}T11:00:00Z`); // 7 AM EDT
		const iso = (minsBeforeWake: number) =>
			new Date(wake.getTime() - minsBeforeWake * 60_000).toISOString();

		// 3 pages of SpO2: one reading a minute through the night, split by pageToken.
		const spo2Pages = [0, 1, 2].map((p) => ({
			dataPoints: Array.from({ length: 100 }, (_, i) => ({
				...FIT,
				oxygenSaturation: {
					sampleTime: { physicalTime: iso(400 - (p * 100 + i)) },
					percentage: 95 + (i % 3)
				}
			})),
			...(p < 2 ? { nextPageToken: `spo2-${p + 1}` } : {})
		}));

		vi.stubGlobal('fetch', async (input: string | URL) => {
			const u = String(input);
			calls.push(u);
			const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
			if (u.startsWith('https://oauth2.googleapis.com/token'))
				return ok({ access_token: 'tok', expires_in: 3600 });
			const type = u.match(/dataTypes\/([^/]+)\//)?.[1];
			const pageToken = new URL(u).searchParams.get('pageToken');
			const filter = new URL(u).searchParams.get('filter') ?? '';
			switch (type) {
				case 'sleep':
					// Pretend Google rejects the end_time filter → the sync must fall back.
					if (filter) return new Response('{"error":"INVALID_DATA_POINT_FILTER"}', { status: 400 });
					return ok({
						dataPoints: [
							{
								...FIT,
								sleep: {
									interval: { startTime: iso(480), endTime: wake.toISOString() },
									summary: {
										minutesInSleepPeriod: '480',
										minutesAsleep: '450',
										minutesAwake: '30',
										minutesToFallAsleep: '9',
										stagesSummary: [{ type: 'DEEP', minutes: '85' }]
									},
									shortAwakenings: [
										{ startTime: iso(200), endTime: iso(199), type: 'AWAKE' },
										{ startTime: iso(100), endTime: iso(99), type: 'AWAKE' }
									]
								}
							}
						]
					});
				case 'oxygen-saturation':
					return ok(spo2Pages[pageToken ? Number(pageToken.split('-')[1]) : 0]);
				case 'heart-rate-variability':
					return ok({
						dataPoints: [
							{
								...FIT,
								heartRateVariability: {
									sampleTime: { physicalTime: iso(300) },
									rootMeanSquareOfSuccessiveDifferencesMilliseconds: 64,
									standardDeviationMilliseconds: 70
								}
							}
						]
					});
				default:
					return ok({ dataPoints: [] });
			}
		});
	});

	afterAll(async () => {
		vi.unstubAllGlobals();
		await sql?.end();
	});

	it('pages every sample, falls back on a rejected sleep filter, stores raw readings', async () => {
		if (!empty) return;
		const { syncHealth } = await import('./fitbit');
		const result = await syncHealth(2);

		// All 3 SpO2 pages were requested.
		expect(calls.filter((c) => c.includes('oxygen-saturation'))).toHaveLength(3);
		// Sleep was tried filtered, then unfiltered.
		const sleepCalls = calls.filter((c) => c.includes('/sleep/'));
		expect(sleepCalls).toHaveLength(2);
		expect(sleepCalls[0]).toContain('filter=');
		expect(sleepCalls[1]).not.toContain('filter=');

		// 300 SpO2 + 2 HRV fields → 302 raw rows.
		expect(result.samples).toBe(302);
		const rows =
			await sql`SELECT metric, count(*)::int AS n FROM vital_samples GROUP BY metric ORDER BY metric`;
		expect(rows).toEqual([
			{ metric: 'hrv_rmssd_ms', n: 1 },
			{ metric: 'hrv_sdnn_ms', n: 1 },
			{ metric: 'spo2_pct', n: 300 }
		]);

		// The sleep extras made it into daily_metrics on the wake date.
		const m = new Map(
			(await sql`SELECT metric, value FROM daily_metrics WHERE date = ${night}`).map(
				(r: { metric: string; value: number }) => [r.metric, r.value]
			)
		);
		expect(m.get('sleep_onset_min')).toBe(9);
		expect(m.get('sleep_short_awakenings')).toBe(2);
		expect(m.get('sleep_hrv_ms')).toBe(64);

		// Re-running is idempotent: no duplicate raw rows.
		calls.length = 0;
		await syncHealth(2);
		expect(Number((await sql`SELECT count(*)::int AS n FROM vital_samples`)[0].n)).toBe(302);
	});
});
