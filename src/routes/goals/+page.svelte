<script lang="ts">
	import { pullToRefresh } from '$lib/actions/pullToRefresh';
	import ScoreRing from '$lib/components/ScoreRing.svelte';
	import GoalRow from '$lib/components/GoalRow.svelte';

	let { data } = $props();
	const view = $derived(data.view);

	function fmt(date: string, opts: Intl.DateTimeFormatOptions): string {
		return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', ...opts });
	}

	const selectedLabel = $derived(
		fmt(data.date, { weekday: 'long', month: 'short', day: 'numeric' })
	);
	const weekLabel = $derived(
		`${fmt(data.weekDays[0].date, { month: 'short', day: 'numeric' })} – ${fmt(data.weekDays[6].date, { month: 'short', day: 'numeric' })}`
	);

	function dateHref(d: string): string {
		return `/goals?date=${d}`;
	}

	// Day-ring color ramp (mirrors ScoreRing / GoalRow).
	function ringColor(score: number | null): string {
		if (score == null) return 'transparent';
		if (score >= 90) return '#4ade80';
		if (score >= 75) return '#fb923c';
		if (score >= 50) return '#fbbf24';
		return '#f87171';
	}

	// Day-ring geometry (small).
	const SZ = 40;
	const STK = 4;
	const R = (SZ - STK) / 2;
	const CIRC = 2 * Math.PI * R;
</script>

<main
	class="mx-auto max-w-md p-6 pb-12"
	style="padding-bottom: calc(3rem + env(safe-area-inset-bottom));"
	use:pullToRefresh
>
	<!-- Header -->
	<header class="mb-5 flex items-center gap-3">
		<a
			href="/"
			class="card-sm flex h-9 w-9 shrink-0 items-center justify-center text-white transition hover:brightness-125"
			aria-label="Back to today"
		>
			<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
		</a>
		<div class="min-w-0">
			<p class="text-xs font-semibold tracking-widest uppercase" style="color: var(--color-text-subtle);">Performance</p>
			<h1 class="truncate text-2xl font-bold text-white">Goals</h1>
		</div>
	</header>

	<!-- Week strip -->
	<section class="card mb-4 p-4">
		<div class="mb-3 flex items-center justify-between">
			<a
				href={dateHref(data.prevWeekDate)}
				class="flex h-8 w-8 items-center justify-center rounded-lg text-white transition hover:brightness-125"
				aria-label="Previous week"
			>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
			</a>
			<span class="text-sm font-medium text-white">{weekLabel}</span>
			<a
				href={data.nextWeekDate ? dateHref(data.nextWeekDate) : undefined}
				aria-disabled={!data.nextWeekDate}
				class="flex h-8 w-8 items-center justify-center rounded-lg text-white transition hover:brightness-125 aria-disabled:pointer-events-none aria-disabled:opacity-30"
				aria-label="Next week"
			>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6" /></svg>
			</a>
		</div>

		<div class="flex justify-between">
			{#each data.weekDays as day (day.date)}
				{@const pct = day.score == null ? 0 : Math.max(0, Math.min(100, day.score)) / 100}
				<svelte:element
					this={day.future ? 'div' : 'a'}
					href={day.future ? undefined : dateHref(day.date)}
					aria-current={day.selected ? 'date' : undefined}
					aria-disabled={day.future ? true : undefined}
					class="flex flex-col items-center gap-1 rounded-xl px-1.5 py-1.5 transition"
					style={day.selected ? 'background: rgba(255,255,255,0.10);' : ''}
					class:opacity-30={day.future}
				>
					<span class="text-[10px] font-semibold" style="color: var(--color-text-subtle);">
						{fmt(day.date, { weekday: 'narrow' })}
					</span>
					<span class="relative grid place-items-center" style="width: {SZ}px; height: {SZ}px;">
						<svg width={SZ} height={SZ} viewBox="0 0 {SZ} {SZ}" class="-rotate-90">
							<circle cx={SZ / 2} cy={SZ / 2} r={R} fill="none" stroke="rgba(255,255,255,0.08)" stroke-width={STK} />
							{#if day.score != null}
								<circle
									cx={SZ / 2}
									cy={SZ / 2}
									r={R}
									fill="none"
									stroke={ringColor(day.score)}
									stroke-width={STK}
									stroke-linecap="round"
									stroke-dasharray={CIRC}
									stroke-dashoffset={CIRC * (1 - pct)}
								/>
							{/if}
						</svg>
						<span
							class="absolute text-[11px] font-bold tabular-nums"
							style="color: {day.selected ? '#fff' : 'var(--color-text-subtle)'};"
						>
							{fmt(day.date, { day: 'numeric' })}
						</span>
					</span>
				</svelte:element>
			{/each}
		</div>
	</section>

	<!-- Selected day -->
	<p class="mb-2 px-1 text-sm font-semibold text-white">{selectedLabel}</p>

	<!-- Hero -->
	<section class="card mb-3 flex items-center gap-5 p-5">
		<ScoreRing score={view.score} />
		<div class="min-w-0 flex-1">
			{#if view.score == null}
				<p class="text-sm" style="color: var(--color-text-subtle);">No data yet — connect your sources.</p>
			{:else}
				<div class="flex items-baseline gap-2">
					<span class="text-lg font-bold text-white">Grade {view.grade}</span>
				</div>
				{#if view.streak > 0}
					<div class="mt-2 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold" style="background: rgba(251,146,60,0.15); color: #fb923c;">
						🔥 {view.streak}-day streak
					</div>
				{/if}
				{#if view.bonus > 0}
					<p class="mt-2 text-xs" style="color: var(--color-text-subtle);">
						{Math.round(view.base ?? 0)} base · +{Math.round(view.bonus)} bonus
					</p>
				{/if}
			{/if}
		</div>
	</section>

	<!-- Daily goals -->
	<section class="card mb-3 p-5">
		<p class="mb-3 text-[10px] font-semibold tracking-widest uppercase" style="color: var(--color-accent-from);">Daily goals</p>
		{#each view.goals as goal (goal.key)}
			<GoalRow {goal} />
		{/each}
	</section>

	<!-- Weekly goals -->
	<section class="card mb-3 p-5">
		<p class="mb-3 text-[10px] font-semibold tracking-widest uppercase" style="color: var(--color-carbs);">Weekly goals</p>
		{#each view.weeklyGoals as goal (goal.key)}
			<GoalRow {goal} />
		{/each}
	</section>
</main>
