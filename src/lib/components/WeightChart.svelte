<script lang="ts">
	import { daysBetween } from '$lib/energy';
	import type { WeighIn, Trend } from '$lib/server/projections';

	let {
		series,
		weight,
		bodyFat,
		today,
		horizonEnd
	}: {
		series: WeighIn[];
		weight: Trend | null;
		bodyFat: Trend | null;
		today: string;
		horizonEnd: string;
	} = $props();

	// ── Geometry ────────────────────────────────────────────────────────────────
	const W = 720;
	const H = 360;
	const PAD = { top: 16, right: 44, bottom: 30, left: 44 };
	const plotW = W - PAD.left - PAD.right;
	const plotH = H - PAD.top - PAD.bottom;
	const x0 = PAD.left;
	const x1 = W - PAD.right;
	const y0 = PAD.top; // top of plot (high values)
	const y1 = H - PAD.bottom; // bottom of plot (low values)

	const WEIGHT_COLOR = '#fb923c'; // --color-accent-from
	const BF_COLOR = '#7dd3fc'; // --color-fat
	const SUBTLE = '#71717a'; // --color-text-subtle

	// X domain: first weigh-in (or today) → furthest projection.
	let xmin = $derived(series.length ? series[0].date : today);
	let xmax = $derived(horizonEnd > xmin ? horizonEnd : today > xmin ? today : xmin);
	let xSpan = $derived(daysBetween(xmin, xmax)); // may be 0 → guarded below

	function xOf(d: string): number {
		if (xSpan <= 0) return x0 + plotW / 2;
		const t = daysBetween(xmin, d) / xSpan;
		return x0 + Math.max(0, Math.min(1, t)) * plotW;
	}

	// trend value at a date
	function trendAt(t: Trend, d: string): number {
		return t.intercept + t.slopePerDay * daysBetween(t.anchorDate, d);
	}

	// Build a value->y mapper for a domain, padded; flat domain falls back to mid.
	function makeYOf(min: number, max: number) {
		if (!Number.isFinite(min) || !Number.isFinite(max) || max - min < 1e-9) {
			return () => y0 + plotH / 2;
		}
		return (v: number) => {
			const t = (v - min) / (max - min);
			return y1 - Math.max(0, Math.min(1, t)) * plotH;
		};
	}

	// ── Weight axis (left) ───────────────────────────────────────────────────────
	let weightVals = $derived(series.map((s) => s.weightKg).filter((v) => Number.isFinite(v)));
	let weightDomain = $derived.by(() => {
		const vals = [...weightVals];
		if (weight) {
			vals.push(trendAt(weight, today), trendAt(weight, xmax));
		}
		if (!vals.length) return null;
		const lo = Math.min(...vals) - 1;
		const hi = Math.max(...vals) + 1;
		return { lo, hi };
	});
	let yW = $derived(weightDomain ? makeYOf(weightDomain.lo, weightDomain.hi) : null);

	// ── Body-fat axis (right) ─────────────────────────────────────────────────────
	let bfVals = $derived(
		series.map((s) => s.bodyFatPct).filter((v): v is number => v != null && Number.isFinite(v))
	);
	let bfDomain = $derived.by(() => {
		const vals = [...bfVals];
		if (bodyFat) {
			vals.push(trendAt(bodyFat, today), trendAt(bodyFat, xmax));
		}
		if (!vals.length) return null;
		const lo = Math.min(...vals) - 1;
		const hi = Math.max(...vals) + 1;
		return { lo, hi };
	});
	let yBf = $derived(bfDomain ? makeYOf(bfDomain.lo, bfDomain.hi) : null);

	// ── Polylines / points ────────────────────────────────────────────────────────
	let weightActual = $derived(
		yW ? series.map((s) => `${xOf(s.date)},${yW!(s.weightKg)}`).join(' ') : ''
	);
	let weightPoints = $derived(yW ? series.map((s) => ({ x: xOf(s.date), y: yW!(s.weightKg) })) : []);

	let bfActualSeries = $derived(
		series.filter((s) => s.bodyFatPct != null && Number.isFinite(s.bodyFatPct))
	);
	let bfActual = $derived(
		yBf ? bfActualSeries.map((s) => `${xOf(s.date)},${yBf!(s.bodyFatPct as number)}`).join(' ') : ''
	);
	let bfPoints = $derived(
		yBf ? bfActualSeries.map((s) => ({ x: xOf(s.date), y: yBf!(s.bodyFatPct as number) })) : []
	);

	// Projection (dashed) from today → horizonEnd along the trend.
	let weightProj = $derived.by(() => {
		if (!weight || !yW || xmax <= today) return null;
		return {
			x1: xOf(today),
			y1: yW(trendAt(weight, today)),
			x2: xOf(xmax),
			y2: yW(trendAt(weight, xmax))
		};
	});
	let bfProj = $derived.by(() => {
		if (!bodyFat || !yBf || xmax <= today) return null;
		return {
			x1: xOf(today),
			y1: yBf(trendAt(bodyFat, today)),
			x2: xOf(xmax),
			y2: yBf(trendAt(bodyFat, xmax))
		};
	});

	// ── Ticks ──────────────────────────────────────────────────────────────────
	function ticks(lo: number, hi: number, n = 4): number[] {
		if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi - lo < 1e-9) return [];
		const step = (hi - lo) / n;
		return Array.from({ length: n + 1 }, (_, i) => lo + step * i);
	}
	let weightTicks = $derived(weightDomain ? ticks(weightDomain.lo, weightDomain.hi) : []);
	let bfTicks = $derived(bfDomain ? ticks(bfDomain.lo, bfDomain.hi) : []);

	function fmtDate(d: string): string {
		return new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			timeZone: 'UTC'
		});
	}

	// A few date labels across the x-axis: start, today, end.
	let xLabels = $derived.by(() => {
		const out: { x: number; label: string }[] = [];
		out.push({ x: xOf(xmin), label: fmtDate(xmin) });
		if (xmax > xmin) out.push({ x: xOf(xmax), label: fmtDate(xmax) });
		return out;
	});

	let todayX = $derived(xOf(today));
	let hasAny = $derived(series.length > 0 && yW !== null);
