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

	// Optional profile fields (BMR inputs). Empty/absent → null, not an error.
	const profile: Record<string, unknown> = {};
	if ('heightCm' in body) {
		const h = body.heightCm;
		if (h !== null && (typeof h !== 'number' || !Number.isFinite(h) || h < 50 || h > 280)) {
			throw error(400, 'invalid heightCm');
		}
		profile.heightCm = h;
	}
	if ('birthDate' in body) {
		const d = body.birthDate;
		if (d !== null && (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d))) {
			throw error(400, 'invalid birthDate');
		}
		profile.birthDate = d;
	}
	if ('sex' in body) {
		const s = body.sex;
		if (s !== null && s !== 'male' && s !== 'female') throw error(400, 'invalid sex');
		profile.sex = s;
	}
	// Bolusable-carb fiber mode (clinical calibration). Only 'full' | 'half_over_5'.
	if ('fiberMode' in body) {
		const fm = body.fiberMode;
		if (fm !== 'full' && fm !== 'half_over_5') throw error(400, 'invalid fiberMode');
		profile.fiberMode = fm;
	}
	// Free-text notes surfaced to the scheduled Claude review. Trim, cap length;
	// blank → null so clearing the field doesn't store an empty string.
	if ('notes' in body) {
		const n = body.notes;
		if (n !== null && typeof n !== 'string') throw error(400, 'invalid notes');
		const trimmed = n == null ? null : n.trim();
		if (trimmed != null && trimmed.length > 4000) throw error(400, 'notes too long (max 4000)');
		profile.notes = trimmed && trimmed.length ? trimmed : null;
	}

	const set = { ...targets, ...profile };
	await db
		.insert(settings)
		.values({ id: 1, ...set })
		.onConflictDoUpdate({ target: settings.id, set });

	const [row] = await db.select().from(settings).where(eq(settings.id, 1));
	return json({ settings: row });
}
