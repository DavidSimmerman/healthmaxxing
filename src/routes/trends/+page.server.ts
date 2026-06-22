import { energyInsights } from '$lib/server/projections';
import { db } from '$lib/server/db';
import { settings } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { todayLabel } from '$lib/server/day';

// Allowed lookback windows (days). Drives BOTH the chart range and the trend /
// projection calculations, so projections reflect a recent diet rather than
// months-old data. 9999 ≈ "all".
const WINDOWS = [7, 14, 30, 90, 180, 9999];

export async function load({ url }) {
	const reqWindow = Number(url.searchParams.get('window'));
	const windowDays = WINDOWS.includes(reqWindow) ? reqWindow : 30;

	// Only honour ?target when it's a real future YYYY-MM-DD; otherwise ignore it.
	const rawTarget = url.searchParams.get('target');
	const today = todayLabel();
	const targetDate =
		rawTarget && /^\d{4}-\d{2}-\d{2}$/.test(rawTarget) && rawTarget > today ? rawTarget : undefined;

	// Optional "what if my deficit were X kcal?" scenario. Note: get() returns null
	// when absent and Number(null) === 0, so check presence explicitly.
	const rawDef = url.searchParams.get('deficit');
	const whatIfDeficitKcal =
		rawDef !== null && rawDef.trim() !== '' && Number.isFinite(Number(rawDef))
			? Math.max(-3000, Math.min(3000, Math.round(Number(rawDef))))
			: undefined;

	const energy = await energyInsights({ windowDays, targetDate, whatIfDeficitKcal });

	const [s] = await db.select().from(settings).where(eq(settings.id, 1));
	const goals = {
		goalWeightKg: s?.goalWeightKg ?? null,
		goalBodyFatPct: s?.goalBodyFatPct ?? null
	};

	// `insights` keeps the prior BodyInsights shape the page already renders.
	return {
		insights: energy.body,
		energy,
		goals,
		windowDays,
		target: targetDate ?? null,
		whatIfDeficit: whatIfDeficitKcal ?? null
	};
}
