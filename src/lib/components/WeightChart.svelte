<script lang="ts">
	import { daysBetween, LB_PER_KG } from '$lib/energy';
	import type { WeighIn, Trend } from '$lib/server/projections';

	let {
		series,
		weight,
		leanMass,
		bodyFat,
		today,
		horizonEnd
	}: {
		series: WeighIn[];
		weight: Trend | null;
		leanMass: Trend | null;
		bodyFat: Trend | null;
		today: string;
		horizonEnd: string;
	} = $props();

	// Storage is kg; the chart shows lb. Convert at the edge.
	const lb = (kg: number) => kg * LB_PER_KG;

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
	const LEAN_COLOR = '#fda4af'; // --color-protein
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

	// trend value at a date (in kg)
	function trendAt(t: Trend, d: string): number {
		return t.intercept + t.slopePerDay * daysBetween(t.anchorDate, d);
	}
	// trend value at a date, in lb
	const trendLb = (t: Trend, d: string) => lb(trendAt(t, d));

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

	// ── Mass axis (left) — weight + lean mass share it, both in lb ────────────────
	let massDomain = $derived.by(() => {
		const vals: number[] = [];
		for (const s of series) {
			if (Number.isFinite(s.weightKg)) vals.push(lb(s.weightKg));
			if (s.leanMassKg != null && Number.isFinite(s.leanMassKg)) vals.push(lb(s.leanMassKg));
		}
		if (weight) vals.push(trendLb(weight, today), trendLb(weight, xmax));
		if (leanMass) vals.push(trendLb(leanMass, today), trendLb(leanMass, xmax));
		if (!vals.length) return null;
		return { lo: Math.min(...vals) - 2, hi: Math.max(...vals) + 2 };
	});
	let yM = $derived(massDomain ? makeYOf(massDomain.lo, massDomain.hi) : null);

	// ── Body-fat axis (right) ─────────────────────────────────────────────────────
	let bfVals = $derived(
		series.map((s) => s.bodyFatPct).filter((v): v is number => v != null && Number.isFinite(v))
	);
	let bfDomain = $derived.by(() => {
		const vals = [...bfVals];
		if (bodyFat) vals.push(trendAt(bodyFat, today), trendAt(bodyFat, xmax));
		if (!vals.length) return null;
		return { lo: Math.min(...vals) - 1, hi: Math.max(...vals) + 1 };
	});
	let yBf = $derived(bfDomain ? makeYOf(bfDomain.lo, bfDomain.hi) : null);

	// ── Polylines / points ────────────────────────────────────────────────────────
	let weightActual = $derived(yM ? series.map((s) => `${xOf(s.date)},${yM!(lb(s.weightKg))}`).join(' ') : '');
	let weightPoints = $derived(yM ? series.map((s) => ({ x: xOf(s.date), y: yM!(lb(s.weightKg)) })) : []);

	let leanSeries = $derived(series.filter((s) => s.leanMassKg != null && Number.isFinite(s.leanMassKg)));
	let leanActual = $derived(
		yM ? leanSeries.map((s) => `${xOf(s.date)},${yM!(lb(s.leanMassKg as number))}`).join(' ') : ''
	);
	let leanPoints = $derived(
		yM ? leanSeries.map((s) => ({ x: xOf(s.date), y: yM!(lb(s.leanMassKg as number)) })) : []
	);

	let bfActualSeries = $derived(series.filter((s) => s.bodyFatPct != null && Number.isFinite(s.bodyFatPct)));
	let bfActual = $derived(
		yBf ? bfActualSeries.map((s) => `${xOf(s.date)},${yBf!(s.bodyFatPct as number)}`).join(' ') : ''
	);
	let bfPoints = $derived(
		yBf ? bfActualSeries.map((s) => ({ x: xOf(s.date), y: yBf!(s.bodyFatPct as number) })) : []
	);

	// Projection (dashed) from today → horizonEnd along each trend.
	function projLine(t: Trend | null, y: ((v: number) => number) | null, lbScale: boolean) {
		if (!t || !y || xmax <= today) return null;
		const at = (d: string) => (lbScale ? trendLb(t, d) : trendAt(t, d));
		return { x1: xOf(today), y1: y(at(today)), x2: xOf(xmax), y2: y(at(xmax)) };
	}
	let weightProj = $derived(projLine(weight, yM, true));
	let leanProj = $derived(projLine(leanMass, yM, true));
	let bfProj = $derived(projLine(bodyFat, yBf, false));

	// ── Ticks ──────────────────────────────────────────────────────────────────
	function ticks(lo: number, hi: number, n = 4): number[] {
		if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi - lo < 1e-9) return [];
		const step = (hi - lo) / n;
		return Array.from({ length: n + 1 }, (_, i) => lo + step * i);
	}
	let massTicks = $derived(massDomain ? ticks(massDomain.lo, massDomain.hi) : []);
	let bfTicks = $derived(bfDomain ? ticks(bfDomain.lo, bfDomain.hi) : []);

	function fmtDate(d: string): string {
		return new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			timeZone: 'UTC'
		});
	}

	let xLabels = $derived.by(() => {
		const out: { x: number; label: string }[] = [];
		out.push({ x: xOf(xmin), label: fmtDate(xmin) });
		if (xmax > xmin) out.push({ x: xOf(xmax), label: fmtDate(xmax) });
		return out;
	});

	let todayX = $derived(xOf(today));
	let hasAny = $derived(series.length > 0 && yM !== null);
