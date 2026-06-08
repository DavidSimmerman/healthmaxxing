<script lang="ts">
	type Props = { label: string; value: number; target?: number | null; color: string };
	let { label, value, target = null, color }: Props = $props();
	let hasTarget = $derived(target != null && target > 0);
	let pct = $derived(hasTarget ? Math.min(100, (value / (target as number)) * 100) : 0);
</script>

<div class="text-center">
	<div class="mb-1 text-xs text-text-subtle" style="color: var(--color-text-subtle);">{label}</div>
	<div class="font-bold text-white">
		{Math.round(value)}<span class="text-xs" style="color: var(--color-text-subtle);">
			{#if hasTarget}/{target}g{:else}g{/if}
		</span>
	</div>
	{#if hasTarget}
		<div class="mt-2 h-1 overflow-hidden rounded-full bg-zinc-800">
			<div class="h-full" style="width: {pct}%; background-color: {color};"></div>
		</div>
	{/if}
</div>
