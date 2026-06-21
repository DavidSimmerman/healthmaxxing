<script lang="ts">
	import { KCAL_PER_LB } from '$lib/energy';
	import { goto } from '$app/navigation';

	let { data } = $props();

	const ranges = [
		{ key: 'd', label: 'D' },
		{ key: 'w', label: 'W' },
		{ key: 'm', label: 'M' },
		{ key: '3m', label: '3M' }
	];
	const rangeTitle: Record<string, string> = {
		d: 'Today',
		w: 'This week',
		m: 'This month',
		'3m': '3 months'
	};

	// Only days where expenditure could be estimated AND something was logged
	// count toward averages — an unlogged day is missing data, not a giant deficit.
	let counted = $derived(data.days.filter((d) => d.deficitKcal !== null && d.intakeKcal > 0));
	let totalDeficit = $derived(counted.reduce((a, d) => a + (d.deficitKcal ?? 0), 0));
	let avgDeficit = $derived(counted.length ? Math.round(totalDeficit / counted.length) : null);
	let avgIntake = $derived(
		counted.length
			? Math.round(counted.reduce((a, d) => a + d.intakeKcal, 0) / counted.length)
			: null
	);
	let avgBmr = $derived(avg(counted.map((d) => d.bmrKcal)));
	let avgActive = $derived(avg(counted.map((d) => d.activeKcal)));
	let avgTef = $derived(avg(counted.map((d) => d.tefKcal)));
	let estLb = $derived(totalDeficit / KCAL_PER_LB);
	let maxBar = $derived(Math.max(...counted.map((d) => Math.abs(d.deficitKcal ?? 0)), 1));

	let bmrSource = $derived(counted.findLast((d) => d.bmrSource)?.bmrSource ?? null);
	const bmrSourceLabel: Record<string, string> = {
		katch: 'BMR via Katch-McArdle from your latest body comp',
		mifflin: 'BMR via Mifflin-St Jeor (no body-fat data — sync a weigh-in to upgrade)',
		'apple-basal': 'Using Apple Watch basal estimate (no body comp or profile yet)',
		interpolated: 'BMR interpolated from nearby weigh-ins'
	};

	function avg(values: (number | null)[]): number | null {
		const present = values.filter((v): v is number => v !== null);
		return present.length ? Math.round(present.reduce((a, b) => a + b, 0) / present.length) : null;
	}

	function dayName(date: string): string {
		return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
			weekday: 'short',
			timeZone: 'UTC'
		});
	}

	function shortDate(date: string): string {
		return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			timeZone: 'UTC'
		});
	}

	let listed = $derived([...data.days].reverse().filter((d) => d.intakeKcal > 0 || d.activeKcal));
</script>

<main
	class="mx-auto max-w-md p-6 pb-12"
	style="padding-bottom: calc(3rem + env(safe-area-inset-bottom));"
