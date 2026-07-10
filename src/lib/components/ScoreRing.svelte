<script lang="ts">
	import { grade } from '$lib/score';

	let { score, size = 132 }: { score: number | null; size?: number } = $props();

	// Geometry: a stroked circle whose arc length encodes score/100.
	const stroke = $derived(Math.max(8, Math.round(size * 0.09)));
	const radius = $derived((size - stroke) / 2);
	const circumference = $derived(2 * Math.PI * radius);

	const pct = $derived(score == null ? 0 : Math.max(0, Math.min(100, score)) / 100);
	const dashOffset = $derived(circumference * (1 - pct));

	// Color ramp by score (numeric label carries the meaning too, not color alone).
	const arcColor = $derived(
		score == null
			? 'transparent'
			: score >= 90
				? '#4ade80'
				: score >= 75
					? '#fb923c'
					: score >= 50
						? '#fbbf24'
						: '#f87171'
	);

	const letter = $derived(grade(score));
	const label = $derived(
		score == null ? 'No score yet' : `Score ${Math.round(score)} out of 100, grade ${letter}`
	);
</script>

<div
	class="relative inline-grid place-items-center"
	style="width: {size}px; height: {size}px;"
	role="img"
	aria-label={label}
>
	<svg width={size} height={size} viewBox="0 0 {size} {size}" class="-rotate-90">
		<!-- Background track -->
		<circle
			cx={size / 2}
			cy={size / 2}
			r={radius}
			fill="none"
			stroke="rgba(255,255,255,0.08)"
			stroke-width={stroke}
		/>
		<!-- Foreground arc -->
		{#if score != null}
			<circle
				cx={size / 2}
				cy={size / 2}
				r={radius}
				fill="none"
				stroke={arcColor}
				stroke-width={stroke}
				stroke-linecap="round"
				stroke-dasharray={circumference}
				stroke-dashoffset={dashOffset}
				style="transition: stroke-dashoffset 600ms ease;"
			/>
		{/if}
	</svg>

	<!-- Center label. Letter + gap scale with `size` (≈ the 132 hero's old fixed
	     values) so smaller rings don't get an oversized letter shoving the number up. -->
	<div class="pointer-events-none absolute inset-0 grid place-items-center text-center">
		<div>
			<div class="leading-none font-bold text-white" style="font-size: {Math.round(size * 0.3)}px;">
				{score == null ? '—' : Math.round(score)}
			</div>
			<div
				class="leading-none font-semibold"
				style="font-size: {Math.round(size * 0.11)}px; margin-top: {Math.round(
					size * 0.03
				)}px; color: {score == null ? 'var(--color-text-subtle)' : arcColor};"
			>
				{letter}
			</div>
		</div>
	</div>
</div>
