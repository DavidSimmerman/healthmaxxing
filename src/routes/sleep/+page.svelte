<script lang="ts">
	import { sleepInsights, sleepTrends, type SleepAverages } from '$lib/sleepInsights';
	import { invalidateAll } from '$app/navigation';
	import { pullToRefresh } from '$lib/actions/pullToRefresh';

	let { data } = $props();
	// Derived (not a one-time const) so a pull-to-refresh that imports a new night
	// flows into the slices/averages/insights/list — otherwise they'd stay stale
	// until a full navigation.
	const nights = $derived(data.nights);

	// Pull-to-refresh on /sleep first triggers a fresh Fitbit pull (same work the
	// daily cron does, session-authenticated — no token in the browser), THEN
	// reloads, so the newest night shows. A failed sync still falls through to a
	// reload so the page never gets stuck.
	async function syncThenReload() {
		try {
			await fetch('/api/integrations/fitbit/sync', { method: 'POST' });
		} catch {
			// offline / sync error — still reload what we have
		}
		await invalidateAll();
	}

	function fmtDur(min: number): string {
		const h = Math.floor(min / 60);
		const m = Math.round(min % 60);
		return h > 0 ? `${h}h ${m}m` : `${m}m`;
	}
	function fmtDate(d: string): string {
		return new Date(`${d}T00:00:00`).toLocaleDateString('en-US', {
			weekday: 'short',
			month: 'short',
			day: 'numeric'
		});
	}
	function fmtClock(iso: string): string {
		// Pin to the app timezone so the night reads in local clock time regardless
		// of the viewer's browser timezone.
		return new Date(iso).toLocaleTimeString('en-US', {
			timeZone: data.tz,
			hour: 'numeric',
			minute: '2-digit'
		});
	}

	// Stage bands (top→bottom = lightest→deepest, like a hypnogram). `key` is the
	// daily_metrics aggregate for the legend total.
	const STAGES = [
		{ id: 'AWAKE', label: 'Awake', key: 'sleep_awake_min', color: '#f472b6' },
		{ id: 'REM', label: 'REM', key: 'sleep_rem_min', color: '#22d3ee' },
		{ id: 'LIGHT', label: 'Light', key: 'sleep_light_min', color: '#60a5fa' },
		{ id: 'DEEP', label: 'Deep', key: 'sleep_deep_min', color: '#7c3aed' }
	];

	const PERIODS = [
		{ n: 7, label: 'Week' },
		{ n: 14, label: '2 Weeks' },
		{ n: 30, label: 'Month' }
	];
	let period = $state(7);

	const slice = $derived(nights.slice(0, period));
	function avg(k: string): number | null {
		const v = slice.map((n) => n.m[k]).filter((x): x is number => typeof x === 'number');
		return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
	}
	const averages = $derived<SleepAverages>({
		sleepMin: avg('sleep_min'),
		deepMin: avg('sleep_deep_min'),
		remMin: avg('sleep_rem_min'),
		lightMin: avg('sleep_light_min'),
		efficiencyPct: avg('sleep_efficiency_pct'),
		restingHr: avg('sleep_resting_hr'),
		hrvMs: avg('sleep_hrv_ms')
	});
	const insights = $derived([
		...sleepInsights(averages),
		...sleepTrends(slice, data.stagesByDate, data.tz)
	]);

	const statusColor = (s: string) =>
		s === 'good' ? '#34d399' : s === 'unknown' ? '#a1a1aa' : '#fbbf24';

	// Hypnogram — follows the most recent night until the user taps one, then sticks
	// to their pick. After a refresh this snaps to a freshly-imported newest night
	// (and recovers if the selected night disappears).
	let selectedDate = $state(nights[0]?.date ?? '');
	let userPicked = $state(false);
	$effect(() => {
		if (!nights.length) return;
		if (!userPicked || !nights.some((n) => n.date === selectedDate)) {
			selectedDate = nights[0].date;
		}
	});
	const sel = $derived(data.stagesByDate[selectedDate] ?? null);
	const selNight = $derived(nights.find((n) => n.date === selectedDate) ?? null);
	const totalMin = $derived(
		sel ? Math.max(...sel.segments.map((s) => s.startMin + s.durationMin), 1) : 1
	);
</script>

<svelte:head><title>Sleep</title></svelte:head>

