import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

// API tests for POST /api/healthkit — the ingest endpoint the iOS wrapper app
// pushes HealthKit data to. Runs against the preview server + real dev DB;
// rows are namespaced with a test prefix / ancient dates and cleaned up via a
// direct postgres connection afterwards.

const TEST_PREFIX = 'e2e-test-';
const TEST_DAY = '1990-01-01'; // a date real syncs will never touch
const TEST_DAY_2 = '1990-01-02';

function envVar(name: string): string | undefined {
	if (process.env[name]) return process.env[name];
	try {
		const line = readFileSync('.env', 'utf8')
			.split('\n')
			.find((l) => l.startsWith(`${name}=`));
		if (!line) return undefined;
		return line
			.slice(name.length + 1)
			.trim()
			.replace(/^(['"])(.*)\1$/, '$2');
	} catch {
		return undefined;
	}
}

const token = envVar('API_TOKEN');
const auth = token ? { Authorization: `Bearer ${token}` } : {};

test.afterAll(async () => {
	const url = envVar('DATABASE_URL');
	if (!url) return;
	const { default: postgres } = await import('postgres');
	const sql = postgres(url, { max: 1 });
	try {
		await sql`DELETE FROM body_comp WHERE hk_uuid LIKE ${TEST_PREFIX + '%'}`;
		await sql`DELETE FROM activity_days WHERE date IN (${TEST_DAY}, ${TEST_DAY_2})`;
	} finally {
		await sql.end();
	}
});

test('rejects a missing/wrong bearer token when API_TOKEN is configured', async ({ request }) => {
	test.skip(!token, 'API_TOKEN not configured — auth is open in this env');
	const res = await request.post('/api/healthkit', {
		headers: { Authorization: 'Bearer wrong-token' },
		data: { days: [{ date: TEST_DAY, activeKcal: 500 }] }
	});
	expect(res.status()).toBe(401);
});

test('ingests body comp and activity days, idempotently', async ({ request }) => {
	const payload = {
		bodyComp: [
			{
				hkUuid: `${TEST_PREFIX}weighin-1`,
				measuredAt: '1990-01-01T07:30:00Z',
				weightKg: 82.4,
				bodyFatPct: 21.3,
				leanMassKg: 64.8,
				source: 'com.icomon.fitdays'
			},
			{
				// manual entry: weight only, no composition
				hkUuid: `${TEST_PREFIX}weighin-2`,
				measuredAt: '1990-01-02T07:30:00Z',
				weightKg: 82.1
			}
		],
		days: [
			{ date: TEST_DAY, activeKcal: 612.5, basalKcal: 1840.2, steps: 9543, exerciseMin: 34 },
			{ date: TEST_DAY_2, steps: 4000 }
		]
	};

	const first = await request.post('/api/healthkit', { headers: auth, data: payload });
	expect(first.ok()).toBeTruthy();
	expect(await first.json()).toEqual({ bodyComp: 2, days: 2 });

	// Re-sync of the same samples must not error or duplicate
	const second = await request.post('/api/healthkit', { headers: auth, data: payload });
	expect(second.ok()).toBeTruthy();
	expect(await second.json()).toEqual({ bodyComp: 2, days: 2 });
});

test('re-pushing a day updates its totals (today grows during the day)', async ({ request }) => {
	const morning = await request.post('/api/healthkit', {
		headers: auth,
		data: { days: [{ date: TEST_DAY, activeKcal: 100, steps: 1000 }] }
	});
	expect(morning.ok()).toBeTruthy();

	const evening = await request.post('/api/healthkit', {
		headers: auth,
		data: {
			days: [{ date: TEST_DAY, activeKcal: 750.5, basalKcal: 1900, steps: 12000, exerciseMin: 45 }]
		}
	});
	expect(evening.ok()).toBeTruthy();
	expect(await evening.json()).toEqual({ bodyComp: 0, days: 1 });
});

test('rejects malformed payloads', async ({ request }) => {
	const cases = [
		{ days: [{ date: 'not-a-date', activeKcal: 100 }] },
		{ days: [{ date: TEST_DAY, activeKcal: -5 }] },
		{ days: [{ date: TEST_DAY, steps: 9_999_999 }] },
		{ bodyComp: [{ hkUuid: `${TEST_PREFIX}bad`, measuredAt: 'garbage', weightKg: 80 }] },
		{
			bodyComp: [
				{ hkUuid: `${TEST_PREFIX}bad`, measuredAt: '1990-01-01T00:00:00Z', weightKg: 1200 }
			]
		},
		{ bodyComp: [{ measuredAt: '1990-01-01T00:00:00Z', weightKg: 80 }] }, // no hkUuid
		'not even json shaped'
	];
	for (const data of cases) {
		const res = await request.post('/api/healthkit', { headers: auth, data });
		expect(res.status(), JSON.stringify(data)).toBe(400);
	}
});
