<script lang="ts">
	import { pullToRefresh } from '$lib/actions/pullToRefresh';
	import ScoreRing from '$lib/components/ScoreRing.svelte';
	import GoalRow from '$lib/components/GoalRow.svelte';
	import GoalRing from '$lib/components/GoalRing.svelte';

	// Apple-Fitness-style rings by default; List = the precise progress bars.
	let ringView = $state(true);

	let { data } = $props();

	const view = $derived(data.view);
	const isPeriod = $derived(data.period !== 'day');

	function fmtDate(date: string): string {
		return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
			weekday: 'short',
			month: 'short',
			day: 'numeric',
			timeZone: 'UTC'
		});
	}
	function fmtShort(date: string): string {
		return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			timeZone: 'UTC'
		});
	}

	// Header date label: a single day, or a from–to range for week/month.
	const dateLabel = $derived(
		data.period === 'day' ? fmtDate(data.date) : `${fmtShort(view.from)} – ${fmtShort(view.to)}`
	);

	// Preserve the selected date across the period toggle.
	function periodHref(p: 'day' | 'week' | 'month'): string {
		return `/goals?period=${p}&date=${data.date}`;
	}
	function dateHref(d: string): string {
		return `/goals?period=${data.period}&date=${d}`;
	}

	const periods = [
		{ key: 'day', label: 'Day' },
		{ key: 'week', label: 'Week' },
		{ key: 'month', label: 'Month' }
	] as const;

	// Day-bar color ramp (mirrors GoalRow / ScoreRing).
	function barColor(score: number | null): string {
		if (score == null) return 'rgba(255,255,255,0.10)';
		if (score >= 90) return '#4ade80';
		if (score >= 75) return '#fb923c';
		if (score >= 50) return '#fbbf24';
		return '#f87171';
	}
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
		<div class="min-w-0">
			<p
				class="text-xs font-semibold tracking-widest uppercase"
				style="color: var(--color-text-subtle);"
			>
				Performance
			</p>
			<h1 class="truncate text-2xl font-bold text-white">Goals</h1>
		</div>
	</header>

	<!-- Period toggle -->
	<nav class="mb-3 flex gap-1 rounded-full bg-white/5 p-1" aria-label="Period">
		{#each periods as p (p.key)}
			<a
				href={periodHref(p.key)}
				aria-current={data.period === p.key ? 'page' : undefined}
				class="flex-1 rounded-full px-3 py-2 text-center text-sm font-semibold transition"
				class:accent-gradient={data.period === p.key}
				class:text-white={data.period === p.key}
				style={data.period === p.key ? '' : 'color: #e5e5e7;'}
			>
				{p.label}
			</a>
		{/each}
	</nav>

	<!-- Date nav -->
	<nav class="card-sm mb-4 flex items-center justify-between p-1" aria-label="Navigate dates">
		<a
			href={dateHref(data.prevDate)}
			class="flex h-8 w-8 items-center justify-center rounded-lg text-white transition hover:brightness-125"
			aria-label="Previous {data.period}"
		>
			<svg
				width="14"
				height="14"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2.5"
				stroke-linecap="round"
				stroke-linejoin="round"><path d="M15 18l-6-6 6-6" /></svg
			>
		</a>
		<span class="text-sm font-medium text-white">{dateLabel}</span>
		<a
			href={data.date < data.today ? dateHref(data.nextDate) : undefined}
			aria-disabled={data.date >= data.today}
			class="flex h-8 w-8 items-center justify-center rounded-lg text-white transition hover:brightness-125 aria-disabled:pointer-events-none aria-disabled:opacity-30"
			aria-label="Next {data.period}"
		>
			<svg
				width="14"
				height="14"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2.5"
				stroke-linecap="round"
				stroke-linejoin="round"><path d="M9 18l6-6-6-6" /></svg
			>
		</a>
	</nav>

	<!-- Hero -->
	<section class="card mb-3 flex items-center gap-5 p-5">
		<ScoreRing score={view.score} />
		<div class="min-w-0 flex-1">
			{#if view.score == null}
				<p class="text-sm" style="color: var(--color-text-subtle);">
					No data yet — connect your sources.
				</p>
			{:else}
				<div class="flex items-baseline gap-2">
					<span class="text-lg font-bold text-white">Grade {view.grade}</span>
				</div>
				{#if view.streak > 0}
					<div
						class="mt-2 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold"
						style="background: rgba(251,146,60,0.15); color: #fb923c;"
					>
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

	<!-- Per-day bars (week / month) -->
	{#if isPeriod && view.dayScores.length}
		<section class="card mb-3 p-5">
			<p
				class="mb-3 text-[10px] font-semibold tracking-widest uppercase"
				style="color: var(--color-text-subtle);"
			>
				Daily scores
			</p>
			<div
				class="flex h-20 items-end gap-1"
				role="img"
				aria-label="Per-day scores across the period"
			>
				{#each view.dayScores as d (d.date)}
					{@const h = d.score == null ? 6 : Math.max(6, Math.round((d.score / 100) * 76))}
					<div class="flex flex-1 flex-col items-center justify-end gap-1" style="min-width: 3px;">
						{#if d.perfect}
							<span class="h-1.5 w-1.5 rounded-full" style="background: #4ade80;" aria-hidden="true"
							></span>
						{/if}
						<div
							class="w-full rounded-sm"
							style="height: {h}px; background: {d.veryBad ? '#7f1d1d' : barColor(d.score)};"
							title="{fmtShort(d.date)}: {d.score == null ? 'no data' : Math.round(d.score)}"
						></div>
					</div>
				{/each}
			</div>
			<p class="mt-3 text-xs" style="color: var(--color-text-subtle);">
				{view.perfectDays} perfect · {view.veryBadDays} very-bad days
			</p>
		</section>
	{/if}

	<!-- Daily goals -->
	<section class="card mb-3 p-5">
		<div class="mb-3 flex items-center justify-between gap-3">
			<p
				class="text-[10px] font-semibold tracking-widest uppercase"
				style="color: var(--color-accent-from);"
			>
				Daily goals
			</p>
			<div
				class="flex gap-0.5 rounded-full p-0.5"
				style="background: var(--color-bg-elevated);"
				role="group"
				aria-label="Goal view"
			>
				<button
					onclick={() => (ringView = true)}
					aria-pressed={ringView}
					class="rounded-full px-3 py-1 text-[11px] font-semibold transition"
					style={ringView ? 'background:#fb923c; color:#000;' : 'color: var(--color-text-subtle);'}
					>Rings</button
				>
				<button
					onclick={() => (ringView = false)}
					aria-pressed={!ringView}
					class="rounded-full px-3 py-1 text-[11px] font-semibold transition"
					style={!ringView ? 'background:#fb923c; color:#000;' : 'color: var(--color-text-subtle);'}
					>List</button
				>
			</div>
		</div>
		{#if ringView}
			<div class="grid grid-cols-3 gap-x-2 gap-y-4">
				{#each view.goals as goal (goal.key)}
					<GoalRing {goal} />
				{/each}
			</div>
		{:else}
			{#each view.goals as goal (goal.key)}
				<GoalRow {goal} />
			{/each}
		{/if}
	</section>

	<!-- Weekly goals -->
	<section class="card mb-3 p-5">
		<p
			class="mb-3 text-[10px] font-semibold tracking-widest uppercase"
			style="color: var(--color-carbs);"
		>
			Weekly goals
		</p>
		{#if ringView}
			<div class="flex justify-center gap-8">
				{#each view.weeklyGoals as goal (goal.key)}
					<GoalRing {goal} />
				{/each}
			</div>
		{:else}
			{#each view.weeklyGoals as goal (goal.key)}
				<GoalRow {goal} />
			{/each}
		{/if}
	</section>
</main>
