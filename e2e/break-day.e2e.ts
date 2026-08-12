import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

// E2E for the break day toggle on /day/[date]: marking a day, unmarking it, and the
// one-per-calendar-week rule (marking a second day MOVES the break off the first).

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
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
const today = fmt.format(new Date());
const yesterday = fmt.format(new Date(Date.now() - 86_400_000));
// Sunday starts the week, so on a Sunday yesterday belongs to the PREVIOUS week and
// can't demonstrate the move. Every other day, yesterday shares today's week.
const sameWeek = new Date(`${today}T12:00:00Z`).getUTCDay() !== 0;

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

// Toggling clears the whole week (that's the one-per-week rule), so snapshot any real
// break day in this week up front and put it back afterwards instead of just deleting.
let saved: string[] = [];
const weekStart = (() => {
	const d = new Date(`${today}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() - d.getUTCDay());
	return d.toISOString().slice(0, 10);
})();
const weekEnd = (() => {
	const d = new Date(`${weekStart}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + 6);
	return d.toISOString().slice(0, 10);
})();

test.beforeAll(async () => {
	await withDb(async (sql) => {
		const rows =
			await sql`SELECT date FROM break_days WHERE date BETWEEN ${weekStart} AND ${weekEnd}`;
		saved = rows.map((r: { date: string }) => r.date);
		// Start from a blank week: a real break day already on today would leave the
		// button in its marked state and the first click would find nothing to press.
		await sql`DELETE FROM break_days WHERE date BETWEEN ${weekStart} AND ${weekEnd}`;
	});
});

test.afterAll(async () => {
	await withDb(async (sql) => {
		await sql`DELETE FROM break_days WHERE date BETWEEN ${weekStart} AND ${weekEnd}`;
		for (const date of saved) await sql`INSERT INTO break_days ${sql({ date })}`;
	});
});

test('break day toggles, and one per week moves it', async ({ page }) => {
	if (password) {
		await page.goto('/login');
		await page.fill('input[type="password"]', password);
		await page.click('button[type="submit"]');
		await page.waitForURL('**/');
	}

	const mark = page.getByRole('button', { name: 'Make this a break day' });
	const marked = page.getByRole('button', { name: 'Break day · eating at maintenance' });

	// Mark today, then unmark it.
	await page.goto(`/day/${today}`);
	await mark.click();
	await expect(marked).toBeVisible();
	await marked.click();
	await expect(mark).toBeVisible();

	if (!sameWeek) return;

	// Mark yesterday, then today: the week only gets one, so yesterday's clears.
	await page.goto(`/day/${yesterday}`);
	await mark.click();
	await expect(marked).toBeVisible();

	await page.goto(`/day/${today}`);
	await mark.click();
	await expect(marked).toBeVisible();

	await page.goto(`/day/${yesterday}`);
	await expect(mark).toBeVisible();
});
