<script lang="ts">
	import type { GoalResult } from '$lib/score';

	// One Apple-Fitness-style progress ring for a single goal. Arc fills to the
	// goal's attainment (0..1); value sits in the center, label below. Color ramp
	// and the numeric value both carry meaning (not color alone) for accessibility.
	let { goal, size = 78 }: { goal: GoalResult; size?: number } = $props();

	const att = $derived(goal.attainment);
	const hasData = $derived(att != null);
	const fill = $derived(att == null ? 0 : Math.max(0, Math.min(1, att)));
	const color = $derived(
		att == null ? 'transparent' : att >= 1 ? '#4ade80' : att >= 0.6 ? '#fb923c' : '#f87171'
	);

	const STROKE = 9;
	const r = $derived((size - STROKE) / 2);
	const c = $derived(size / 2);
	const circ = $derived(2 * Math.PI * r);
</script>

<div class="flex flex-col items-center gap-1.5">
	<div class="relative" style="width: {size}px; height: {size}px;">
		<svg
			width={size}
			height={size}
			viewBox="0 0 {size} {size}"
			role="img"
			aria-label="{goal.label}: {goal.display}{hasData
				? ` — ${Math.round(fill * 100)}% of target${goal.met ? ', met' : ''}`
				: ' — no data'}"
		>
			<circle cx={c} cy={c} {r} fill="none" stroke="rgba(255,255,255,0.07)" stroke-width={STROKE} />
			{#if hasData && fill > 0}
				<circle
					cx={c}
					cy={c}
					{r}
					fill="none"
					stroke={color}
					stroke-width={STROKE}
					stroke-linecap="round"
					stroke-dasharray="{fill * circ} {circ}"
					transform="rotate(-90 {c} {c})"
					style="transition: stroke-dasharray 600ms ease;"
				/>
			{/if}
		</svg>
		<div class="absolute inset-0 flex items-center justify-center px-1">
			<span
				class="font-bold text-white tabular-nums"
				style="font-size: 12px; line-height: 1; text-align: center;"
			>
				{hasData ? goal.display : '—'}
			</span>
		</div>
	</div>
	<span
		class="text-center"
		style="font-size: 10px; line-height: 1.15; color: var(--color-text-subtle); max-width: {size +
			14}px;"
	>
		{goal.label}{#if goal.met}<span style="color: #4ade80;"> ✓</span>{/if}
	</span>
</div>
