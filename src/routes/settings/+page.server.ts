import { db } from '$lib/server/db';
import {
	settings,
	quickAdds,
	foods,
	dexcomAuth,
	fitbitAuth,
	vacations,
	syncStatus
} from '$lib/server/db/schema';
import { asc, eq } from 'drizzle-orm';
import { fail } from '@sveltejs/kit';
import { listVacations } from '$lib/server/vacations';
import { authEnabled } from '$lib/server/session';
import { dexcomEnabled } from '$lib/server/dexcom';
import { googleHealthEnabled } from '$lib/server/fitbit';
import { tandemEnabled, tandemConnected, connectAndVerify } from '$lib/server/tandem';
import { DEFAULT_REPORT_PROMPTS } from '$lib/server/reportChats';

export async function load() {
	const [settingsRow] = await db.select().from(settings).where(eq(settings.id, 1));

	const [dexcomRow] = await db
		.select({ id: dexcomAuth.id })
		.from(dexcomAuth)
		.where(eq(dexcomAuth.id, 1));

	const [fitbitRow] = await db
		.select({ id: fitbitAuth.id })
		.from(fitbitAuth)
		.where(eq(fitbitAuth.id, 1));

	// Last sync outcome per integration — drives the health line on each card.
	const syncRows = await db.select().from(syncStatus);

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
		vacations: await listVacations(),
		quickAddItems,
		authEnabled: authEnabled(),
		dexcomConfigured: dexcomEnabled(),
		dexcomConnected: !!dexcomRow,
		fitbitConfigured: googleHealthEnabled(),
		fitbitConnected: !!fitbitRow,
		tandemConfigured: tandemEnabled(),
		tandemConnected: await tandemConnected(),
		// Scheduled-report prompt overrides (null = built-in default, shown as placeholder).
		reportPrompts: {
			daily: settingsRow?.dailyReportPrompt ?? null,
			weekly: settingsRow?.weeklyReportPrompt ?? null,
			monthly: settingsRow?.monthlyReportPrompt ?? null
		},
		reportPromptDefaults: DEFAULT_REPORT_PROMPTS,
		syncStatus: syncRows
	};
}

// The settings page is owner-gated by hooks.server.ts (valid session when app
// auth is enabled), so this action inherits that protection.
// A well-formed AND real calendar date (rejects 2026-02-31, 2026-13-01, etc.).
const validDate = (s: string) => {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
	const d = new Date(`${s}T00:00:00Z`);
	return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

export const actions = {
	// Add a trip window; days inside [from, to] score against the relaxed vacation goals.
	addVacation: async ({ request }) => {
		const form = await request.formData();
		const from = String(form.get('from') ?? '').trim();
		const to = String(form.get('to') ?? '').trim();
		if (!validDate(from) || !validDate(to))
			return fail(400, { vacationError: 'Enter valid start and end dates.' });
		if (from > to)
			return fail(400, { vacationError: 'End date must be on or after the start date.' });
		await db.insert(vacations).values({ from, to });
		return { vacationAdded: true };
	},

	deleteVacation: async ({ request }) => {
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		if (!id) return fail(400, { vacationError: 'Missing trip id.' });
		await db.delete(vacations).where(eq(vacations.id, id));
		return { vacationDeleted: true };
	},

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
