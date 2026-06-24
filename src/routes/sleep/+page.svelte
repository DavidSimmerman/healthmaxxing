<script lang="ts">
	let { data } = $props();
	const nights = data.nights;

	function fmtDur(min: number): string {
		const h = Math.floor(min / 60);
		const m = Math.round(min % 60);
		return h > 0 ? `${h}h ${m}m` : `${m}m`;
	}
	function fmtDate(d: string): { weekday: string; rest: string } {
		const dt = new Date(`${d}T00:00:00`);
		return {
			weekday: dt.toLocaleDateString('en-US', { weekday: 'short' }),
			rest: dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
		};
	}

	// Stage order = how it reads bottom-up through the night; colors are the bar.
	const STAGES = [
		{ key: 'sleep_deep_min', label: 'Deep', color: '#4338ca' },
		{ key: 'sleep_rem_min', label: 'REM', color: '#2dd4bf' },
		{ key: 'sleep_light_min', label: 'Light', color: '#60a5fa' },
		{ key: 'sleep_awake_min', label: 'Awake', color: '#52525b' }
	];
	const VITALS = [
		{ key: 'sleep_resting_hr', label: 'Resting HR', unit: ' bpm', d: 0, signed: false },
		{ key: 'sleep_hrv_ms', label: 'HRV', unit: ' ms', d: 0, signed: false },
		{ key: 'sleep_spo2_pct', label: 'SpO₂', unit: '%', d: 0, signed: false },
		{ key: 'sleep_resp_rate', label: 'Resp', unit: ' br/min', d: 1, signed: false },
		{ key: 'sleep_skin_temp_dev_c', label: 'Skin temp', unit: '°C', d: 1, signed: true }
	];

	type Night = (typeof nights)[number];
	const stageTotal = (m: Night['m']) =>
		STAGES.reduce((s, st) => s + (m[st.key] ?? 0), 0);
	const has = (m: Night['m'], k: string) => typeof m[k] === 'number';
	function fmt(v: number, d: number, signed: boolean): string {
		const r = d === 0 ? Math.round(v) : Math.round(v * 10 ** d) / 10 ** d;
		return signed && r > 0 ? `+${r}` : `${r}`;
	}

	const recent = nights.slice(0, 7);
	const avg = (k: string) => {
		const vals = recent.map((n) => n.m[k]).filter((v): v is number => typeof v === 'number');
		return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
	};
	const avgSleep = avg('sleep_min');
	const avgEff = avg('sleep_efficiency_pct');
</script>

<svelte:head><title>Sleep</title></svelte:head>

<main class="mx-auto max-w-md p-5 pb-16">
	<header class="mb-5 flex items-center gap-3">
		<a href="/" class="text-sm" style="color: var(--color-text-muted);">← Home</a>
		<h1 class="text-2xl font-bold text-white">Sleep</h1>
	</header>

	{#if nights.length === 0}
		<div class="card p-8 text-center" style="color: var(--color-text-subtle);">
			No sleep synced yet. Your Fitbit data lands here each afternoon once it's synced.
		</div>
	{:else}
		<!-- 7-night summary -->
		<section class="card mb-5 flex items-center justify-around p-5 text-center">
			<div>
				<div class="text-2xl font-bold text-white">{avgSleep ? fmtDur(avgSleep) : '—'}</div>
				<div class="mt-0.5 text-xs tracking-wide uppercase" style="color: var(--color-text-subtle);">
					Avg · 7 nights
				</div>
			</div>
			<div class="h-10 w-px" style="background: var(--color-border);"></div>
			<div>
				<div class="text-2xl font-bold text-white">{avgEff ? `${Math.round(avgEff)}%` : '—'}</div>
				<div class="mt-0.5 text-xs tracking-wide uppercase" style="color: var(--color-text-subtle);">
					Avg efficiency
				</div>
			</div>
		</section>

		<div class="flex flex-col gap-3">
			{#each nights as n (n.date)}
				{@const total = stageTotal(n.m)}
				{@const dt = fmtDate(n.date)}
				{@const shown = VITALS.filter((v) => has(n.m, v.key))}
				<section class="card p-4">
					<div class="flex items-baseline justify-between">
						<div>
							<span class="font-semibold text-white">{dt.weekday}</span>
							<span class="ml-1.5 text-sm" style="color: var(--color-text-subtle);">{dt.rest}</span>
						</div>
						<div class="flex items-baseline gap-2">
							<span class="text-lg font-bold text-white">{fmtDur(n.m.sleep_min)}</span>
							{#if has(n.m, 'sleep_efficiency_pct')}
								<span
									class="rounded-full px-2 py-0.5 text-xs font-semibold"
									style="background: rgba(96,165,250,0.15); color: #93c5fd;"
								>
									{Math.round(n.m.sleep_efficiency_pct)}%
								</span>
							{/if}
						</div>
					</div>

					<!-- Stage bar -->
					{#if total > 0}
						<div class="mt-3 flex h-2.5 overflow-hidden rounded-full" style="background: #18181b;">
							{#each STAGES as st (st.key)}
								{#if n.m[st.key]}
									<div style="width: {((n.m[st.key] ?? 0) / total) * 100}%; background: {st.color};"></div>
								{/if}
							{/each}
						</div>
						<div class="mt-2 flex flex-wrap gap-x-4 gap-y-1">
							{#each STAGES as st (st.key)}
								{#if has(n.m, st.key)}
									<div class="flex items-center gap-1.5 text-xs">
										<span class="h-2 w-2 rounded-full" style="background: {st.color};"></span>
										<span style="color: var(--color-text-subtle);">{st.label}</span>
										<span class="font-medium text-white">{fmtDur(n.m[st.key] ?? 0)}</span>
									</div>
								{/if}
							{/each}
						</div>
					{/if}

					<!-- Nightly vitals -->
					{#if shown.length}
						<div
							class="mt-3 grid gap-2 border-t pt-3 text-center"
							style="border-color: var(--color-border); grid-template-columns: repeat({shown.length}, minmax(0, 1fr));"
						>
							{#each shown as v (v.key)}
								<div>
									<div class="text-sm font-semibold text-white">
										{fmt(n.m[v.key] ?? 0, v.d, v.signed)}<span
											class="text-[10px] font-normal"
											style="color: var(--color-text-subtle);">{v.unit}</span
										>
									</div>
									<div class="text-[10px] tracking-wide uppercase" style="color: var(--color-text-subtle);">
										{v.label}
									</div>
								</div>
							{/each}
						</div>
					{/if}
				</section>
			{/each}
		</div>
	{/if}
</main>
