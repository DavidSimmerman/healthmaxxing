<script lang="ts">
	import { daysBetween, addDays, LB_PER_KG } from '$lib/energy';
	import type { WeighIn, Trend } from '$lib/server/projections';

	let {
		series,
		weight,
		leanMass,
		bodyFat,
		today,
		show = { weight: true, lean: true, bodyFat: true }
	}: {
		series: WeighIn[];
		weight: Trend | null;
		leanMass: Trend | null;
		bodyFat: Trend | null;
		today: string;
		show?: { weight: boolean; lean: boolean; bodyFat: boolean };
	} = $props();

	// Storage is kg; mass values are shown in lb when displayed numerically.
	const lb = (kg: number) => kg * LB_PER_KG;

	// ── Geometry ────────────────────────────────────────────────────────────────
	const W = 720;
	const H = 360;
	const PAD = { top: 16, right: 16, bottom: 30, left: 44 };
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

	// X domain: first weigh-in (or today) → today. Never projects past today.
	let xmin = $derived(series.length ? series[0].date : today);
	let xmax = $derived(today > xmin ? today : xmin);
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
	// Shared per-series value-at-day model (drives the crosshair).
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

			// Past the last reading but at/before today → ramp last actual → trend(today).
			if (trend && todayIndex > last.dayIndex) {
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
		return defs.filter((d) => show[d.key]).map((d) => {
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

	// ── RELATIVE view: every series as % change off its in-window baseline ─────────
	// Baseline = first actual value within the window (native unit). pct = (v-b)/b*100.
	// A straight regression line (trendAt(xmin)→trendAt(today)) is overlaid in the
	// same % space, on top of the jagged actual line.
	type RelSeries = {
		key: SeriesModel['key'];
		color: string;
		baseline: number;
		actualPts: { x: number; y: number }[]; // already in viewBox coords
		actualPolyline: string;
		trendLine: { x1: number; y1: number; x2: number; y2: number } | null; // regression overlay
	};

	let relDomain = $derived.by(() => {
		const vals: number[] = [0]; // always include the 0% baseline
		for (const m of models) {
			if (!m.actual.length) continue;
			const b = m.actual[0].value;
			if (!Number.isFinite(b) || b === 0) continue;
			for (const p of m.actual) vals.push(((p.value - b) / b) * 100);
			if (m.trend) {
				vals.push(((trendAt(m.trend, xmin) - b) / b) * 100);
				vals.push(((trendAt(m.trend, today) - b) / b) * 100);
			}
		}
		const finite = vals.filter((v) => Number.isFinite(v));
		if (finite.length <= 1) return null; // only the synthetic 0 → no real series
		const lo = Math.min(...finite);
		const hi = Math.max(...finite);
		const padPct = Math.max(0.5, (hi - lo) * 0.1);
		return { lo: lo - padPct, hi: hi + padPct };
	});
	let yRel = $derived(relDomain ? makeYOf(relDomain.lo, relDomain.hi) : null);

	let relSeries = $derived.by<RelSeries[]>(() => {
		if (!yRel) return [];
		const out: RelSeries[] = [];
		for (const m of models) {
			if (!m.actual.length) continue;
			const b = m.actual[0].value;
			if (!Number.isFinite(b) || b === 0) continue;
			const pct = (v: number) => ((v - b) / b) * 100;
			const actualPts = m.actual.map((p) => ({ x: xOfDayIndex(p.dayIndex), y: yRel!(pct(p.value)) }));
			let trendLine: RelSeries['trendLine'] = null;
			if (m.trend) {
				const py0 = pct(trendAt(m.trend, xmin));
				const py1 = pct(trendAt(m.trend, today));
				if (Number.isFinite(py0) && Number.isFinite(py1)) {
					trendLine = { x1: xOf(xmin), y1: yRel!(py0), x2: xOf(today), y2: yRel!(py1) };
				}
			}
			out.push({
				key: m.key,
				color: m.color,
				baseline: b,
				actualPts,
				actualPolyline: actualPts.map((p) => `${p.x},${p.y}`).join(' '),
				trendLine
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

	let hasAny = $derived(relSeries.length > 0);

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
		// Releasing a touch (or mouse) hides the crosshair / hover key.
		dragging = false;
		hoverDay = null;
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

	// y for a series value (native unit), or null if unplottable.
	function yForSeriesValue(key: SeriesModel['key'], value: number): number | null {
		const b = relBaselineByKey[key];
		if (b == null || b === 0 || !yRel) return null;
		return yRel(((value - b) / b) * 100);
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
		pctDelta: number | null; // %Δ off baseline
	};

	let crosshair = $derived.by(() => {
		if (hoverDay === null || !hasAny) return null;
		const day = hoverDay;
		const cx = xOfDayIndex(day);
		const date = addDays(xmin, day);
		const rows: CrosshairRow[] = [];
		for (const m of models) {
			// Skip series that aren't plotted (no/zero baseline).
			if (relBaselineByKey[m.key] == null) continue;
			const v = m.valueAt(day);
			if (v == null || !Number.isFinite(v)) continue;
			const y = yForSeriesValue(m.key, v);
			if (y == null || !Number.isFinite(y)) continue;
			const display = m.isMass ? `${lb(v).toFixed(1)} lb` : `${v.toFixed(1)} %`;
			let pctDelta: number | null = null;
			const b = relBaselineByKey[m.key];
			if (b != null && b !== 0) pctDelta = ((v - b) / b) * 100;
			rows.push({ key: m.key, label: m.label, color: m.color, valueNative: v, isMass: m.isMass, y, display, pctDelta });
		}
		if (!rows.length) return null;
		return { day, cx, date, rows };
	});

	// Tooltip: sized to its content (width:max-content) and anchored on whichever
	// side the crosshair is, with a px-accurate max-width cap, so its text can
	// never overflow the chart regardless of how small the SVG is scaled.
	const TIP_M = 6; // px margin from the rendered chart edges
	// Pin to the side OPPOSITE the crosshair and cap the width (max-width below):
	// anchoring to one edge means `edge + width` can never cross the other edge,
	// so it stays inside even on a phone-width chart with a wide (3-metric) box.
	let tipPos = $derived.by(() => {
		if (!crosshair) return '';
		return (crosshair.cx / W) * 100 > 50 ? `left: ${TIP_M}px;` : `right: ${TIP_M}px;`;
	});
</script>

<div
	style="width: 100%; position: relative; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;"
>
	<svg
		bind:this={svgEl}
		viewBox="0 0 {W} {H}"
		style="width: 100%; height: auto; display: block; touch-action: pan-y;"
		role="img"
		aria-label="Weight, lean mass, and body-fat trend chart (% change)"
	>
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

		<!-- each series: actual polyline + dots, then the straight regression overlay -->
		{#each relSeries as rs (rs.key)}
			<polyline points={rs.actualPolyline} fill="none" stroke={rs.color} stroke-width={rs.key === 'weight' ? 2.5 : 2} />
			{#each rs.actualPts as p (p.x + ':' + p.y)}
				<circle cx={p.x} cy={p.y} r={rs.key === 'weight' ? 3 : 2.5} fill={rs.color} />
			{/each}
			{#if rs.trendLine}
				<line
					x1={rs.trendLine.x1}
					y1={rs.trendLine.y1}
					x2={rs.trendLine.x2}
					y2={rs.trendLine.y2}
					stroke={rs.color}
					stroke-width="1.5"
					stroke-dasharray="5 4"
					opacity="0.7"
				/>
			{/if}
		{/each}

		<!-- x axis labels -->
		{#each xLabels as l (l.label)}
			<text x={l.x} y={y1 + 16} text-anchor="middle" font-size="10" fill={SUBTLE}>{l.label}</text>
		{/each}

		<!-- ── Crosshair ──────────────────────────────────────────────────────── -->
		{#if crosshair}
			<line x1={crosshair.cx} y1={y0} x2={crosshair.cx} y2={y1} stroke="rgba(255,255,255,0.5)" stroke-width="1" />
			{#each crosshair.rows as row (row.key)}
				<circle cx={crosshair.cx} cy={row.y} r="4" fill={row.color} stroke="#0a0a0c" stroke-width="1.5" />
			{/each}
		{/if}
	</svg>

	<!-- Tooltip (HTML overlay) -->
	{#if crosshair}
		<div
			style="position: absolute; top: {TIP_M}px; {tipPos} width: max-content; min-width: 130px; max-width: calc(100% - {2 * TIP_M}px); pointer-events: none;
				background: rgba(12,12,16,0.94); border: 1px solid rgba(255,255,255,0.12); border-radius: 8px;
				padding: 7px 9px; font-size: 11px; color: var(--color-text-muted); box-shadow: 0 4px 16px rgba(0,0,0,0.4);
				box-sizing: border-box;"
		>
			<div style="font-weight: 600; color: #e4e4e7; margin-bottom: 5px;">
				{fmtDateLong(crosshair.date)}
			</div>
			{#each crosshair.rows as row (row.key)}
				<div style="display: flex; align-items: center; gap: 6px; margin-top: 2px;">
					<span style="width: 9px; height: 9px; border-radius: 2px; background: {row.color}; flex: none;"></span>
					<span style="flex: 1; white-space: nowrap;">{row.label}</span>
					<span style="color: #e4e4e7; font-variant-numeric: tabular-nums; white-space: nowrap;">
						{row.display}{#if row.pctDelta != null}<span style="color: {SUBTLE};"> ({row.pctDelta >= 0 ? '+' : ''}{row.pctDelta.toFixed(1)}%)</span>{/if}
					</span>
				</div>
			{/each}
		</div>
	{/if}

	<!-- legend -->
	<div style="display: flex; flex-wrap: wrap; gap: 12px; justify-content: center; margin-top: 6px; font-size: 11px; color: var(--color-text-muted);">
		{#each relSeries as rs (rs.key)}
			<span style="display: inline-flex; align-items: center; gap: 5px;">
				<span style="width: 16px; height: 0; border-top: {rs.key === 'weight' ? '2.5px' : '2px'} solid {rs.color};"></span>
				{modelByKey[rs.key].label}
			</span>
		{/each}
		<span style="display: inline-flex; align-items: center; gap: 5px;">
			<span style="width: 16px; height: 0; border-top: 1.5px dashed {SUBTLE};"></span>
			Trend
		</span>
	</div>
</div>
