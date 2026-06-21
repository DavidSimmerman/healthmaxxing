import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { settings } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

// Body-composition goals. Either may be null (cleared) or a number in range.
// Only the keys actually present in the request body are written, so a request
// can update one goal without disturbing the other.
export async function PUT({ request }) {
	const body = await request.json();

	const set: Record<string, unknown> = {};

	if ('goalWeightKg' in body) {
		const v = body.goalWeightKg;
		if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < 20 || v > 400)) {
			throw error(400, 'invalid goalWeightKg');
		}
		set.goalWeightKg = v;
	}

	if ('goalBodyFatPct' in body) {
		const v = body.goalBodyFatPct;
		if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < 1 || v > 75)) {
			throw error(400, 'invalid goalBodyFatPct');
		}
		set.goalBodyFatPct = v;
	}

	if (Object.keys(set).length) {
		await db
			.insert(settings)
			.values({ id: 1, ...set })
			.onConflictDoUpdate({ target: settings.id, set });
	}

	const [row] = await db.select().from(settings).where(eq(settings.id, 1));
	return json({ settings: row });
}
