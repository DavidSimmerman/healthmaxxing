import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

// E2E for the /deficit ledger: seeds a weigh-in + today's activity through
// /api/healthkit and a logged food through /api/foods, logs in, and checks the
// computed numbers. Expected resting burn is deterministic: weight 80kg @ 20%
// bf → lean 64kg → Katch-McArdle 370 + 21.6×64 = 1752.4 → rendered as 1,752.

const FOOD_NAME = 'E2E Deficit Test Meal';

function envVar(name: string): string | undefined {
	if (process.env[name]) return process.env[name];
	try {
		const line = readFileSync('.env', 'utf8')
			.split('\n')
			.find((l) => l.startsWith(`${name}=`));
		return line
			?.slice(name.length + 1)
			.trim()
			.replace(/^(['"])(.*)\1$/, '$2');
	} catch {
		return undefined;
	}
}

const token = envVar('API_TOKEN');
const auth = token ? { Authorization: `Bearer ${token}` } : {};
const password = envVar('MCP_AUTH_PASSWORD');

// The test upserts over today's REAL activity row (table is keyed by date), so
// snapshot it up front and restore it after instead of deleting blindly.
let savedActivity: Record<string, unknown> | null = null;

async function withDb(fn: (sql: any) => Promise<void>) {
	const url = envVar('DATABASE_URL');
	if (!url) return;
	const { default: postgres } = await import('postgres');
	const sql = postgres(url, { max: 1 });
	try {
		await fn(sql);
	} finally {
		await sql.end();
	}
}

test.beforeAll(async () => {
	await withDb(async (sql) => {
		const rows =
			await sql`SELECT * FROM activity_days WHERE date = (now() at time zone 'America/New_York')::date::text`;
		savedActivity = rows[0] ?? null;
	});
});

test.afterAll(async () => {
	await withDb(async (sql) => {
		await sql`DELETE FROM daily_log WHERE food_id IN (SELECT id FROM foods WHERE name = ${FOOD_NAME})`;
		await sql`DELETE FROM foods WHERE name = ${FOOD_NAME}`;
		await sql`DELETE FROM body_comp WHERE hk_uuid LIKE 'e2e-deficit-%'`;
		await sql`DELETE FROM activity_days WHERE date = (now() at time zone 'America/New_York')::date::text`;
		if (savedActivity) await sql`INSERT INTO activity_days ${sql(savedActivity)}`;
	});
});

test('deficit ledger computes resting burn from synced body comp', async ({ page, request }) => {
	const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(
		new Date()
	);

	// Seed: today's weigh-in (80kg @ 20% bf) + activity, and one logged meal.
	const seed = await request.post('/api/healthkit', {
		headers: auth,
		data: {
			bodyComp: [
				{
					hkUuid: 'e2e-deficit-weighin',
					measuredAt: `${today}T07:00:00-05:00`,
					weightKg: 80,
					bodyFatPct: 20
				}
			],
			days: [{ date: today, activeKcal: 612.5, basalKcal: 1700, steps: 9000, exerciseMin: 30 }]
		}
	});
	expect(seed.ok()).toBeTruthy();

	const food = await request.post('/api/foods', {
		headers: auth,
		data: {
			name: FOOD_NAME,
			calories: 500,
			proteinG: 40,
			carbsG: 50,
			fatG: 10,
			source: 'manual',
			logToday: true
		}
	});
	expect(food.ok()).toBeTruthy();

	// Log in (session gate) if a password is configured.
	if (password) {
		await page.goto('/login');
		await page.fill('input[type="password"]', password);
		await page.click('button[type="submit"]');
		await page.waitForURL('**/');
	}

	await page.goto('/deficit?range=d');
	await expect(page.getByText('Energy balance')).toBeVisible();

	// Resting burn comes from OUR weigh-in via Katch-McArdle — deterministic.
	const out = page.locator('section', { hasText: 'Out · burn' }).last();
	await expect(out.getByText('1,752')).toBeVisible();
	// Active energy from the seeded activity day (612.5 → rounded 613).
	await expect(out.getByText('613')).toBeVisible();

	// Footnote confirms the BMR source is body comp, not a fallback.
	await expect(page.getByText('Katch-McArdle')).toBeVisible();

	// Range switcher works. Week aggregates exclude today by design (see the
	// `counted` comment in +page.svelte) and this test only seeds today — so a
	// fresh DB correctly shows the empty state until "include today" is on.
	await page.click('a[href="?range=w"]');
	await expect(page.getByText('This week')).toBeVisible();
	await page.goto('/deficit?range=w&today=1');
	await expect(page.getByText('Daily breakdown')).toBeVisible();
});
