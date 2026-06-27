<script lang="ts">
	// A small labelled progress ring that links somewhere. Used for the Goal and
	// Deficit rings flanking the central calorie ring on the home page.
	type Props = {
		value: number | null;
		target?: number | null;
		label: string;
		sublabel?: string;
		unit?: string;
		color?: string;
		size?: number;
		href: string;
		ariaLabel: string;
	};
	let {
		value,
		target = null,
		label,
		sublabel,
		unit,
		color = '#4ade80',
		size = 92,
		href,
		ariaLabel
	}: Props = $props();

	const r = 40;
	const C = 2 * Math.PI * r;
	let hasTarget = $derived(target != null && target > 0);
	// Clamp to 0..1; a surplus (negative deficit) just shows an empty ring.
	let pct = $derived(hasTarget && value != null ? Math.max(0, Math.min(1, value / target!)) : 0);
	let dashoffset = $derived(C * (1 - pct));
	let big = $derived(value == null ? '–' : Math.round(value).toLocaleString());
</script>

<a
	{href}
	aria-label={ariaLabel}
	class="flex flex-col items-center gap-1 transition active:scale-95"
>
	<svg width={size} height={size} viewBox="0 0 100 100">
		<circle cx="50" cy="50" {r} stroke="#27272a" stroke-width="9" fill="none" />
		<circle
			cx="50"
			cy="50"
			{r}
			stroke={color}
			stroke-width="9"
			fill="none"
			stroke-linecap="round"
			stroke-dasharray={C}
			stroke-dashoffset={dashoffset}
			transform="rotate(-90 50 50)"
			style="transition: stroke-dashoffset 0.6s ease;"
		/>
		<text x="50" y="49" text-anchor="middle" font-size="20" font-weight="700" fill="#fff">
			{big}
		</text>
		{#if unit && value != null}
			<text x="50" y="62" text-anchor="middle" font-size="8" font-weight="600" fill="#a1a1aa">
				{unit}
			</text>
		{/if}
	</svg>
	<span class="text-xs font-semibold text-white">{label}</span>
	{#if sublabel}
		<span class="text-[10px]" style="color: var(--color-text-subtle);">{sublabel}</span>
	{/if}
</a>
