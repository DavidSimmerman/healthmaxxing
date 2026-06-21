<script lang="ts">
	import { daysBetween, addDays, LB_PER_KG } from '$lib/energy';
	import type { WeighIn, Trend } from '$lib/server/projections';

	let {
		series,
		weight,
		leanMass,
		bodyFat,
		today,
		horizonEnd,
		mode = 'absolute'
	}: {
		series: WeighIn[];
		weight: Trend | null;
		leanMass: Trend | null;
		bodyFat: Trend | null;
		today: string;
		horizonEnd: string;
		mode?: 'relative' | 'absolute';
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
	// x position from a day index relative to xmin (no clamping helps crosshair math read clean)
	function xOfDayIndex(dayIndex: number): number {
		if (xSpan <= 0) return x0 + plotW / 2;
		const t = dayIndex / xSpan;
		return x0 + Math.max(0, Math.min(1, t)) * plotW;
	}

	// trend value at a date (in kg or %, same unit as the trend)
	function trendAt(t: Trend, d: string): number {
		return t.intercept + t.slopePerDay * daysBetween(t.anchorDate, d);
	}
	// trend value at a date, in lb (mass trends only)
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

	const todayIndex = $derived(daysBetween(xmin, today));

	// ════════════════════════════════════════════════════════════════════════════
	// Shared per-series value-at-day model (drives the crosshair in BOTH modes).
	// Each series exposes sorted actual {dayIndex, value-in-native-unit} points and
	// its trend. valueAt(day) returns the native-unit value (kg for mass, % for bf)
	// or null if the series has no data.
	// ════════════════════════════════════════════════════════════════════════════
	type SeriesModel = {
		key: 'weight' | 'lean' | 'bodyFat';
		label: string;
		color: string;
		trend: Trend | null;
		actual: { dayIndex: number; value: number }[]; // sorted by dayIndex, native unit
		isMass: boolean; // true → value is kg, display in lb; false → percent
		valueAt: (dayIndex: number) => number | null; // native unit
	};

	function buildActual(pick: (s: WeighIn) => number | null): { dayIndex: number; value: number }[] {
		const out: { dayIndex: number; value: number }[] = [];
		for (const s of series) {
			const v = pick(s);
			if (v != null && Number.isFinite(v)) out.push({ dayIndex: daysBetween(xmin, s.date), value: v });
		}
		return out.sort((a, b) => a.dayIndex - b.dayIndex);
	}

	function makeValueAt(
		actual: { dayIndex: number; value: number }[],
		trend: Trend | null
	): (dayIndex: number) => number | null {
		return (day: number): number | null => {
			if (!actual.length) {
				// No actuals: fall back to the trend if we have one.
				if (trend) return trendAt(trend, addDays(xmin, day));
				return null;
			}
			const first = actual[0];
			const last = actual[actual.length - 1];

			// Before the first reading → hold the first.
			if (day <= first.dayIndex) return first.value;

			// Within the actual range → linear-interpolate between brackets.
			if (day <= last.dayIndex) {
				for (let i = 0; i < actual.length - 1; i++) {
					const a = actual[i];
					const b = actual[i + 1];
					if (day >= a.dayIndex && day <= b.dayIndex) {
						const span = b.dayIndex - a.dayIndex;
						if (span <= 0) return a.value;
						const t = (day - a.dayIndex) / span;
						return a.value + t * (b.value - a.value);
					}
				}
				return last.value;
			}

			// Past the last reading.
			if (day > todayIndex && trend) {
				// In the projected region → use the trend.
				return trendAt(trend, addDays(xmin, day));
			}
			if (trend && todayIndex > last.dayIndex) {
				// Between last reading and today → ramp last actual → trend(today).
				const targetDay = Math.min(day, todayIndex);
				const span = todayIndex - last.dayIndex;
				if (span <= 0) return last.value;
				const trendToday = trendAt(trend, today);
				const t = (targetDay - last.dayIndex) / span;
				return last.value + t * (trendToday - last.value);
			}
			// No trend → hold the last reading.
			return last.value;
		};
	}

	let models = $derived.by<SeriesModel[]>(() => {
		const defs: { key: SeriesModel['key']; label: string; color: string; trend: Trend | null; isMass: boolean; pick: (s: WeighIn) => number | null }[] = [
			{ key: 'weight', label: 'Weight', color: WEIGHT_COLOR, trend: weight, isMass: true, pick: (s) => s.weightKg },
			{ key: 'lean', label: 'Lean mass', color: LEAN_COLOR, trend: leanMass, isMass: true, pick: (s) => s.leanMassKg },
			{ key: 'bodyFat', label: 'Body fat %', color: BF_COLOR, trend: bodyFat, isMass: false, pick: (s) => s.bodyFatPct }
		];
		return defs.map((d) => {
			const actual = buildActual(d.pick);
			return {
				key: d.key,
				label: d.label,
				color: d.color,
				trend: d.trend,
				actual,
				isMass: d.isMass,
				valueAt: makeValueAt(actual, d.trend)
			} satisfies SeriesModel;
		});
	});

	const modelByKey = $derived(Object.fromEntries(models.map((m) => [m.key, m])) as Record<SeriesModel['key'], SeriesModel>);

	// ── ABSOLUTE mode: mass axis (left) + body-fat axis (right) ───────────────────
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

	// Absolute polylines / points.
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

	// Projection (dashed) from today → horizonEnd along each trend (absolute mode).
	function projLine(t: Trend | null, y: ((v: number) => number) | null, lbScale: boolean) {
		if (!t || !y || xmax <= today) return null;
		const at = (d: string) => (lbScale ? trendLb(t, d) : trendAt(t, d));
		return { x1: xOf(today), y1: y(at(today)), x2: xOf(xmax), y2: y(at(xmax)) };
	}
	let weightProj = $derived(projLine(weight, yM, true));
	let leanProj = $derived(projLine(leanMass, yM, true));
	let bfProj = $derived(projLine(bodyFat, yBf, false));

	// ── RELATIVE mode: every series as % change off its in-window baseline ─────────
	// Baseline = first actual value within the window (native unit). pct = (v-b)/b*100.
	type RelSeries = {
		key: SeriesModel['key'];
		color: string;
		baseline: number;
		actualPts: { x: number; y: number }[]; // already in viewBox coords
		actualPolyline: string;
		proj: { x1: number; y1: number; x2: number; y2: number } | null;
	};

	let relDomain = $derived.by(() => {
		if (mode !== 'relative') return null;
		const vals: number[] = [0]; // always include the 0% baseline
		for (const m of models) {
			if (!m.actual.length) continue;
			const b = m.actual[0].value;
			if (!Number.isFinite(b) || b === 0) continue;
			for (const p of m.actual) vals.push(((p.value - b) / b) * 100);
			if (m.trend && xmax > today) {
				vals.push(((trendAt(m.trend, today) - b) / b) * 100);
				vals.push(((trendAt(m.trend, xmax) - b) / b) * 100);
			}
		}
		if (vals.length <= 1) return null; // only the synthetic 0 → no real series
		const lo = Math.min(...vals);
		const hi = Math.max(...vals);
		const padPct = Math.max(0.5, (hi - lo) * 0.1);
		return { lo: lo - padPct, hi: hi + padPct };
	});
	let yRel = $derived(relDomain ? makeYOf(relDomain.lo, relDomain.hi) : null);

	let relSeries = $derived.by<RelSeries[]>(() => {
		if (mode !== 'relative' || !yRel) return [];
		const out: RelSeries[] = [];
		for (const m of models) {
			if (!m.actual.length) continue;
			const b = m.actual[0].value;
			if (!Number.isFinite(b) || b === 0) continue;
			const pct = (v: number) => ((v - b) / b) * 100;
			const actualPts = m.actual.map((p) => ({ x: xOfDayIndex(p.dayIndex), y: yRel!(pct(p.value)) }));
			let proj: RelSeries['proj'] = null;
			if (m.trend && xmax > today) {
				proj = {
					x1: xOf(today),
					y1: yRel!(pct(trendAt(m.trend, today))),
					x2: xOf(xmax),
					y2: yRel!(pct(trendAt(m.trend, xmax)))
				};
			}
			out.push({
				key: m.key,
				color: m.color,
				baseline: b,
				actualPts,
				actualPolyline: actualPts.map((p) => `${p.x},${p.y}`).join(' '),
				proj
			});
		}
		return out;
	});
	const relBaselineByKey = $derived(Object.fromEntries(relSeries.map((r) => [r.key, r.baseline])) as Partial<Record<SeriesModel['key'], number>>);

	// ── Ticks ──────────────────────────────────────────────────────────────────
	function ticks(lo: number, hi: number, n = 4): number[] {
		if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi - lo < 1e-9) return [];
		const step = (hi - lo) / n;
		return Array.from({ length: n + 1 }, (_, i) => lo + step * i);
	}
	let massTicks = $derived(massDomain ? ticks(massDomain.lo, massDomain.hi) : []);
	let bfTicks = $derived(bfDomain ? ticks(bfDomain.lo, bfDomain.hi) : []);
	let relTicks = $derived(relDomain ? ticks(relDomain.lo, relDomain.hi) : []);

	function fmtDate(d: string): string {
		return new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			timeZone: 'UTC'
		});
	}
	function fmtDateLong(d: string): string {
		return new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			year: 'numeric',
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

	let hasAny = $derived(
		mode === 'relative' ? relSeries.length > 0 : series.length > 0 && yM !== null
	);

	// ════════════════════════════════════════════════════════════════════════════
	// Interactive crosshair / tooltip (mouse + touch). Self-contained state.
	// ════════════════════════════════════════════════════════════════════════════
	let svgEl: SVGSVGElement | null = $state(null);
	let hoverDay: number | null = $state(null); // snapped day index relative to xmin
	let dragging = $state(false);

	function dayFromClientX(clientX: number): number | null {
		if (!svgEl) return null;
		const r = svgEl.getBoundingClientRect();
		if (r.width <= 0) return null;
		const vbX = ((clientX - r.left) / r.width) * W;
		if (xSpan <= 0) return 0; // single-day domain
		const raw = ((vbX - x0) / plotW) * xSpan;
		const day = Math.round(raw);
		return Math.max(0, Math.min(xSpan, day));
	}

	function onPointerMove(e: PointerEvent) {
		// On touch, only track while dragging so vertical scroll still works.
		if (e.pointerType !== 'mouse' && !dragging) return;
		const d = dayFromClientX(e.clientX);
		if (d !== null) hoverDay = d;
	}
	function onPointerDown(e: PointerEvent) {
		dragging = true;
		const d = dayFromClientX(e.clientX);
		if (d !== null) hoverDay = d;
	}
	function onPointerUp() {
		dragging = false;
		// keep the crosshair visible after a tap; cleared on mouse leave
	}
	function onPointerLeave(e: PointerEvent) {
		if (e.pointerType === 'mouse') {
			hoverDay = null;
			dragging = false;
		}
	}

	// Attach pointer listeners imperatively. Svelte's delegated on* handlers on an
	// <svg> proved unreliable here; a direct addEventListener always fires.
	$effect(() => {
		const el = svgEl;
		if (!el) return;
		el.addEventListener('pointermove', onPointerMove);
		el.addEventListener('pointerdown', onPointerDown);
		el.addEventListener('pointerup', onPointerUp);
		el.addEventListener('pointerleave', onPointerLeave);
		el.addEventListener('pointercancel', onPointerUp);
		return () => {
			el.removeEventListener('pointermove', onPointerMove);
			el.removeEventListener('pointerdown', onPointerDown);
			el.removeEventListener('pointerup', onPointerUp);
			el.removeEventListener('pointerleave', onPointerLeave);
			el.removeEventListener('pointercancel', onPointerUp);
		};
	});

	// y for a series value (native unit) in the active mode, or null if unplottable.
	function yForSeriesValue(key: SeriesModel['key'], value: number): number | null {
		if (mode === 'relative') {
			const b = relBaselineByKey[key];
			if (b == null || b === 0 || !yRel) return null;
			return yRel(((value - b) / b) * 100);
		}
		const m = modelByKey[key];
		if (m.isMass) return yM ? yM(lb(value)) : null;
		return yBf ? yBf(value) : null;
	}

	// Crosshair-resolved rows for the tooltip + the on-line dots.
	type CrosshairRow = {
		key: SeriesModel['key'];
		label: string;
		color: string;
		valueNative: number; // kg or %
		isMass: boolean;
		y: number; // viewBox y at the snapped day
		display: string; // e.g. "182.4 lb" / "21.3 %"
		pctDelta: number | null; // relative-mode %Δ off baseline
	};

	let crosshair = $derived.by(() => {
		if (hoverDay === null || !hasAny) return null;
		const day = hoverDay;
		const cx = xOfDayIndex(day);
		const date = addDays(xmin, day);
		const rows: CrosshairRow[] = [];
		for (const m of models) {
			// In relative mode, skip series that aren't plotted (no/zero baseline).
			if (mode === 'relative' && relBaselineByKey[m.key] == null) continue;
			const v = m.valueAt(day);
			if (v == null || !Number.isFinite(v)) continue;
			const y = yForSeriesValue(m.key, v);
			if (y == null || !Number.isFinite(y)) continue;
			const display = m.isMass ? `${lb(v).toFixed(1)} lb` : `${v.toFixed(1)} %`;
			let pctDelta: number | null = null;
			if (mode === 'relative') {
				const b = relBaselineByKey[m.key];
				if (b != null && b !== 0) pctDelta = ((v - b) / b) * 100;
			}
			rows.push({ key: m.key, label: m.label, color: m.color, valueNative: v, isMass: m.isMass, y, display, pctDelta });
		}
		if (!rows.length) return null;
		return { day, cx, date, projected: day > todayIndex, rows };
	});

	// Tooltip box: position near the crosshair, flip to the left if near the right edge.
	const TIP_W = 150;
	let tipLeftPct = $derived.by(() => {
		if (!crosshair) return 0;
		const nearRight = crosshair.cx > x0 + plotW * 0.62;
		const px = nearRight ? crosshair.cx - TIP_W - 8 : crosshair.cx + 8;
		const clamped = Math.max(x0, Math.min(W - TIP_W - 2, px));
		return (clamped / W) * 100;
	});
</script>

<div style="width: 100%; position: relative;">
	<svg
		bind:this={svgEl}
		viewBox="0 0 {W} {H}"
		style="width: 100%; height: auto; display: block; touch-action: pan-y;"
		role="img"
		aria-label="Weight, lean mass, and body-fat trend chart"
	>
		{#if mode === 'relative'}
			<!-- ── RELATIVE MODE ───────────────────────────────────────────────── -->
			<!-- gridlines (% change ticks) -->
			{#if yRel}
				{#each relTicks as t (t)}
					<line x1={x0} y1={yRel(t)} x2={x1} y2={yRel(t)} stroke="rgba(255,255,255,0.05)" />
					<text x={x0 - 6} y={yRel(t) + 3} text-anchor="end" font-size="10" fill={SUBTLE}>
						{t > 0 ? '+' : ''}{t.toFixed(0)}%
					</text>
				{/each}
			{/if}

			<!-- 0% reference line (subtle, solid) -->
			{#if yRel}
				<line x1={x0} y1={yRel(0)} x2={x1} y2={yRel(0)} stroke="rgba(255,255,255,0.18)" stroke-width="1" />
			{/if}

			<!-- today divider -->
			{#if hasAny}
				<line x1={todayX} y1={y0} x2={todayX} y2={y1} stroke={SUBTLE} stroke-width="1" stroke-dasharray="3 3" />
				<text x={todayX} y={y0 - 4} text-anchor="middle" font-size="10" fill={SUBTLE}>today</text>
			{/if}

			<!-- each relative series: actual polyline + dots + dashed projection -->
			{#each relSeries as rs (rs.key)}
				<polyline points={rs.actualPolyline} fill="none" stroke={rs.color} stroke-width={rs.key === 'weight' ? 2.5 : 2} />
				{#each rs.actualPts as p (p.x + ':' + p.y)}
					<circle cx={p.x} cy={p.y} r={rs.key === 'weight' ? 3 : 2.5} fill={rs.color} />
				{/each}
				{#if rs.proj}
					<line x1={rs.proj.x1} y1={rs.proj.y1} x2={rs.proj.x2} y2={rs.proj.y2} stroke={rs.color} stroke-width={rs.key === 'weight' ? 2.5 : 2} stroke-dasharray="6 4" opacity="0.9" />
				{/if}
			{/each}
		{:else}
			<!-- ── ABSOLUTE MODE ───────────────────────────────────────────────── -->
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
		{/if}

		<!-- x axis labels (both modes) -->
		{#each xLabels as l (l.label)}
			<text x={l.x} y={y1 + 16} text-anchor="middle" font-size="10" fill={SUBTLE}>{l.label}</text>
		{/each}

		<!-- ── Crosshair (both modes) ─────────────────────────────────────────── -->
		{#if crosshair}
			<line x1={crosshair.cx} y1={y0} x2={crosshair.cx} y2={y1} stroke="rgba(255,255,255,0.5)" stroke-width="1" />
			{#each crosshair.rows as row (row.key)}
				<circle cx={crosshair.cx} cy={row.y} r="4" fill={row.color} stroke="#0a0a0c" stroke-width="1.5" />
			{/each}
		{/if}
	</svg>

	<!-- Tooltip (HTML overlay, both modes) -->
	{#if crosshair}
		<div
			style="position: absolute; top: 6px; left: {tipLeftPct}%; width: {TIP_W}px; pointer-events: none;
				background: rgba(12,12,16,0.94); border: 1px solid rgba(255,255,255,0.12); border-radius: 8px;
				padding: 7px 9px; font-size: 11px; color: var(--color-text-muted); box-shadow: 0 4px 16px rgba(0,0,0,0.4);"
		>
			<div style="font-weight: 600; color: #e4e4e7; margin-bottom: 5px;">
				{fmtDateLong(crosshair.date)}{#if crosshair.projected}<span style="color: {SUBTLE}; font-weight: 400;"> · projected</span>{/if}
			</div>
			{#each crosshair.rows as row (row.key)}
				<div style="display: flex; align-items: center; gap: 6px; margin-top: 2px;">
					<span style="width: 9px; height: 9px; border-radius: 2px; background: {row.color}; flex: none;"></span>
					<span style="flex: 1; white-space: nowrap;">{row.label}</span>
					<span style="color: #e4e4e7; font-variant-numeric: tabular-nums; white-space: nowrap;">
						{row.display}{#if mode === 'relative' && row.pctDelta != null}<span style="color: {SUBTLE};"> ({row.pctDelta >= 0 ? '+' : ''}{row.pctDelta.toFixed(1)}%)</span>{/if}
					</span>
				</div>
			{/each}
		</div>
	{/if}

	<!-- legend -->
	<div style="display: flex; flex-wrap: wrap; gap: 12px; justify-content: center; margin-top: 6px; font-size: 11px; color: var(--color-text-muted);">
		{#if mode === 'relative'}
			{#each relSeries as rs (rs.key)}
				<span style="display: inline-flex; align-items: center; gap: 5px;">
					<span style="width: 16px; height: 0; border-top: {rs.key === 'weight' ? '2.5px' : '2px'} solid {rs.color};"></span>
					{modelByKey[rs.key].label}
				</span>
			{/each}
			<span style="display: inline-flex; align-items: center; gap: 5px;">
				<span style="width: 16px; height: 0; border-top: 2.5px dashed {SUBTLE};"></span>
				Projected
			</span>
		{:else}
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
		{/if}
	</div>
</div>
