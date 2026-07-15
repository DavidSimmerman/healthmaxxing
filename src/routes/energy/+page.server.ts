import { eq } from 'drizzle-orm';
import { fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { settings } from '$lib/server/db/schema';
import { energyBreakdown } from '$lib/server/energyBreakdown';
import type { GoalMode } from '$lib/energy';

const MODES: GoalMode[] = ['cut', 'recomp', 'lean_bulk'];

export async function load() {
	const [s] = await db.select().from(settings).where(eq(settings.id, 1));
	const mode = (MODES.includes(s?.goalMode as GoalMode) ? s!.goalMode : 'cut') as GoalMode;
	return { breakdown: await energyBreakdown(mode) };
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