<main class="mx-auto max-w-md p-5 pb-16" use:pullToRefresh={{ onRefresh: syncThenReload }}>
	<header class="mb-5 flex items-center gap-3">
		<a href="/" class="text-sm" style="color: var(--color-text-muted);">← Home</a>
		<h1 class="text-2xl font-bold text-white">Sleep</h1>
	</header>

	{#if nights.length === 0}
		<div class="card p-8 text-center" style="color: var(--color-text-subtle);">
			No sleep synced yet. Your Fitbit data lands here each afternoon once it's synced.
		</div>
	{:else}
		<!-- Period selector -->
		<div class="mb-4 flex gap-1 rounded-full bg-white/5 p-1">
			{#each PERIODS as p (p.n)}
				<button
					class="flex-1 rounded-full py-1.5 text-sm font-semibold transition"
					class:accent-gradient={period === p.n}
					class:text-white={period === p.n}
					style={period === p.n ? '' : 'color: var(--color-text-subtle);'}
					onclick={() => (period = p.n)}
				>
					{p.label}
				</button>
			{/each}
		</div>

		<!-- Insights -->
		<h2 class="mb-2 px-1 text-xs font-semibold tracking-wider uppercase" style="color: var(--color-text-subtle);">
			How you're sleeping · {slice.length} night{slice.length === 1 ? '' : 's'}
		</h2>
		<div class="flex flex-col gap-2">
			{#each insights as ins (ins.key)}
				<div class="card flex items-start gap-3 p-4">
					<span class="mt-1.5 h-2 w-2 shrink-0 rounded-full" style="background: {statusColor(ins.status)};"></span>
					<div class="min-w-0 flex-1">
						<div class="flex items-baseline justify-between gap-2">
							<span class="font-semibold text-white">{ins.label}</span>
							<span class="text-lg font-bold" style="color: {statusColor(ins.status)};">{ins.value}</span>
						</div>
						<div class="text-xs" style="color: var(--color-text-subtle);">{ins.detail}</div>
						<div class="mt-1 text-sm" style="color: var(--color-text-muted);">{ins.note}</div>
					</div>
				</div>
			{/each}
		</div>

		<!-- Hypnogram for the selected night -->
		{#if sel && selNight}
			<h2 class="mt-6 mb-2 px-1 text-xs font-semibold tracking-wider uppercase" style="color: var(--color-text-subtle);">
				{selectedDate === nights[0]?.date ? 'Last night' : fmtDate(selectedDate)} · {fmtDur(selNight.m.sleep_min)}
			</h2>
			<section class="card p-4">
				<div class="flex flex-col gap-1.5">
					{#each STAGES as st (st.id)}
						<div class="flex items-center gap-2">
							<span class="w-10 shrink-0 text-[10px] tracking-wide uppercase" style="color: var(--color-text-subtle);">
								{st.label}
							</span>
							<div class="relative h-4 flex-1 overflow-hidden rounded" style="background: #18181b;">
								{#each sel.segments.filter((s) => s.stage === st.id) as seg, i (i)}
									<div
										class="absolute top-0 h-full rounded-sm"
										style="left: {(seg.startMin / totalMin) * 100}%; width: {Math.max((seg.durationMin / totalMin) * 100, 0.4)}%; background: {st.color};"
									></div>
								{/each}
							</div>
						</div>
					{/each}
				</div>
				<div class="mt-2 flex justify-between pl-12 text-[10px]" style="color: var(--color-text-subtle);">
					<span>{fmtClock(sel.startAt)}</span>
					<span>{fmtClock(sel.endAt)}</span>
				</div>
				<!-- Stage legend with minutes for this night -->
				<div class="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t pt-3" style="border-color: var(--color-border);">
					{#each STAGES as st (st.id)}
						{#if typeof selNight.m[st.key] === 'number'}
							<div class="flex items-center gap-1.5 text-xs">
								<span class="h-2 w-2 rounded-full" style="background: {st.color};"></span>
								<span style="color: var(--color-text-subtle);">{st.label}</span>
								<span class="font-medium text-white">{fmtDur(selNight.m[st.key] ?? 0)}</span>
							</div>
						{/if}
					{/each}
				</div>
				<p class="mt-2 text-[10px]" style="color: var(--color-text-subtle);">
					Restlessness isn't exposed by the Fitbit/Google API — the Awake track is the closest signal.
				</p>
			</section>
		{/if}

		<!-- Per-night list (tap to load its hypnogram above) -->
		<h2 class="mt-6 mb-2 px-1 text-xs font-semibold tracking-wider uppercase" style="color: var(--color-text-subtle);">
			Nights
		</h2>
		<div class="flex flex-col gap-2">
			{#each slice as n (n.date)}
				{@const t = STAGES.reduce((s, st) => s + (n.m[st.key] ?? 0), 0)}
				<button
					type="button"
					class="card p-3 text-left transition hover:bg-white/5"
					class:ring-1={n.date === selectedDate}
					style={n.date === selectedDate ? 'box-shadow: inset 0 0 0 1px var(--color-text-muted);' : ''}
					onclick={() => {
						selectedDate = n.date;
						userPicked = true;
					}}
				>
					<div class="flex items-baseline justify-between">
						<span class="text-sm font-semibold text-white">{fmtDate(n.date)}</span>
						<div class="flex items-baseline gap-2">
							<span class="text-sm font-bold text-white">{fmtDur(n.m.sleep_min)}</span>
							{#if typeof n.m.sleep_efficiency_pct === 'number'}
								<span class="text-xs" style="color: var(--color-text-subtle);">{Math.round(n.m.sleep_efficiency_pct)}%</span>
							{/if}
						</div>
					</div>
					{#if t > 0}
						<div class="mt-2 flex h-1.5 overflow-hidden rounded-full" style="background: #18181b;">
							{#each STAGES as st (st.id)}
								{#if n.m[st.key]}
									<div style="width: {((n.m[st.key] ?? 0) / t) * 100}%; background: {st.color};"></div>
								{/if}
							{/each}
						</div>
					{/if}
				</button>
			{/each}
		</div>
	{/if}
</main>
