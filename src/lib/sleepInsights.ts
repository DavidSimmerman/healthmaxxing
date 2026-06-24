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
						? 'Low deep sleep. Alcohol, late meals and inconsistent bedtimes cut it most.'
						: 'Unusually high deep sleep — typically a sign of recovery from sleep debt.'
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
						? 'Low REM, which often tracks with short sleep or late alcohol.'
						: 'High REM, often after stress or sleep deprivation as the body catches up.'
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
					: 'A fair bit of time in bed awake — watch screens and caffeine before bed.'
		});
	}

	return out;
}
