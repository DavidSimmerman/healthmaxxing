import { db } from '$lib/server/db';
import { settings, quickAdds, foods, dexcomAuth } from '$lib/server/db/schema';
import { asc, eq } from 'drizzle-orm';
import { fail } from '@sveltejs/kit';
import { authEnabled } from '$lib/server/session';
import { dexcomEnabled } from '$lib/server/dexcom';
import { tandemEnabled, tandemConnected, connectAndVerify } from '$lib/server/tandem';

export async function load() {
	const [settingsRow] = await db.select().from(settings).where(eq(settings.id, 1));

	const [dexcomRow] = await db
		.select({ id: dexcomAuth.id })
		.from(dexcomAuth)
		.where(eq(dexcomAuth.id, 1));

	const quickAddItems = await db
		.select({
			id: quickAdds.id,
			sortOrder: quickAdds.sortOrder,
			foodId: foods.id,
			name: foods.name,
			brand: foods.brand,
			calories: foods.calories,
			proteinG: foods.proteinG
		})
		.from(quickAdds)
		.innerJoin(foods, eq(quickAdds.foodId, foods.id))
		.orderBy(asc(quickAdds.sortOrder));

	return {
		settings: settingsRow ?? {
			id: 1,
			calorieTarget: 2100,
			proteinTargetG: 180,
			carbsTargetG: 220,
			fatTargetG: 70,
			fiberMode: 'full' as const
		},
		quickAddItems,
		authEnabled: authEnabled(),
		dexcomConfigured: dexcomEnabled(),
		dexcomConnected: !!dexcomRow,
		tandemConfigured: tandemEnabled(),
		tandemConnected: await tandemConnected()
	};
}

// The settings page is owner-gated by hooks.server.ts (valid session when app
// auth is enabled), so this action inherits that protection.
export const actions = {
	connectTandem: async ({ request }) => {
		if (!tandemEnabled()) return fail(503, { tandemError: 'Not configured (set TANDEM_ENC_KEY).' });
		const form = await request.formData();
		const username = String(form.get('username') ?? '').trim();
		const password = String(form.get('password') ?? '');
		const region = String(form.get('region') ?? 'US') === 'EU' ? 'EU' : 'US';
		if (!username || !password)
			return fail(400, { tandemError: 'Tandem Source username and password are required.' });

		// Store + verify by pulling a few days now, so a typo surfaces here rather
		// than silently on the next cron. Rolls back to the prior creds on failure.
		try {
			const r = await connectAndVerify(username, password, region);
			return { tandemConnected: true, tandemSynced: r.events, tandemGlucose: r.glucose };
		} catch (e) {
			return fail(502, {
				tandemError: e instanceof Error ? e.message : 'Could not verify Tandem credentials.'
			});
		}
	}
};
