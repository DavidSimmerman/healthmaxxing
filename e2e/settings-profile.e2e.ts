import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

// PUT /api/settings round-trip for the new profile (BMR input) fields.

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

// The settings row is a singleton the user actually lives in — snapshot it and
// restore afterwards so the test doesn't clobber real targets or profile.
let savedSettings: Record<string, unknown> | null = null;

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
		const rows = await sql`SELECT * FROM settings WHERE id = 1`;
		savedSettings = rows[0] ?? null;
	});
});

test.afterAll(async () => {
	await withDb(async (sql) => {
		await sql`DELETE FROM settings WHERE id = 1`;
		if (savedSettings) await sql`INSERT INTO settings ${sql(savedSettings)}`;
	});
});

test('saves and clears profile fields', async ({ request }) => {
	const base = { calorieTarget: 2100, proteinTargetG: 180 };

	const set = await request.put('/api/settings', {
		headers: auth,
		data: { ...base, heightCm: 182.9, birthDate: '1995-06-15', sex: 'male' }
	});
	expect(set.ok()).toBeTruthy();
	const { settings } = await set.json();
	expect(settings).toMatchObject({ heightCm: 182.9, birthDate: '1995-06-15', sex: 'male' });

	// Omitting profile keys leaves them untouched
	const keep = await request.put('/api/settings', { headers: auth, data: base });
	expect((await keep.json()).settings).toMatchObject({ heightCm: 182.9, sex: 'male' });

	// Explicit nulls clear them
	const clear = await request.put('/api/settings', {
		headers: auth,
		data: { ...base, heightCm: null, birthDate: null, sex: null }
	});
	expect((await clear.json()).settings).toMatchObject({
		heightCm: null,
		birthDate: null,
		sex: null
	});

	// Garbage rejected
	for (const bad of [{ heightCm: 999 }, { birthDate: 'June 1995' }, { sex: 'yes' }]) {
		const res = await request.put('/api/settings', { headers: auth, data: { ...base, ...bad } });
		expect(res.status(), JSON.stringify(bad)).toBe(400);
	}
});
