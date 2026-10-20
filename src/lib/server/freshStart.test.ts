import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// Fresh start + aggressive cut, against the real ledger. The scenario is the one the feature
// exists for: weeks of an inaccurate food log (here 1200 kcal/day, while the scale climbs —
// physically impossible, which is the point) followed by an honest log. With the cutoff in
// place the calibration must learn ONLY from the honest stretch, scoring must forget the old
// days, and the day-one target must still exist with no post-start weigh-in.
//
// SEEDS a full synthetic history, so it only runs against an EMPTY database (no weigh-ins) —
// never a dev DB with real data in it. Skipped without DATABASE_URL.
const url = process.env.DATABASE_URL;

const DAY = 86_400_000;

describe.skipIf(!url)('fresh start', () => {
	let sql: any;
	let empty = false;
	let today = '';
	const ago = (n: number) =>
		new Date(Date.parse(`${today}T12:00:00Z`) - n * DAY).toISOString().slice(0, 10);

	beforeAll(async () => {
		const { default: postgres } = await import('postgres');
		sql = postgres(url!, { max: 1 });
		empty = Number((await sql`SELECT count(*)::int AS n FROM body_comp`)[0].n) === 0;
		if (!empty) return;
		const { todayLabel } = await import('./day');
		today = todayLabel();

		await sql`INSERT INTO settings (id, height_cm, birth_date, sex, goal_mode)
			VALUES (1, 175, '1995-01-01', 'male', 'cut')
			ON CONFLICT (id) DO UPDATE SET height_cm = 175, birth_date = '1995-01-01', sex = 'male'`;
		const [food] =
			await sql`INSERT INTO foods (name, source, calories, protein_g, carbs_g, fat_g) VALUES ('test', 'manual', 100, 10, 10, 3) RETURNING id`;

		// 80 days. Before day −20: the bad log (1200 kcal) while weight RISES 70 → 72 kg.
		// From day −20: the honest log (2000 kcal) while weight falls 70 → 69 kg.
		for (let n = 80; n >= 1; n--) {
			const date = ago(n);
			const honest = n <= 20;
			const kcal = honest ? 2000 : 1200;
			const weight = honest ? 70 - (20 - n) * 0.05 : 70 + ((80 - n) / 60) * 2;
			await sql`INSERT INTO activity_days (date, active_kcal, basal_kcal) VALUES (${date}, 500, 1700)`;
			await sql`INSERT INTO body_comp (hk_uuid, measured_at, weight_kg, body_fat_pct)
				VALUES (${'t' + n}, ${date + 'T12:00:00Z'}, ${weight}, ${honest ? 17 : 19})`;
			await sql`INSERT INTO daily_log (food_id, logged_at, calories, protein_g, carbs_g, fat_g)
				VALUES (${food.id}, ${date + 'T16:00:00Z'}, ${kcal}, 150, 200, 60)`;
		}
	});

	afterAll(async () => {
		await sql?.end();
	});

	const setStart = (date: string | null) =>
		sql`UPDATE settings SET tracking_start_date = ${date} WHERE id = 1`;

	it('the migration sets the start on the existing settings row', async () => {
		if (!empty) return;
		const { readFileSync } = await import('node:fs');
		const update = readFileSync('drizzle/0031_fresh_start.sql', 'utf8')
			.split('--> statement-breakpoint')[1]
			.trim();
		await sql.unsafe(update);
		expect((await sql`SELECT tracking_start_date FROM settings`)[0].tracking_start_date).toBe(
			'2026-10-21'
		);
	});

	it('calibrates only from the honest stretch', async () => {
		if (!empty) return;
		const { energyInsights } = await import('./projections');

		// No cutoff: the bad log poisons calibration (1200 kcal while not losing ⇒ "maintenance"
		// far below what 2000 kcal + a falling scale implies).
		await setStart(null);
		const poisoned = await energyInsights({ windowDays: 30 });

		await setStart(ago(20));
		const clean = await energyInsights({ windowDays: 30 });
		expect(clean.loggedDays).toBe(20);
		expect(clean.avgIntakeKcal).toBe(2000);
		// 2000 kcal while losing 0.05 kg/day ⇒ 2000 + 0.05 × 7700 = 2385.
		expect(clean.calibratedTdee).not.toBeNull();
		expect(Math.abs(clean.calibratedTdee! - 2385)).toBeLessThan(15);
		expect(Math.abs(poisoned.calibratedTdee! - 2385)).toBeGreaterThan(200);
		// The weight trend is fitted to the honest stretch only.
		expect(clean.body.weight!.anchorDate).toBe(ago(20));
		expect(clean.body.weight!.ratePerWeek).toBeLessThan(0);
	});

	it('holds calibration for the settling window but still sets a day-one target', async () => {
		if (!empty) return;
		const { energyInsights } = await import('./projections');
		const { resolveCorrection } = await import('./energyBreakdown');

		// Start = tomorrow: nothing logged, no weigh-in yet — exactly David's day one.
		await setStart(ago(-1));
		const ins = await energyInsights({ windowDays: 30 });
		expect(ins.loggedDays).toBe(0);
		expect(ins.calibratedTdee).toBeNull();
		expect(ins.body.weight).toBeNull();
		const ctx = await resolveCorrection();
		expect(ctx.maintenanceSource).toBe('estimated'); // formula + burn history still works
		expect(ctx.weightKg).toBeCloseTo(69.05, 1); // newest weigh-in, no trend needed
		expect(ctx.modeDeltaKcal).toBeLessThan(0);
		expect(ctx.targetKcal).not.toBeNull();
		expect(ctx.balanceKcal).toBe(0); // no debt or credit carried in from the old log

		// 5 days in: logged, but inside the 14-day settle → still the formula estimate.
		await setStart(ago(5));
		expect((await energyInsights({ windowDays: 30 })).calibratedTdee).toBeNull();
	});

	it('drops pre-start days from scoring', async () => {
		if (!empty) return;
		const { dayMetricsForRange } = await import('./goals');
		await setStart(ago(10));
		const days = await dayMetricsForRange(ago(30), ago(1));
		expect(days).toHaveLength(10);
		expect(days[0].date).toBe(ago(10));
	});

	it('aggressive cut asks for a bigger deficit than cut', async () => {
		if (!empty) return;
		const { resolveCorrection } = await import('./energyBreakdown');
		await setStart(ago(20));
		const cut = await resolveCorrection();
		await sql`UPDATE settings SET goal_mode = 'aggressive_cut' WHERE id = 1`;
		const aggressive = await resolveCorrection();
		await sql`UPDATE settings SET goal_mode = 'cut' WHERE id = 1`;
		expect(aggressive.mode).toBe('aggressive_cut');
		expect(aggressive.modeDeltaKcal!).toBeLessThan(cut.modeDeltaKcal! - 100);
		expect(aggressive.targetKcal!).toBeLessThan(cut.targetKcal!);
	});
});
