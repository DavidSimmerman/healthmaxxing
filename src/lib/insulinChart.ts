// Pure geometry for the intraday insulin/glucose chart. Kept out of the Svelte
// component so the load-bearing path math is unit-tested (see insulinChart.test.ts).

export type BasalPt = { min: number; units: number }; // min: 0–1439 local; units: U/hr

// Stepped-area path for the basal rate: each sample's rate holds until the next
// sample. The last sample extends `tailMin` minutes (the pump's ~5-min cadence),
// capped at `dayEnd`, so a day that's still in progress doesn't draw a flat line
// to midnight. Returns '' for no points.
export function basalAreaPath(
	pts: BasalPt[],
	x: (min: number) => number,
	y: (units: number) => number,
	baselineY: number,
	dayEnd = 1440,
	tailMin = 5
): string {
	if (!pts.length) return '';
	const p = [...pts].sort((a, b) => a.min - b.min);
	const seg: string[] = [`M ${x(p[0].min).toFixed(1)} ${baselineY.toFixed(1)}`];
	for (let i = 0; i < p.length; i++) {
		const start = p[i].min;
		const end = i + 1 < p.length ? p[i + 1].min : Math.min(start + tailMin, dayEnd);
		const yi = y(p[i].units);
		seg.push(`L ${x(start).toFixed(1)} ${yi.toFixed(1)}`); // rise to this rate
		seg.push(`L ${x(end).toFixed(1)} ${yi.toFixed(1)}`); // hold across the step
	}
	const lastEnd = Math.min(p[p.length - 1].min + tailMin, dayEnd);
	seg.push(`L ${x(lastEnd).toFixed(1)} ${baselineY.toFixed(1)} Z`); // drop to baseline + close
	return seg.join(' ');
}

// A "nice" axis maximum at least `floor`, rounded up to a tidy step so the scale
// isn't dictated by one spike. Used for both basal (U/hr) and bolus (U) scales.
export function niceMax(values: number[], floor = 1): number {
	const m = Math.max(floor, ...values);
	const step = m <= 2 ? 0.5 : m <= 5 ? 1 : m <= 20 ? 5 : 10;
	return Math.ceil(m / step) * step;
}
