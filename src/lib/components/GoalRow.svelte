<script lang="ts">
	import type { GoalResult } from '$lib/score';

	let { goal }: { goal: GoalResult } = $props();

	const att = $derived(goal.attainment);
	const hasData = $derived(att != null);
	// Fraction of the bar to fill (0..1).
	const fill = $derived(att == null ? 0 : Math.max(0, Math.min(1, att)));

	// Color ramp mirrors the score ring / page bars; numeric value carries meaning
	// independent of color for accessibility.
	const barColor = $derived(
		att == null ? 'transparent' : att >= 1 ? '#4ade80' : att >= 0.6 ? '#fb923c' : '#f87171'
	);

	const pctLabel = $derived(att == null ? 'no data' : `${Math.round(fill * 100)}% of target`);
</script>

<div class="py-1.5">
	<div class="flex items-baseline justify-between gap-3" style="font-size: 13px;">
		<span class="flex items-center gap-1.5" style="color: var(--color-text-muted);">
			{goal.label}
			{#if goal.met}
				<span aria-label="met" style="color: #4ade80;">✓</span>
			{/if}
		</span>
		<span class="shrink-0 font-semibold text-white tabular-nums">
			{goal.display}
			{#if !hasData}
				<span class="ml-1 font-normal" style="color: var(--color-text-subtle);">no data</span>
			{/if}
		</span>
	</div>

	<div
		class="mt-1.5 h-1.5 w-full overflow-hidden rounded-full"
		style="background: rgba(255,255,255,0.06);"
		role="progressbar"
		aria-valuemin="0"
		aria-valuemax="100"
		aria-valuenow={hasData ? Math.round(fill * 100) : undefined}
		aria-label="{goal.label}: {goal.display} — {pctLabel}"
	>
		{#if hasData}
			<div
				class="h-full rounded-full"
				style="width: {fill * 100}%; background: {barColor}; transition: width 500ms ease;"
			></div>
		{/if}
	</div>
</div>