</script>

<div style="width: 100%;">
	<svg
		viewBox="0 0 {W} {H}"
		style="width: 100%; height: auto; display: block;"
		role="img"
		aria-label="Weight, lean mass, and body-fat trend chart"
	>
		<!-- gridlines (mass ticks, lb) -->
		{#if yM}
			{#each massTicks as t (t)}
				<line x1={x0} y1={yM(t)} x2={x1} y2={yM(t)} stroke="rgba(255,255,255,0.05)" />
				<text x={x0 - 6} y={yM(t) + 3} text-anchor="end" font-size="10" fill={SUBTLE}>{t.toFixed(0)}</text>
			{/each}
		{/if}

		<!-- right axis (body fat %) labels -->
		{#if yBf}
			{#each bfTicks as t (t)}
				<text x={x1 + 6} y={yBf(t) + 3} text-anchor="start" font-size="10" fill={BF_COLOR}>{t.toFixed(0)}</text>
			{/each}
		{/if}

		<!-- today divider -->
		{#if hasAny}
			<line x1={todayX} y1={y0} x2={todayX} y2={y1} stroke={SUBTLE} stroke-width="1" stroke-dasharray="3 3" />
			<text x={todayX} y={y0 - 4} text-anchor="middle" font-size="10" fill={SUBTLE}>today</text>
		{/if}

		<!-- body fat: actual + projection (under the mass lines) -->
		{#if yBf && bfActual}
			<polyline points={bfActual} fill="none" stroke={BF_COLOR} stroke-width="2" />
			{#each bfPoints as p (p.x + ':' + p.y)}
				<circle cx={p.x} cy={p.y} r="2.5" fill={BF_COLOR} />
			{/each}
		{/if}
		{#if bfProj}
			<line x1={bfProj.x1} y1={bfProj.y1} x2={bfProj.x2} y2={bfProj.y2} stroke={BF_COLOR} stroke-width="2" stroke-dasharray="5 4" opacity="0.9" />
		{/if}

		<!-- lean mass: actual + projection -->
		{#if yM && leanActual}
			<polyline points={leanActual} fill="none" stroke={LEAN_COLOR} stroke-width="2" />
			{#each leanPoints as p (p.x + ':' + p.y)}
				<circle cx={p.x} cy={p.y} r="2.5" fill={LEAN_COLOR} />
			{/each}
		{/if}
		{#if leanProj}
			<line x1={leanProj.x1} y1={leanProj.y1} x2={leanProj.x2} y2={leanProj.y2} stroke={LEAN_COLOR} stroke-width="2" stroke-dasharray="5 4" opacity="0.9" />
		{/if}

		<!-- weight: actual + projection (on top) -->
		{#if yM && weightActual}
			<polyline points={weightActual} fill="none" stroke={WEIGHT_COLOR} stroke-width="2.5" />
			{#each weightPoints as p (p.x + ':' + p.y)}
				<circle cx={p.x} cy={p.y} r="3" fill={WEIGHT_COLOR} />
			{/each}
		{/if}
		{#if weightProj}
			<line x1={weightProj.x1} y1={weightProj.y1} x2={weightProj.x2} y2={weightProj.y2} stroke={WEIGHT_COLOR} stroke-width="2.5" stroke-dasharray="6 4" />
		{/if}

		<!-- x axis labels -->
		{#each xLabels as l (l.label)}
			<text x={l.x} y={y1 + 16} text-anchor="middle" font-size="10" fill={SUBTLE}>{l.label}</text>
		{/each}
	</svg>

	<!-- legend -->
	<div style="display: flex; flex-wrap: wrap; gap: 12px; justify-content: center; margin-top: 6px; font-size: 11px; color: var(--color-text-muted);">
		<span style="display: inline-flex; align-items: center; gap: 5px;">
			<span style="width: 16px; height: 0; border-top: 2.5px solid {WEIGHT_COLOR};"></span>
			Weight (lb)
		</span>
		{#if leanActual || leanProj}
			<span style="display: inline-flex; align-items: center; gap: 5px;">
				<span style="width: 16px; height: 0; border-top: 2px solid {LEAN_COLOR};"></span>
				Lean mass (lb)
			</span>
		{/if}
		{#if bfActual || bfProj}
			<span style="display: inline-flex; align-items: center; gap: 5px;">
				<span style="width: 16px; height: 0; border-top: 2px solid {BF_COLOR};"></span>
				Body fat %
			</span>
		{/if}
		<span style="display: inline-flex; align-items: center; gap: 5px;">
			<span style="width: 16px; height: 0; border-top: 2.5px dashed {SUBTLE};"></span>
			Projected
		</span>
	</div>
</div>
