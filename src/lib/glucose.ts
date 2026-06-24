// Clinical CGM summaries from a day's Dexcom EGV readings (mg/dL). Targets follow
// the Battelino 2019 consensus (time-in-range 70–180 mg/dL) and GMI from mean
// glucose (Bergenstal 2018). These are derived stats for review — NOT medical
// advice; David doses insulin off carbs, validate against the raw trace + a care team.

export const TIR_LOW = 70; // mg/dL — below this is "low"
export const TIR_HIGH = 180; // mg/dL — above this is "high"; 70–180 inclusive is in range

// GMI (%) — glucose management indicator, an A1C estimate from mean glucose.
// Bergenstal 2018: GMI = 3.31 + 0.02392 × mean(mg/dL).
export function gmiPct(meanMgdl: number): number {
	return 3.31 + 0.02392 * meanMgdl;
}

export type GlucoseStats = {
	n: number; // number of valid readings
	avgMgdl: number;
	gmiPct: number;
	tirPct: number; // % in [70, 180]
	belowPct: number; // % < 70
	abovePct: number; // % > 180
};

// Null when there are no valid readings (sensor gap / warmup-only day) — callers
// skip writing a day rather than emitting a bogus 0.
export function glucoseStats(values: number[]): GlucoseStats | null {
	const v = values.filter((x) => Number.isFinite(x) && x > 0);
	const n = v.length;
	if (!n) return null;
	const avg = v.reduce((a, b) => a + b, 0) / n;
	const below = v.filter((x) => x < TIR_LOW).length;
	const above = v.filter((x) => x > TIR_HIGH).length;
	const inRange = n - below - above;
	return {
		n,
		avgMgdl: avg,
		gmiPct: gmiPct(avg),
		tirPct: (inRange / n) * 100,
		belowPct: (below / n) * 100,
		abovePct: (above / n) * 100
	};
}
