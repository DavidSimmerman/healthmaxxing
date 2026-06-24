// Turn a period's average sleep numbers into plain-English assessments. Reference
// ranges are general adult sleep-science guidance (not medical advice): they tell
// you whether a stage is in a typical band, which is the "what do I make of this"
// the raw minutes don't answer. Percentages are of time ASLEEP.
//
// Sources of the bands (round, well-established figures): total 7–9h (NSF), deep
// ~13–23%, REM ~20–25%, sleep efficiency ≥85% = good. Light is the remainder, so
// it's reported but not graded.

export type SleepAverages = {
	sleepMin: number | null;
	deepMin: number | null;
	remMin: number | null;
	lightMin: number | null;
	efficiencyPct: number | null;
	restingHr: number | null;
	hrvMs: number | null;
};

export type Status = 'good' | 'low' | 'high' | 'unknown';
export type Insight = {
	key: string;
	label: string;
	value: string; // formatted headline (e.g. "7h 24m" or "18%")
	detail: string; // the target band
	status: Status;
	note: string; // one-line verdict
};

function hm(min: number): string {
	const h = Math.floor(min / 60);
	const m = Math.round(min % 60);
	return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// Grade a value against [low, high]: below → 'low', above → 'high', within → 'good'.
function band(v: number, low: number, high: number): Status {
	if (v < low) return 'low';
	if (v > high) return 'high';
	return 'good';
}

export function sleepInsights(a: SleepAverages): Insight[] {
	const out: Insight[] = [];

	// Total sleep — 7–9h.
	if (a.sleepMin != null) {
		const s = band(a.sleepMin, 420, 540);
		out.push({
			key: 'total',
			label: 'Total sleep',
			value: hm(a.sleepMin),
			detail: '7–9h recommended',
			status: s,
			note:
				s === 'good'
					? "You're getting enough sleep."
					: s === 'low'
						? 'Below the 7h recommendation — aim for an earlier bedtime.'
						: 'More than 9h on average — usually fine, but worth noting if you still feel tired.'
		});
	}

	// Stage percentages of time asleep.
	const pctOf = (min: number | null) => (a.sleepMin && min != null ? (min / a.sleepMin) * 100 : null);
	const deepPct = pctOf(a.deepMin);
	const remPct = pctOf(a.remMin);
	const lightPct = pctOf(a.lightMin);

	if (deepPct != null) {
		const s = band(deepPct, 13, 23);
		out.push({
			key: 'deep',
			label: 'Deep sleep',
			value: `${Math.round(deepPct)}%`,
			detail: `${hm(a.deepMin!)} · 13–23% typical`,
			status: s,
			note:
				s === 'good'
					? 'Solid deep sleep — this is your physical-recovery stage.'
					: s === 'low'
						? 'Below the typical 13-23% band. Deep sleep is when the body does most of its physical recovery.'
						: 'Above the typical 13-23% band, often the body catching up after sleep debt.'
		});
	}

	if (remPct != null) {
		const s = band(remPct, 20, 25);
		out.push({
			key: 'rem',
			label: 'REM sleep',
			value: `${Math.round(remPct)}%`,
			detail: `${hm(a.remMin!)} · 20–25% typical`,
			status: s,
			note:
				s === 'good'
					? 'Healthy REM — your memory/mood-processing stage.'
					: s === 'low'
						? 'Below the typical 20-25% band. REM is the memory- and mood-processing stage and concentrates in the later part of the night.'
						: 'Above the typical 20-25% band, common after short or disrupted sleep as the body catches up.'
		});
	}

	if (lightPct != null) {
		// Light is the remainder — report it, don't grade it.
		out.push({
			key: 'light',
			label: 'Light sleep',
			value: `${Math.round(lightPct)}%`,
			detail: `${hm(a.lightMin!)} · the rest of the night`,
			status: 'unknown',
			note: 'Light sleep makes up the balance — there’s no good/bad target for it.'
		});
	}

	// Efficiency — ≥85% is good.
	if (a.efficiencyPct != null) {
		const s: Status = a.efficiencyPct >= 85 ? 'good' : 'low';
		out.push({
			key: 'efficiency',
			label: 'Efficiency',
			value: `${Math.round(a.efficiencyPct)}%`,
			detail: '≥85% is good',
			status: s,
			note:
				s === 'good'
					? 'You fall and stay asleep efficiently.'
					: 'A fair bit of time in bed was spent awake. Efficiency is sleep time divided by time in bed.'
		});
	}

	return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Period-level trends. These derive insights from the raw per-night data over a
// slice (the page passes the same nights.slice(0, period) it charts). Everything
// here is a pure function so the selfcheck can pin it down. Each insight is
// omitted cleanly when its inputs are missing — never throws, never emits NaN.

export type Night = { date: string; m: Record<string, number> };
export type StageSegment = { stage: string; startMin: number; durationMin: number };
export type NightStages = { startAt: string; endAt: string; segments: StageSegment[] };
export type StagesByDate = Record<string, NightStages>;

// Population standard deviation. Returns null for <2 samples (no spread to speak of).
function stddev(xs: number[]): number | null {
	if (xs.length < 2) return null;
	const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
	const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length;
	return Math.sqrt(variance);
}

// Clock minutes-since-midnight for an ISO instant, read in `tz`. en-US 24h via
// hourCycle:'h23' so 00:xx stays 0, not 24.
function clockMinutesInTz(iso: string, tz: string): number | null {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return null;
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: tz,
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23'
	}).formatToParts(d);
	const h = Number(parts.find((p) => p.type === 'hour')?.value);
	const m = Number(parts.find((p) => p.type === 'minute')?.value);
	if (Number.isNaN(h) || Number.isNaN(m)) return null;
	return h * 60 + m;
}

