import { fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { settings } from '$lib/server/db/schema';
import { todayLabel } from '$lib/server/day';
import { energyBreakdown } from '$lib/server/energyBreakdown';
import type { GoalMode } from '$lib/energy';

const MODES: GoalMode[] = ['cut', 'recomp', 'lean_bulk'];

export async function load() {
	return { breakdown: await energyBreakdown() };
}

export const actions = {
	setMode: async ({ request }) => {
		const mode = String((await request.formData()).get('mode'));
		if (!MODES.includes(mode as GoalMode)) return fail(400, { error: 'invalid mode' });
		await db
			.insert(settings)
			.values({ id: 1, goalMode: mode })
			.onConflictDoUpdate({ target: settings.id, set: { goalMode: mode } });
		return { ok: true };
	},

	// Set today's activity-level override (0–4) for the live target, or clear it.
	setLevel: async ({ request }) => {
		const raw = String((await request.formData()).get('level'));
		const level = raw === '' ? null : Number(raw);
		if (level !== null && (!Number.isInteger(level) || level < 0 || level > 4))
			return fail(400, { error: 'invalid level' });
		const set = { activityLevel: level, activityLevelDate: level === null ? null : todayLabel() };
		await db
			.insert(settings)
			.values({ id: 1, ...set })
			.onConflictDoUpdate({ target: settings.id, set });
		return { ok: true };
	}
};
