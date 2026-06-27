<script lang="ts">
	import { pullToRefresh } from '$lib/actions/pullToRefresh';
	import ScoreRing from '$lib/components/ScoreRing.svelte';
	import GoalRow from '$lib/components/GoalRow.svelte';

	let { data } = $props();
	const view = $derived(data.view);
	const day = $derived(view.day);

	function fmt(date: string, opts: Intl.DateTimeFormatOptions): string {
		return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', ...opts });
	}

	const selectedLabel = $derived(fmt(data.date, { weekday: 'long', month: 'short', day: 'numeric' }));
	const weekLabel = $derived(
		`${fmt(data.weekDays[0].date, { month: 'short', day: 'numeric' })} – ${fmt(data.weekDays[6].date, { month: 'short', day: 'numeric' })}`
	);

	const dateHref = (d: string) => `/goals?date=${d}`;

	// Ring color ramp (mirrors ScoreRing / GoalRow).
	function ringColor(score: number | null): string {
		if (score == null) return 'transparent';
		if (score >= 90) return '#4ade80';
		if (score >= 75) return '#fb923c';
		if (score >= 50) return '#fbbf24';
		return '#f87171';
	}

	// Day-ring geometry (small, fits 7 across).
	const SZ = 38;
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

		<div class="grid grid-cols-7 gap-1">
			{#each data.weekDays as d (d.date)}
				{@const pct = d.score == null ? 0 : Math.max(0, Math.min(100, d.score)) / 100}
				<svelte:element
					this={d.future ? 'div' : 'a'}
					href={d.future ? undefined : dateHref(d.date)}
					aria-current={d.selected ? 'date' : undefined}
					aria-disabled={d.future ? true : undefined}
					class="flex flex-col items-center gap-1 rounded-xl py-1.5 transition"
					style={d.selected ? 'background: rgba(255,255,255,0.10);' : ''}
					class:opacity-30={d.future}
				>
					<span class="text-[10px] font-semibold" style="color: var(--color-text-subtle);">
						{fmt(d.date, { weekday: 'narrow' })}
					</span>
					<span class="relative grid place-items-center" style="width: {SZ}px; height: {SZ}px;">
						<svg width={SZ} height={SZ} viewBox="0 0 {SZ} {SZ}" class="-rotate-90">
							<circle cx={SZ / 2} cy={SZ / 2} r={R} fill="none" stroke="rgba(255,255,255,0.08)" stroke-width={STK} />
							{#if d.score != null}
								<circle cx={SZ / 2} cy={SZ / 2} r={R} fill="none" stroke={ringColor(d.score)} stroke-width={STK} stroke-linecap="round" stroke-dasharray={CIRC} stroke-dashoffset={CIRC * (1 - pct)} />
							{/if}
						</svg>
						<span class="absolute text-[11px] font-bold tabular-nums text-white">
							{d.score == null ? '–' : Math.round(d.score)}
						</span>
					</span>
					<span class="text-[10px] tabular-nums" style="color: {d.selected ? '#fff' : 'var(--color-text-subtle)'};">
						{fmt(d.date, { day: 'numeric' })}
					</span>
				</svelte:element>
			{/each}
		</div>
	</section>

	<!-- Selected day -->
	<p class="mb-2 px-1 text-sm font-semibold text-white">{selectedLabel}</p>

	<!-- Hero -->
	<section class="card mb-3 flex items-center gap-5 p-5">
		<ScoreRing score={day.score} />
		<div class="min-w-0 flex-1">
			{#if day.score == null}
				<p class="text-sm" style="color: var(--color-text-subtle);">No data yet — connect your sources.</p>
			{:else}
				<span class="text-lg font-bold text-white">Grade {day.grade}</span>
				{#if day.streak > 0}
					<div class="mt-2 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold" style="background: rgba(251,146,60,0.15); color: #fb923c;">
						🔥 {day.streak}-day streak
					</div>
				{/if}
				<p class="mt-2 text-xs" style="color: var(--color-text-subtle);">
					{Math.round(day.base ?? 0)} base{#if day.bonus > 0} · +{day.bonus.toFixed(1)} bonus{/if}
				</p>
				{#if day.bonusParts.length}
					<div class="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[11px]" style="color: #4ade80;">
						{#each day.bonusParts as p (p.key)}
							<span>{p.label} +{p.points.toFixed(1)}</span>
						{/each}
					</div>
				{/if}
			{/if}
		</div>
	</section>

	<!-- Daily goals -->
	<section class="card mb-3 p-5">
		<p class="mb-3 text-[10px] font-semibold tracking-widest uppercase" style="color: var(--color-accent-from);">Daily goals</p>
		{#each day.goals as goal (goal.key)}
			<GoalRow {goal} />
		{/each}
	</section>

	<!-- Week / month summaries -->
	{@render summary('This week', view.week)}
	{@render summary('This month', view.month)}
</main>

{#snippet summary(title: string, sum: typeof view.week)}
	<section class="card mb-3 p-5">
		<div class="mb-4 flex items-center gap-4">
			<ScoreRing score={sum.score} size={72} />
			<div class="min-w-0">
				<p class="text-[10px] font-semibold tracking-widest uppercase" style="color: var(--color-carbs);">{title}</p>
				<p class="text-base font-bold text-white">Grade {sum.grade}</p>
				<p class="text-xs" style="color: var(--color-text-subtle);">
					avg of {sum.completedDays} completed day{sum.completedDays === 1 ? '' : 's'}{#if sum.bonus > 0} · +{sum.bonus.toFixed(1)} bonus{/if}
				</p>
			</div>
		</div>
		{#if sum.completedDays === 0}
			<p class="text-sm" style="color: var(--color-text-subtle);">No completed days yet this {title === 'This week' ? 'week' : 'month'}.</p>
		{:else}
			{#each sum.goals as goal (goal.key)}<GoalRow {goal} />{/each}
			{#each sum.weeklyGoals as goal (goal.key)}<GoalRow {goal} />{/each}
		{/if}
	</section>
{/snippet}