// Stddev of a set of clock times, shifting the origin to noon so that late-night
// values (23:00) and just-after-midnight values (00:30) cluster instead of
// sitting ~22h apart. Exported for the selfcheck.
export function clockStddevNoonOrigin(clockMins: number[]): number | null {
	const shifted = clockMins.map((m) => (m + 720) % 1440);
	return stddev(shifted);
}

// Older-half avg vs newer-half avg of a newest-first series. `delta = newer −
// older`. Needs ≥2 values each side (so ≥4 total); returns null otherwise.
// Exported for the selfcheck.
export function halfSplitDelta(newestFirst: number[]): { older: number; newer: number; delta: number } | null {
	const xs = newestFirst.filter((x) => typeof x === 'number' && !Number.isNaN(x));
	if (xs.length < 4) return null;
	const half = Math.floor(xs.length / 2);
	const newer = xs.slice(0, half); // newest-first → front is the recent half
	const older = xs.slice(xs.length - half);
	const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
	const newerAvg = mean(newer);
	const olderAvg = mean(older);
	return { older: olderAvg, newer: newerAvg, delta: newerAvg - olderAvg };
}

// Per-night awakening counts and total awake minutes from a stage timeline.
// An "awakening" = one AWAKE segment. Exported for the selfcheck.
export function awakeningsFor(s: NightStages): { count: number; awakeMin: number } {
	const awake = s.segments.filter((seg) => seg.stage === 'AWAKE');
	return {
		count: awake.length,
		awakeMin: awake.reduce((sum, seg) => sum + (seg.durationMin || 0), 0)
	};
}

function pluralNights(n: number): string {
	return `${n} night${n === 1 ? '' : 's'}`;
}

// Weekday of a YYYY-MM-DD date string (0=Sun … 6=Sat). The date is the calendar
// night, so a plain UTC-noon parse is unambiguous regardless of viewer tz.
function weekdayOf(date: string): number {
	return new Date(`${date}T12:00:00Z`).getUTCDay();
}

