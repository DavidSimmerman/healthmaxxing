import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { settings } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

export async function PUT({ request }) {
	const body = await request.json();
	const { calorieTarget, proteinTargetG } = body;

	const targets = { calorieTarget, proteinTargetG };
	for (const [k, v] of Object.entries(targets)) {
		if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100000) {
			throw error(400, `invalid ${k}`);
		}
	}

	await db
		.insert(settings)
		.values({ id: 1, ...targets })
		.onConflictDoUpdate({ target: settings.id, set: targets });

	const [row] = await db.select().from(settings).where(eq(settings.id, 1));
	return json({ settings: row });
}