</script>

<div style="width: 100%;">
	<svg
		viewBox="0 0 {W} {H}"
		style="width: 100%; height: auto; display: block;"
		role="img"
		aria-label="Weight and body-fat trend chart"
	>
		<!-- gridlines (weight ticks) -->
		{#if yW}
			{#each weightTicks as t (t)}
				<line x1={x0} y1={yW(t)} x2={x1} y2={yW(t)} stroke="rgba(255,255,255,0.05)" />
				<text
					x={x0 - 6}
					y={yW(t) + 3}
					text-anchor="end"
					font-size="10"
					fill={SUBTLE}>{t.toFixed(0)}</text
				>
			{/each}
		{/if}

		<!-- right axis (body fat %) labels -->
		{#if yBf}
			{#each bfTicks as t (t)}
				<text
					x={x1 + 6}
					y={yBf(t) + 3}
					text-anchor="start"
					font-size="10"
					fill={BF_COLOR}>{t.toFixed(0)}</text
				>
			{/each}
		{/if}

		<!-- today divider -->
		{#if hasAny}
			<line
				x1={todayX}
				y1={y0}
				x2={todayX}
				y2={y1}
				stroke={SUBTLE}
				stroke-width="1"
				stroke-dasharray="3 3"
			/>
			<text x={todayX} y={y0 - 4} text-anchor="middle" font-size="10" fill={SUBTLE}>today</text>
		{/if}

		<!-- body fat: actual + projection (drawn first, under weight) -->
		{#if yBf && bfActual}
			<polyline points={bfActual} fill="none" stroke={BF_COLOR} stroke-width="2" />
			{#each bfPoints as p (p.x + ':' + p.y)}
				<circle cx={p.x} cy={p.y} r="2.5" fill={BF_COLOR} />
			{/each}
		{/if}
		{#if bfProj}
			<line
				x1={bfProj.x1}
				y1={bfProj.y1}
				x2={bfProj.x2}
				y2={bfProj.y2}
				stroke={BF_COLOR}
				stroke-width="2"
				stroke-dasharray="5 4"
				opacity="0.9"
			/>
		{/if}

		<!-- weight: actual + projection -->
		{#if yW && weightActual}
			<polyline points={weightActual} fill="none" stroke={WEIGHT_COLOR} stroke-width="2.5" />
			{#each weightPoints as p (p.x + ':' + p.y)}
				<circle cx={p.x} cy={p.y} r="3" fill={WEIGHT_COLOR} />
			{/each}
		{/if}
		{#if weightProj}
			<line
				x1={weightProj.x1}
				y1={weightProj.y1}
				x2={weightProj.x2}
				y2={weightProj.y2}
				stroke={WEIGHT_COLOR}
				stroke-width="2.5"
				stroke-dasharray="6 4"
			/>
		{/if}

		<!-- x axis labels -->
		{#each xLabels as l (l.label)}
			<text x={l.x} y={y1 + 16} text-anchor="middle" font-size="10" fill={SUBTLE}>{l.label}</text>
		{/each}
	</svg>

	<!-- legend -->
	<div
		style="display: flex; flex-wrap: wrap; gap: 12px; justify-content: center; margin-top: 6px; font-size: 11px; color: var(--color-text-muted);"
	>
		<span style="display: inline-flex; align-items: center; gap: 5px;">
			<span style="width: 16px; height: 0; border-top: 2.5px solid {WEIGHT_COLOR};"></span>
			Weight (kg)
		</span>
		<span style="display: inline-flex; align-items: center; gap: 5px;">
			<span style="width: 16px; height: 0; border-top: 2.5px dashed {WEIGHT_COLOR};"></span>
			Projected
		</span>
		{#if bfActual || bfProj}
			<span style="display: inline-flex; align-items: center; gap: 5px;">
				<span style="width: 16px; height: 0; border-top: 2px solid {BF_COLOR};"></span>
				Body fat %
			</span>
		{/if}
	</div>
</div>
