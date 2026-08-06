import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

// E2E for the Apple-Watch-as-backup sleep source: seeds two nights straight into
// the DB — one recorded by the Fitbit, one by the Apple Watch (no stage
// breakdown, the forgot-to-swap case) — and checks /sleep shows BOTH with a badge
// naming the device. Rows are deleted afterwards.

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

const password = envVar('MCP_AUTH_PASSWORD');

// Two consecutive nights inside the page's 30-day window.
const ymd = (daysAgo: number) =>
	new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
const FITBIT_NIGHT = ymd(3);
const APPLE_NIGHT = ymd(2);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

const seg = (stage: string, startMin: number, durationMin: number) => ({
	stage,
	startMin,
	durationMin
});

test.beforeAll(async () => {
	await withDb(async (sql) => {
		for (const [date, source, segments, metrics] of [
			[
				FITBIT_NIGHT,
				'fitbit',
				[seg('LIGHT', 0, 240), seg('DEEP', 240, 90), seg('REM', 330, 90), seg('AWAKE', 420, 30)],
				{ sleep_min: 420, sleep_light_min: 240, sleep_deep_min: 90, sleep_rem_min: 90 }
			],
			[APPLE_NIGHT, 'apple', [seg('ASLEEP', 0, 400)], { sleep_min: 400, time_in_bed_min: 400 }]
		] as const) {
			await sql`insert into sleep_stages (date, start_at, end_at, segments, source)
				values (${date}, ${`${date}T03:00:00Z`}, ${`${date}T11:00:00Z`},
					${sql.json(segments as unknown as object)}, ${source})
				on conflict (date) do update set source = excluded.source, segments = excluded.segments`;
			for (const [metric, value] of Object.entries(metrics)) {
				await sql`insert into daily_metrics (date, metric, value) values (${date}, ${metric}, ${value})
					on conflict (date, metric) do update set value = excluded.value`;
			}
		}
	});
});

test.afterAll(async () => {
	await withDb(async (sql) => {
		await sql`delete from sleep_stages where date in (${FITBIT_NIGHT}, ${APPLE_NIGHT})`;
		await sql`delete from daily_metrics
			where date in (${FITBIT_NIGHT}, ${APPLE_NIGHT})
			  and (metric like 'sleep%' or metric = 'time_in_bed_min')`;
	});
});

test('every night on /sleep names the watch it came from', async ({ page }) => {
	if (password) {
		await page.goto('/login');
		await page.fill('input[type="password"]', password);
		await page.click('button[type="submit"]');
		await page.waitForURL('**/');
	}
	await page.goto('/sleep');

	// Both nights are listed, each labelled with its device.
	await expect(page.getByText('Apple Watch').first()).toBeVisible();
	await expect(page.getByText('Fitbit').first()).toBeVisible();

	// The Apple night renders a solid "Asleep" block (no stage breakdown) rather
	// than an empty hypnogram.
	await page.getByRole('button', { name: /Apple Watch/ }).click();
	// (twice: the hypnogram band label and the legend entry)
	await expect(page.getByText('Asleep', { exact: true })).toHaveCount(2);

	await page.screenshot({ path: 'test-results/sleep-sources.png', fullPage: true });
});