export function sleepTrends(nights: Night[], stagesByDate: StagesByDate, tz: string): Insight[] {
	const out: Insight[] = [];
	const nightsWithStages = nights.map((n) => stagesByDate[n.date]).filter((s): s is NightStages => !!s);

	// 1. Awakenings (fragmentation) — honest stand-in for Fitbit "restlessness".
	if (nightsWithStages.length > 0) {
		const per = nightsWithStages.map(awakeningsFor);
		const avgCount = per.reduce((s, p) => s + p.count, 0) / per.length;
		const avgAwake = per.reduce((s, p) => s + p.awakeMin, 0) / per.length;
		// Lower is better. ≤3/night is unremarkable for adults; >5 is fragmented.
		const status: Status = avgCount <= 3 ? 'good' : avgCount <= 5 ? 'low' : 'high';
		out.push({
			key: 'awakenings',
			label: 'Awakenings',
			value: `${Math.round(avgCount)} / night`,
			detail: `~${hm(Math.round(avgAwake))} awake · ≤3/night typical`,
			status,
			note: 'Count of awake stretches per night — the honest substitute for Fitbit "restlessness", which the Google Health API does not expose.'
		});
	}

	// 2. Bedtime/wake consistency (regularity) — stddev of onset & wake clock
	//    times, noon-origin so the midnight wrap doesn't inflate it.
	{
		const onsets = nightsWithStages
			.map((s) => clockMinutesInTz(s.startAt, tz))
			.filter((m): m is number => m != null);
		const wakes = nightsWithStages
			.map((s) => clockMinutesInTz(s.endAt, tz))
			.filter((m): m is number => m != null);
		const onsetSd = clockStddevNoonOrigin(onsets);
		const wakeSd = clockStddevNoonOrigin(wakes);
		if (onsetSd != null) {
			// Lower = more regular. <30min good, <60 ok, else high.
			const status: Status = onsetSd < 30 ? 'good' : onsetSd < 60 ? 'low' : 'high';
			const wakePart = wakeSd != null ? ` · wake ±${Math.round(wakeSd)}m` : '';
			out.push({
				key: 'consistency',
				label: 'Schedule consistency',
				value: `±${Math.round(onsetSd)}m`,
				detail: `bedtime spread${wakePart} · <30m is regular`,
				status,
				note: 'How much your sleep-onset clock time varies night to night. A steady schedule supports a steadier body clock.'
			});
		}
	}

	// 3. Sleep debt — cumulative shortfall vs a 7h (420m) floor over the slice.
	{
		const sleeps = nights.map((n) => n.m.sleep_min).filter((x): x is number => typeof x === 'number');
		if (sleeps.length > 0) {
			const debt = sleeps.reduce((s, m) => s + Math.max(0, 420 - m), 0);
			const status: Status = debt < 60 ? 'good' : debt < 240 ? 'low' : 'high';
			out.push({
				key: 'debt',
				label: 'Sleep debt',
				value: hm(Math.round(debt)),
				detail: `vs 7h/night floor · ${pluralNights(sleeps.length)}`,
				status,
				note: 'Total time short of a 7h floor, summed across the period. Near zero means you are clearing the floor most nights.'
			});
		}
	}

	// 4a. Resting-HR trend — newer half vs older half. Down = improving.
	{
		const rhr = nights.map((n) => n.m.sleep_resting_hr).filter((x): x is number => typeof x === 'number');
		const d = halfSplitDelta(rhr);
		if (d) {
			const rounded = Math.round(Math.abs(d.delta));
			// Flat (<1 bpm) = neutral; down = good; up = amber.
			const status: Status = rounded < 1 ? 'unknown' : d.delta < 0 ? 'good' : 'high';
			const arrow = rounded < 1 ? '→' : d.delta < 0 ? '▼' : '▲';
			out.push({
				key: 'rhr-trend',
				label: 'Resting HR trend',
				value: `${arrow} ${rounded} bpm`,
				detail: `${Math.round(d.older)} → ${Math.round(d.newer)} bpm (older → recent half)`,
				status,
				note: 'Sleeping resting heart rate across the period. A lower resting HR generally tracks with better recovery.'
			});
		}
	}

	// 4b. HRV trend — newer half vs older half. Up = improving.
	{
		const hrv = nights.map((n) => n.m.sleep_hrv_ms).filter((x): x is number => typeof x === 'number');
		const d = halfSplitDelta(hrv);
		if (d) {
			const rounded = Math.round(Math.abs(d.delta));
			// Flat (<1 ms) = neutral; up = good; down = amber.
			const status: Status = rounded < 1 ? 'unknown' : d.delta > 0 ? 'good' : 'high';
			const arrow = rounded < 1 ? '→' : d.delta > 0 ? '▲' : '▼';
			out.push({
				key: 'hrv-trend',
				label: 'HRV trend',
				value: `${arrow} ${rounded} ms`,
				detail: `${Math.round(d.older)} → ${Math.round(d.newer)} ms (older → recent half)`,
				status,
				note: 'Overnight heart-rate variability across the period. Higher HRV generally tracks with better recovery.'
			});
		}
	}

	// 5. Weekday vs weekend ("social jetlag") — avg sleep_min gap.
	{
		const wknd: number[] = [];
		const wkdy: number[] = [];
		for (const n of nights) {
			const m = n.m.sleep_min;
			if (typeof m !== 'number') continue;
			const wd = weekdayOf(n.date);
			(wd === 0 || wd === 6 ? wknd : wkdy).push(m);
		}
		if (wknd.length > 0 && wkdy.length > 0) {
			const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
			const diff = mean(wknd) - mean(wkdy); // + = more sleep on weekends
			const abs = Math.round(Math.abs(diff));
			// A large catch-up gap (>1h) is the "social jetlag" flag; otherwise neutral.
			const status: Status = abs > 60 ? 'low' : 'unknown';
			const sign = diff >= 0 ? '+' : '−';
			out.push({
				key: 'social-jetlag',
				label: 'Weekend catch-up',
				value: `${sign}${hm(abs)} weekends`,
				detail: `${pluralNights(wkdy.length)} weekday · ${pluralNights(wknd.length)} weekend`,
				status,
				note: 'Difference in average sleep between weekend and weekday nights. A large gap means the weekday schedule is running a deficit the weekend pays back.'
			});
		}
	}

	return out;
}
