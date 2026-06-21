import { bodyInsights } from '$lib/server/projections';
import { db } from '$lib/server/db';
import { settings } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { todayLabel } from '$lib/server/day';

export async function load({ url }) {
	const windowDays = Number(url.searchParams.get('window')) || 90;

	// Only honour ?target when it's a real future YYYY-MM-DD; otherwise ignore it.
	const rawTarget = url.searchParams.get('target');
	const today = todayLabel();
	const targetDate =
		rawTarget && /^\d{4}-\d{2}-\d{2}$/.test(rawTarget) && rawTarget > today
			? rawTarget
			: undefined;

	const insights = await bodyInsights({ windowDays, targetDate });

	const [s] = await db.select().from(settings).where(eq(settings.id, 1));
	const goals = {
		goalWeightKg: s?.goalWeightKg ?? null,
		goalBodyFatPct: s?.goalBodyFatPct ?? null
	};

	return { insights, goals, windowDays, target: targetDate ?? null };
}
