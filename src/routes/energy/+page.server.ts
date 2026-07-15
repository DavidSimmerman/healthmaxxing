import { fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { settings } from '$lib/server/db/schema';
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
	}
};
