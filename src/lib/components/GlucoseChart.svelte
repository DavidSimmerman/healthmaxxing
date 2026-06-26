<script lang="ts">
	import { TIR_LOW, TIR_HIGH } from '$lib/glucose';

	// Intraday CGM trace: one point per ~5-min reading, x = local hour-of-day (0–24).
	let { points }: { points: { hour: number; mgdl: number }[] } = $props();

	// ── Geometry (mirrors WeightChart: plain SVG, no chart lib) ──
	const W = 720;
	const H = 220;
	const PAD = { top: 12, right: 14, bottom: 22, left: 34 };
	const x0 = PAD.left;
	const x1 = W - PAD.right;
	const y1 = H - PAD.bottom;
	const plotW = x1 - x0;
	const plotH = y1 - PAD.top;

	const SUBTLE = '#71717a';

	const vals = $derived(points.map((p) => p.mgdl));
	const yMin = 40;
	const yMax = $derived(vals.length ? Math.max(240, Math.ceil(Math.max(...vals) / 20) * 20) : 240);

	const xOf = (h: number) => x0 + (Math.max(0, Math.min(24, h)) / 24) * plotW;
	const yOf = (v: number) =>
		y1 - ((Math.max(yMin, Math.min(yMax, v)) - yMin) / (yMax - yMin)) * plotH;

	// Break the line across sensor gaps (>~30 min) instead of drawing a flat bridge.
	const path = $derived(
		points.reduce((d, p, i) => {
			const cmd = i > 0 && p.hour - points[i - 1].hour > 0.6 ? 'M' : d ? 'L' : 'M';
			return `${d}${cmd}${xOf(p.hour).toFixed(1)},${yOf(p.mgdl).toFixed(1)} `;
		}, '')
	);
	const outOfRange = $derived(points.filter((p) => p.mgdl < TIR_LOW || p.mgdl > TIR_HIGH));

	const xTicks = [
		{ h: 0, label: '12a' },
		{ h: 6, label: '6a' },
		{ h: 12, label: '12p' },
		{ h: 18, label: '6p' },
		{ h: 24, label: '12a' }
	];
</script>

<svg viewBox="0 0 {W} {H}" class="w-full" role="img" aria-label="Glucose over the day">
	<!-- target band 70–180 -->
	<rect
		x={x0}
		y={yOf(TIR_HIGH)}
		width={plotW}
		height={yOf(TIR_LOW) - yOf(TIR_HIGH)}
		fill="rgba(34,197,94,0.10)"
	/>
	<!-- threshold lines + labels -->
	{#each [TIR_LOW, TIR_HIGH, yMax] as v (v)}
		<line
			x1={x0}
			x2={x1}
			y1={yOf(v)}
			y2={yOf(v)}
			stroke="rgba(148,163,184,0.25)"
			stroke-dasharray="3 3"
		/>
		<text x={x0 - 6} y={yOf(v) + 3} text-anchor="end" font-size="10" fill={SUBTLE}>{v}</text>
	{/each}

	<!-- x-axis labels -->
	{#each xTicks as t (t.h)}
		<text x={xOf(t.h)} y={H - 6} text-anchor="middle" font-size="10" fill={SUBTLE}>{t.label}</text>
	{/each}

	<!-- glucose trace -->
	<path
		d={path}
		fill="none"
		stroke="#e2e8f0"
		stroke-width="1.5"
		stroke-linejoin="round"
		stroke-linecap="round"
	/>

	<!-- out-of-range readings highlighted -->
	{#each outOfRange as p, i (i)}
		<circle
			cx={xOf(p.hour)}
			cy={yOf(p.mgdl)}
			r="1.8"
			fill={p.mgdl < TIR_LOW ? '#f87171' : '#fbbf24'}
		/>
	{/each}
</svg>
