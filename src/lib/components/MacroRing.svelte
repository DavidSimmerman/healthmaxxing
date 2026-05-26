<script lang="ts">
	type Props = { value: number; target: number; size?: number };
	let { value, target, size = 170 }: Props = $props();

	const r = 40;
	const C = 2 * Math.PI * r;
	let pct = $derived(target > 0 ? Math.min(1, value / target) : 0);
	let dashoffset = $derived(C * (1 - pct));
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
	<text x="50" y="48" text-anchor="middle" font-size="18" font-weight="700" fill="#fff">
		{Math.round(value).toLocaleString()}
	</text>
	<text x="50" y="62" text-anchor="middle" font-size="7" fill="#71717a">
		/ {target.toLocaleString()} kcal
	</text>
</svg>
