import { and, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { chats, sleepStages } from '$lib/server/db/schema';
import { APP_TZ, todayLabel } from '$lib/server/day';
import { syncHealth } from '$lib/server/fitbit';
import { syncGlucose } from '$lib/server/dexcom';
import {
	generateReportChat,
	sweepAbandonedReportClaims,
	type ReportKind
} from '$lib/server/reportChats';

// In-app scheduler for the daily/weekly/monthly report chats. Ticks every 5 min;
// each rule is idempotent (cheap existence check + the DB unique claim), so
// overlapping containers during a rolling deploy are safe.
let started = false;
let running = false; // a slow generation must not be re-entered by the next tick
let lastSyncAttempt = 0; // wake-detection Fitbit polls, at most one per 20 min

export function startScheduler() {
	if (started) return;
	started = true;
	// unref() so the timers never hold the process open; first tick waits out the
	// boot rush instead of competing with startup traffic.
	setInterval(tick, 5 * 60_000).unref();
	setTimeout(tick, 30_000).unref();
}

async function reportExists(kind: ReportKind, today: string): Promise<boolean> {
	const rows = await db
		.select({ id: chats.id })
		.from(chats)
		.where(and(eq(chats.kind, kind), eq(chats.dateLabel, today)))
		.limit(1);
	return rows.length > 0;
}

async function sleptToday(today: string): Promise<boolean> {
	const rows = await db
		.select({ date: sleepStages.date })
		.from(sleepStages)
		.where(eq(sleepStages.date, today))
		.limit(1);
	return rows.length > 0;
}

async function tick() {
	if (running) return;
	running = true;
	try {
		await sweepAbandonedReportClaims();
		const parts = new Intl.DateTimeFormat('en-US', {
			timeZone: APP_TZ,
			hour12: false,
			hour: '2-digit',
			weekday: 'short',
			day: '2-digit'
		}).formatToParts(new Date());
		const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
		const hour = parseInt(get('hour'), 10) % 24; // en-US hour12:false is h24 — midnight is '24'
		const weekday = get('weekday');
		const dayOfMonth = get('day');
		const today = todayLabel();

		if (weekday === 'Sun' && hour >= 4 && !(await reportExists('weekly', today))) {
			console.log(`[scheduler] weekly report: ${await generateReportChat('weekly')}`);
		}
		if (dayOfMonth === '01' && hour >= 4 && !(await reportExists('monthly', today))) {
			console.log(`[scheduler] monthly report: ${await generateReportChat('monthly')}`);
		}
		if (hour >= 5 && !(await reportExists('daily', today))) {
			await maybeDaily(hour, today);
		}
	} catch (e) {
		console.error('[scheduler] tick failed:', e);
	} finally {
		running = false;
	}
}

// Daily fires on wake detection: last night's sleep row landing means Fitbit
// synced after wake-up. Before noon we poll Fitbit for it (≤ once per 20 min);
// from noon we generate regardless — never skip a day.
async function maybeDaily(hour: number, today: string) {
	let slept = await sleptToday(today);
	let justSynced = false;
	if (!slept && hour < 12) {
		if (Date.now() - lastSyncAttempt < 20 * 60_000) return;
		lastSyncAttempt = Date.now();
		// Fitbit may be unconfigured/unauthorized — that's fine, noon fallback covers it.
		await syncHealth(1).catch((e) =>
			console.log('[scheduler] wake-check sync skipped:', (e as Error).message)
		);
		justSynced = true;
		slept = await sleptToday(today);
		if (!slept) return; // still asleep (or Fitbit lagging) — retry next tick
	}
	// Refresh overnight data before generating (skip health if just pulled above).
	await Promise.allSettled([...(justSynced ? [] : [syncHealth(1)]), syncGlucose(2)]);
	console.log(`[scheduler] daily report: ${await generateReportChat('daily')}`);
}
