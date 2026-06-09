<script lang="ts">
	type Props = { value: number; target: number; size?: number };
	let { value, target, size = 170 }: Props = $props();

	const r = 40;
	const C = 2 * Math.PI * r;
	let hasTarget = $derived(target > 0);
	let pct = $derived(hasTarget ? Math.min(1, value / target) : 0);
	let dashoffset = $derived(C * (1 - pct));

	// Lead with what's left to eat, not what's been eaten. With no target set,
	// fall back to showing the consumed total (matches the rest of the dashboard).
	let remaining = $derived(target - value);
	let over = $derived(hasTarget && remaining < 0);
	let bigNumber = $derived(
		(hasTarget ? Math.round(Math.abs(remaining)) : Math.round(value)).toLocaleString()
	);
	let subLabel = $derived(hasTarget ? `kcal ${over ? 'over' : 'left'}` : 'kcal');
</script>

<svg width={size} height={size} viewBox="0 0 100 100">
	<defs>
		<linearGradient id="ringGrad" x1="0%" y1="0%" x2="100%" y2="100%">
			<stop offset="0%" stop-color="var(--color-accent-from)" />
			<stop offset="100%" stop-color="var(--color-accent-to)" />
		</linearGradient>
	</defs>
	<circle cx="50" cy="50" {r} stroke="#27272a" stroke-width="8" fill="none" />
	<circle
		cx="50"
		cy="50"
		{r}
		stroke="url(#ringGrad)"
		stroke-width="8"
		fill="none"
		stroke-linecap="round"
		stroke-dasharray={C}
		stroke-dashoffset={dashoffset}
		transform="rotate(-90 50 50)"
		style="transition: stroke-dashoffset 0.6s ease;"
	/>
	<text
		x="50"
		y="46"
		text-anchor="middle"
		font-size="18"
		font-weight="700"
		fill={over ? '#fb7185' : '#fff'}
	>
		{bigNumber}
	</text>
	<text x="50" y="56" text-anchor="middle" font-size="6.5" font-weight="600" fill="#a1a1aa">
		{subLabel}
	</text>
	{#if hasTarget}
		<text x="50" y="66" text-anchor="middle" font-size="5.5" fill="#71717a">
			{Math.round(value).toLocaleString()} / {target.toLocaleString()}
		</text>
	{/if}
</svg>
