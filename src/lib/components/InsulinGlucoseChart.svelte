<script lang="ts">
	import { basalAreaPath, niceMax, type BasalPt } from '$lib/insulinChart';

	type Glucose = { min: number; mgdl: number };
	type Insulin = {
		min: number;
		kind: string;
		units: number;
		bolusType: string | null;
		carbs: number | null;
		bg: number | null;
		requested: number | null;
	};

	let { glucose = [], insulin = [] }: { glucose?: Glucose[]; insulin?: Insulin[] } = $props();

	// Layout (viewBox units; the SVG scales to its container width).
	const W = 720;
	const padL = 30,
		padR = 12,
		padTop = 12;
	const gH = 140; // glucose band height
	const gap = 10;
	const bH = 44; // basal band height
	const xAxisH = 16;
	const basalTop = padTop + gH + gap;
	const basalBaseline = basalTop + bH;
	const H = basalBaseline + xAxisH;
	const innerW = W - padL - padR;
	const GMIN = 40,
		GMAX = 300; // mg/dL clamp

	const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
	const X = (min: number) => padL + (clamp(min, 0, 1440) / 1440) * innerW;
	const yG = (v: number) => padTop + (1 - (clamp(v, GMIN, GMAX) - GMIN) / (GMAX - GMIN)) * gH;
	const pad2 = (n: number) => String(n).padStart(2, '0');
	const hhmm = (min: number) => `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;

	const boluses = $derived(insulin.filter((e) => e.kind === 'bolus'));
	const basals = $derived(
		insulin.filter((e) => e.kind === 'basal').map((e): BasalPt => ({ min: e.min, units: e.units }))
	);

	const maxBasal = $derived(
		niceMax(
			basals.map((b) => b.units),
			1
		)
	);
	const yBasal = (u: number) => basalBaseline - (u / maxBasal) * bH;
	const basalPath = $derived(basalAreaPath(basals, X, yBasal, basalBaseline));

	const maxBolus = $derived(
		niceMax(
			boluses.map((b) => b.units),
			1
		)
	);
	const STEM = gH * 0.55; // longest bolus stem
	const stemLen = (u: number) => (u / maxBolus) * STEM;
	const isAuto = (b: Insulin) => b.bolusType === 'Automatic Correction';

	const glucosePts = $derived(
		glucose.map((g) => `${X(g.min).toFixed(1)},${yG(g.mgdl).toFixed(1)}`).join(' ')
	);
	const hours = [0, 3, 6, 9, 12, 15, 18, 21, 24];

	const summary = $derived(
		`Intraday chart: ${glucose.length} glucose readings, ${boluses.length} boluses, ` +
			`${basals.length} basal samples.`
	);

	const bolusTitle = (b: Insulin) =>
		`${hhmm(b.min)} — ${b.units}U delivered` +
		(b.requested != null && b.requested !== b.units ? ` of ${b.requested}U` : '') +
		(b.carbs != null ? `, ${b.carbs}g carbs` : '') +
		(b.bg != null ? `, BG ${b.bg}` : '') +
		(isAuto(b) ? ' (Control-IQ auto-correction)' : '');
</script>

<figure class="m-0">
	<svg
		viewBox="0 0 {W} {H}"
		class="w-full"
		style="height:auto"
		role="img"
		aria-label={summary}
		preserveAspectRatio="xMidYMid meet"
	>
		<!-- glucose target band 70–180 -->
		<rect
			x={padL}
			y={yG(180)}
			width={innerW}
			height={yG(70) - yG(180)}
			fill="rgba(16,185,129,0.10)"
		/>
		<line
			x1={padL}
			y1={yG(70)}
			x2={W - padR}
			y2={yG(70)}
			stroke="rgba(16,185,129,0.25)"
			stroke-width="0.5"
		/>
		<line
			x1={padL}
			y1={yG(180)}
			x2={W - padR}
			y2={yG(180)}
			stroke="rgba(16,185,129,0.25)"
			stroke-width="0.5"
		/>
		<text x={padL - 4} y={yG(70) + 3} text-anchor="end" font-size="8" fill="rgba(148,163,184,0.8)"
			>70</text
		>
		<text x={padL - 4} y={yG(180) + 3} text-anchor="end" font-size="8" fill="rgba(148,163,184,0.8)"
			>180</text
		>

		<!-- vertical hour gridlines + labels -->
		{#each hours as h (h)}
			<line
				x1={X(h * 60)}
				y1={padTop}
				x2={X(h * 60)}
				y2={basalBaseline}
				stroke="rgba(148,163,184,0.10)"
				stroke-width="0.5"
			/>
			<text x={X(h * 60)} y={H - 4} text-anchor="middle" font-size="8" fill="rgba(148,163,184,0.7)">
				{h === 24 ? '24' : pad2(h)}
			</text>
		{/each}

		<!-- basal rate step-area -->
		{#if basalPath}
			<path d={basalPath} fill="rgba(56,189,248,0.20)" stroke="#38bdf8" stroke-width="1" />
		{/if}

		<!-- glucose (CGM) trace -->
		{#if glucosePts}
			<polyline
				points={glucosePts}
				fill="none"
				stroke="#f472b6"
				stroke-width="1.5"
				stroke-linejoin="round"
			/>
		{/if}

		<!-- boluses: lollipops hanging from the top, length ∝ units delivered -->
		{#each boluses as b, i (i)}
			{@const c = isAuto(b) ? '#fbbf24' : '#e2e8f0'}
			<g>
				<title>{bolusTitle(b)}</title>
				<line
					x1={X(b.min)}
					y1={padTop}
					x2={X(b.min)}
					y2={padTop + stemLen(b.units)}
					stroke={c}
					stroke-width="1.5"
				/>
				<circle cx={X(b.min)} cy={padTop + stemLen(b.units)} r="2.5" fill={c} />
			</g>
		{/each}
	</svg>

	<figcaption
		class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]"
		style="color: var(--color-text-subtle);"
	>
		<span class="flex items-center gap-1"
			><span class="inline-block h-0.5 w-3" style="background:#f472b6"></span>Glucose</span
		>
		<span class="flex items-center gap-1"
			><span class="inline-block h-2 w-3 rounded-sm" style="background:rgba(56,189,248,0.4)"
			></span>Basal rate</span
		>
		<span class="flex items-center gap-1"
			><span class="inline-block h-2 w-2 rounded-full" style="background:#e2e8f0"></span>Bolus</span
		>
		<span class="flex items-center gap-1"
			><span class="inline-block h-2 w-2 rounded-full" style="background:#fbbf24"
			></span>Auto-correction</span
		>
	</figcaption>
</figure>
