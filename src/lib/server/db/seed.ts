import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { foods, dailyLog, quickAdds, settings } from './schema';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');

const client = postgres(process.env.DATABASE_URL);
const db = drizzle(client);

async function seed() {
	await db.insert(settings).values({ id: 1 }).onConflictDoNothing();

	const existing = await db.select().from(foods);
	if (existing.length > 0) {
		console.log('foods table not empty — skipping seed');
		await client.end();
		return;
	}

	const [oats, coffee, bowl, apple, shake] = await db
		.insert(foods)
		.values([
			{
				name: 'Overnight oats',
				servingSize: '1 cup',
				calories: 420,
				proteinG: 22,
				carbsG: 58,
				fatG: 8,
				source: 'manual'
			},
			{
				name: 'Coffee w/ oat milk',
				servingSize: '12 oz',
				calories: 80,
				proteinG: 2,
				carbsG: 14,
				fatG: 2,
				source: 'manual'
			},
			{
				name: 'Chicken & rice bowl',
				servingSize: '1 bowl',
				calories: 540,
				proteinG: 42,
				carbsG: 52,
				fatG: 18,
				source: 'manual'
			},
			{
				name: 'Apple',
				servingSize: '1 medium',
				calories: 95,
				proteinG: 0,
				carbsG: 25,
				fatG: 0,
				source: 'manual'
			},
			{
				name: 'Protein shake',
				servingSize: '1 scoop',
				calories: 160,
				proteinG: 30,
				carbsG: 4,
				fatG: 2,
				source: 'manual'
			}
		])
		.returning();

	const at = (h: number, m: number) => {
		const d = new Date();
		d.setHours(h, m, 0, 0);
		return d;
	};

	await db.insert(dailyLog).values([
		{
			foodId: oats.id,
			servings: 1,
			loggedAt: at(8, 14),
			calories: oats.calories,
			proteinG: oats.proteinG,
			carbsG: oats.carbsG,
			fatG: oats.fatG
		},
		{
			foodId: coffee.id,
			servings: 1,
			loggedAt: at(8, 20),
			calories: coffee.calories,
			proteinG: coffee.proteinG,
			carbsG: coffee.carbsG,
			fatG: coffee.fatG
		},
		{
			foodId: bowl.id,
			servings: 1,
			loggedAt: at(12, 48),
			calories: bowl.calories,
			proteinG: bowl.proteinG,
			carbsG: bowl.carbsG,
			fatG: bowl.fatG
		},
		{
			foodId: apple.id,
			servings: 1,
			loggedAt: at(15, 30),
			calories: apple.calories,
			proteinG: apple.proteinG,
			carbsG: apple.carbsG,
			fatG: apple.fatG
		},
		{
			foodId: shake.id,
			servings: 1,
			loggedAt: at(16, 15),
			calories: shake.calories,
			proteinG: shake.proteinG,
			carbsG: shake.carbsG,
			fatG: shake.fatG
		}
	]);

	await db.insert(quickAdds).values([
		{ foodId: shake.id, sortOrder: 0 },
		{ foodId: bowl.id, sortOrder: 1 },
		{ foodId: coffee.id, sortOrder: 2 }
	]);

	console.log('seeded');
	await client.end();
}

seed().catch(async (e) => {
	console.error(e);
	await client.end();
	process.exit(1);
});
