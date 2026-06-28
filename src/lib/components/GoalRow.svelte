<script lang="ts">
	import type { GoalResult } from '$lib/score';

	let { goal }: { goal: GoalResult } = $props();

	const att = $derived(goal.attainment);
	const hasData = $derived(att != null);

	// Bankable goal carrying weekly bank(+)/debt(−). The bar then spans the real
	// target plus any debt, with a gold (bank) or red (debt) zone capping the right.
	const bankable = $derived(goal.target != null && goal.balance != null);
	const T = $derived(goal.target ?? 0);
	const bal = $derived(goal.balance ?? 0);
	const bank = $derived(bal > 0 ? bal : 0);
	const debt = $derived(bal < 0 ? -bal : 0);
	const barMax = $derived(T + debt); // = T for bank or zero balance
	const V = $derived(goal.value ?? 0);

	// Value fill: along the (possibly debt-extended) bar for bankable goals, else
	// the usual attainment fill (full when met so it doesn't read as a near-miss).
	const fill = $derived(
		!hasData
			? 0
			: bankable
				? Math.max(0, Math.min(1, V / barMax))
				: goal.met
					? 1
					: Math.max(0, Math.min(1, att ?? 0))
	);

	// Green once met; otherwise orange/red by attainment. Value carries meaning
	// independent of colour for accessibility.
	const fillColor = $derived(
		att == null ? 'transparent' : goal.met ? '#4ade80' : att >= 0.6 ? '#fb923c' : '#f87171'
	);

	// Carry-over zone always runs to the right end of the bar; its left edge is the
	// bank-lowered threshold (gold) or the target marker (red, debt beyond it).
	const showZone = $derived(bankable && (bank > 0 || debt > 0));
	const zoneLeftPct = $derived(((bank > 0 ? T - bank : T) / barMax) * 100);
	const zoneColor = $derived(bank > 0 ? 'rgba(245,196,75,0.45)' : 'rgba(248,113,113,0.45)');

	const showBadge = $derived(bankable && Math.round(Math.abs(bal)) >= 1);
	const badgeColor = $derived(bank > 0 ? '#f5c44b' : '#f87171');
	const badgeText = $derived(`${bank > 0 ? '+' : '−'}${Math.round(Math.abs(bal))}`);

	const pctLabel = $derived(
		!hasData
			? 'no data'
			: showBadge
				? `${goal.display}, ${bank > 0 ? `${Math.round(bank)} banked` : `${Math.round(debt)} debt`}`
				: `${Math.round(fill * 100)}% of target`
	);
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
			{#if showBadge}
				<span style="color: {badgeColor};">({badgeText})</span>
			{/if}
			{#if !hasData}
				<span class="ml-1 font-normal" style="color: var(--color-text-subtle);">no data</span>
			{/if}
		</span>
	</div>

	<div
		class="relative mt-1.5 h-1.5 w-full overflow-hidden rounded-full"
		style="background: rgba(255,255,255,0.06);"
		role="progressbar"
		aria-valuemin="0"
		aria-valuemax="100"
		aria-valuenow={hasData ? Math.round(fill * 100) : undefined}
		aria-label="{goal.label}: {pctLabel}"
	>
		{#if showZone}
			<div
				class="absolute inset-y-0 right-0"
				style="left: {zoneLeftPct}%; background: {zoneColor};"
			></div>
		{/if}
		{#if hasData}
			<div
				class="absolute inset-y-0 left-0 rounded-full"
				style="width: {fill * 100}%; background: {fillColor}; transition: width 500ms ease;"
			></div>
		{/if}
	</div>
</div>