>
	<header class="mb-6 flex items-center gap-3">
		<a
			href="/"
			class="card-sm flex h-9 w-9 items-center justify-center text-white transition hover:brightness-125"
			aria-label="Back to today"
		>
			<svg
				width="16"
				height="16"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2.5"
				stroke-linecap="round"
				stroke-linejoin="round"
			>
				<path d="M15 18l-6-6 6-6" />
			</svg>
		</a>
		<div>
			<p
				class="text-xs font-semibold tracking-widest uppercase"
				style="color: var(--color-text-subtle);"
			>
				Energy balance
			</p>
			<h1 class="text-2xl font-bold text-white">{rangeTitle[data.range]}</h1>
		</div>
		<nav
			class="card-sm ml-auto flex items-center gap-0.5 p-1"
			aria-label="Range"
			data-sveltekit-noscroll
		>
			{#each ranges as r (r.key)}
				<a
					href="?range={r.key}"
					class="rounded-lg px-2.5 py-1 text-xs font-semibold transition"
					class:accent-gradient={data.range === r.key}
					style={data.range === r.key ? 'color: #000;' : 'color: var(--color-text-subtle);'}
				>
					{r.label}
				</a>
			{/each}
		</nav>
	</header>

	<input
		type="date"
		max={data.today}
		onchange={(e) => goto('/day/' + e.currentTarget.value)}
		class="card-sm mb-4 w-full px-3 py-2 text-sm text-white"
		style="color-scheme: dark; background: var(--color-bg-elevated);"
		aria-label="Jump to a specific day"
	/>

	{#if counted.length === 0}
		<div class="card p-6 text-center text-sm" style="color: var(--color-text-subtle);">
			<p class="mb-1 font-medium text-white">No deficit data yet</p>
			<p>
				Log food and sync a weigh-in from the iOS app — once both sides of the ledger exist, the
				math shows up here.
			</p>
		</div>
	{:else}
		<!-- Summary -->
		<section class="card p-5" style="border-color: rgba(251, 146, 60, 0.35);">
			<div class="flex items-baseline justify-between">
				<span class="text-sm" style="color: var(--color-text-muted);">
					{data.range === 'd' ? 'Deficit today' : 'Avg daily deficit'}
				</span>
				<span class="text-3xl font-bold tracking-tight text-white">
					{#if avgDeficit !== null}
						{avgDeficit >= 0 ? '−' : '+'}{Math.abs(avgDeficit).toLocaleString()}
					{:else}
						—
					{/if}
				</span>
			</div>
			{#if data.range !== 'd'}
				<div class="mt-1 flex items-baseline justify-between">
					<span class="text-xs" style="color: var(--color-text-subtle);">
						Total · {counted.length}
						{counted.length === 1 ? 'day' : 'days'} tracked
					</span>
					<span class="text-sm font-semibold" style="color: var(--color-accent-from);">
						{totalDeficit >= 0 ? '−' : '+'}{Math.abs(totalDeficit).toLocaleString()} kcal ≈ {Math.abs(
							estLb
						).toFixed(1)} lb
					</span>
				</div>
			{/if}
		</section>

		<!-- In / Out ledger -->
		<section class="mt-3 grid grid-cols-2 gap-2">
			<div class="card-sm p-4">
				<p
					class="mb-2 text-[10px] font-semibold tracking-widest uppercase"
					style="color: var(--color-fat);"
				>
					In · food
				</p>
				<div class="ledger-row">
					<span>{data.range === 'd' ? 'Logged' : 'Daily avg'}</span>
					<b>{avgIntake?.toLocaleString() ?? '—'}</b>
				</div>
			</div>
			<div class="card-sm p-4">
				<p
					class="mb-2 text-[10px] font-semibold tracking-widest uppercase"
					style="color: var(--color-accent-from);"
				>
					Out · burn
				</p>
				<div class="ledger-row"><span>Resting</span><b>{avgBmr?.toLocaleString() ?? '—'}</b></div>
				<div class="ledger-row"><span>Active</span><b>{avgActive?.toLocaleString() ?? '—'}</b></div>
				<div class="ledger-row"><span>Digestion</span><b>{avgTef?.toLocaleString() ?? '—'}</b></div>
			</div>
		</section>

		<!-- Daily breakdown -->
		{#if data.range !== 'd'}
			<section class="card-sm mt-3 p-4">
				<p
					class="mb-2 text-[10px] font-semibold tracking-widest uppercase"
					style="color: var(--color-text-subtle);"
				>
					Daily breakdown
				</p>
				{#each listed as day (day.date)}
					<a href="/day/{day.date}" class="ledger-row ledger-link">
						<span class="w-16 shrink-0"
							>{data.range === 'w' ? dayName(day.date) : shortDate(day.date)}</span
						>
						<div
							class="mx-2 flex-1 overflow-hidden rounded-full"
							style="height: 6px; background: rgba(255,255,255,0.07);"
						>
							{#if day.deficitKcal !== null && day.intakeKcal > 0}
								<div
									class="h-full rounded-full"
									style="width: {(Math.abs(day.deficitKcal) / maxBar) *
										100}%; background: {day.deficitKcal >= 0
										? 'linear-gradient(90deg, var(--color-accent-from), var(--color-accent-to))'
										: 'var(--color-fat)'};"
								></div>
							{/if}
						</div>
						{#if day.deficitKcal !== null && day.intakeKcal > 0}
							<b style={day.deficitKcal < 0 ? 'color: var(--color-fat);' : ''}>
								{day.deficitKcal >= 0 ? '−' : '+'}{Math.abs(day.deficitKcal)}
							</b>
						{:else}
							<b style="color: var(--color-text-subtle); font-weight: 400;">no data</b>
						{/if}
						<svg
							class="ml-1.5 shrink-0"
							width="13"
							height="13"
							viewBox="0 0 24 24"
							fill="none"
							stroke="var(--color-text-subtle)"
							stroke-width="2.5"
							stroke-linecap="round"
							stroke-linejoin="round"><path d="M9 18l6-6-6-6" /></svg
						>
					</a>
				{/each}
			</section>
		{:else if counted.length === 1}
			{@const day = counted[0]}
			<section class="card-sm mt-3 p-4">
				<p
					class="mb-2 text-[10px] font-semibold tracking-widest uppercase"
					style="color: var(--color-text-subtle);"
				>
					Today's ledger
				</p>
				<div class="ledger-row">
					<span>Eaten</span><b>{Math.round(day.intakeKcal).toLocaleString()}</b>
				</div>
				<div class="ledger-row">
					<span>Resting burn</span><b>{day.bmrKcal?.toLocaleString() ?? '—'}</b>
				</div>
				<div class="ledger-row">
					<span>Active burn</span><b>{day.activeKcal != null ? Math.round(day.activeKcal) : '—'}</b>
				</div>
				<div class="ledger-row"><span>Digestion</span><b>{day.tefKcal}</b></div>
			</section>
		{/if}

		{#if bmrSource}
			<p class="mt-4 px-1 text-center text-xs" style="color: var(--color-text-subtle);">
				{bmrSourceLabel[bmrSource]}
			</p>
		{/if}
	{/if}
</main>

<style>
	.ledger-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		font-size: 13px;
		color: var(--color-text-muted);
		padding: 3px 0;
	}
	.ledger-row b {
		color: white;
		font-weight: 600;
	}
	.ledger-link {
		text-decoration: none;
		margin: 0 -6px;
		padding: 3px 6px;
		border-radius: 8px;
		transition: background 0.12s;
	}
	.ledger-link:active {
		background: rgba(255, 255, 255, 0.05);
	}
</style>
