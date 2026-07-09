<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { pullToRefresh } from '$lib/actions/pullToRefresh';
	import { addDays, kgToLb, lbToKg, LB_PER_KG } from '$lib/energy';
	import WeightChart from '$lib/components/WeightChart.svelte';

	let { data } = $props();

	let insights = $derived(data.insights);
	let energy = $derived(data.energy);
	let series = $derived(insights.series);

	// Which projection method's table to show. Prefer the smart/calibrated one.
	let method = $state<'trend' | 'deficit' | 'combined'>('combined');
	let selectedMethod = $derived(
		energy.methods.find((m) => m.method === method) ?? energy.methods[energy.methods.length - 1]
	);
	// Short tab labels so the segmented control fits on a phone.
	const methodLabel: Record<string, string> = {
		trend: 'Trend',
		deficit: 'Deficit',
		combined: 'Smart'
	};

	const WINDOWS = [
		{ days: 7, label: '1W' },
		{ days: 14, label: '2W' },
		{ days: 30, label: '1M' },
		{ days: 90, label: '3M' },
		{ days: 180, label: '6M' },
		{ days: 9999, label: 'All' }
	];

	let tomorrow = $derived(addDays(insights.asOf, 1));

	// Which metrics to show on the chart (each also draws its own trend line).
	let visible = $state({ weight: true, lean: true, bodyFat: true });
	const METRICS = [
		{ key: 'weight', label: 'Weight', color: '#fb923c' },
		{ key: 'lean', label: 'Lean mass', color: '#fda4af' },
		{ key: 'bodyFat', label: 'Body fat %', color: '#7dd3fc' }
	] as const;

	// What-if deficit explorer — prefill with the scenario being shown (defaults
	// to the current real deficit server-side).
	let whatIfInput = $state<number | ''>(
		energy.whatIf?.deficitKcal ?? energy.currentDeficitKcal ?? 500
	);
	function applyWhatIf() {
		if (whatIfInput === '' || !Number.isFinite(Number(whatIfInput))) return;
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local: built, serialized into the goto URL, discarded
		const p = new URLSearchParams();
		p.set('window', String(data.windowDays));
		if (data.target) p.set('target', data.target);
		p.set('deficit', String(Math.round(Number(whatIfInput))));
		goto(`/trends?${p}`, { noScroll: true, keepFocus: true, replaceState: true });
	}

	// Goal form state — '' means cleared (→ null on save). Weight in lb; stored kg.
	let goalWeightLb = $state<number | ''>(
		data.goals.goalWeightKg != null ? Math.round(kgToLb(data.goals.goalWeightKg) * 10) / 10 : ''
	);
	let goalBodyFatPct = $state<number | ''>(data.goals.goalBodyFatPct ?? '');
	let saving = $state(false);
	let saveError = $state<string | null>(null);
	let savedAt = $state<number | null>(null);

	function fmt(n: number | null | undefined, digits = 1): string {
		return n == null || !Number.isFinite(n) ? '—' : n.toFixed(digits);
	}
	function fmtLb(kg: number | null | undefined, digits = 1): string {
		return kg == null || !Number.isFinite(kg) ? '—' : kgToLb(kg).toFixed(digits);
	}
	function rateLabel(ratePerWeek: number | null | undefined, unit: string, digits = 2): string {
		if (ratePerWeek == null || !Number.isFinite(ratePerWeek)) return '—';
		const arrow = ratePerWeek < -1e-6 ? '↓' : ratePerWeek > 1e-6 ? '↑' : '→';
		return `${arrow} ${Math.abs(ratePerWeek).toFixed(digits)} ${unit}/wk`;
	}
	function rateLb(ratePerWeekKg: number | null | undefined): string {
		return ratePerWeekKg == null ? '—' : rateLabel(ratePerWeekKg * LB_PER_KG, 'lb');
	}
	function fmtDate(d: string): string {
		return new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			year: 'numeric',
			timeZone: 'UTC'
		});
	}

	function setWindow(days: number) {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local: built, serialized into the goto URL, discarded
		const p = new URLSearchParams();
		p.set('window', String(days));
		if (data.target) p.set('target', data.target);
		goto(`/trends?${p}`, { noScroll: true, keepFocus: true, replaceState: true });
	}
	function onTargetChange(e: Event) {
		const v = (e.currentTarget as HTMLInputElement).value;
		// Navigate on clear too — dropping ?target removes the custom projection
		// (otherwise "reset" in the picker appeared not to take effect).
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local: built, serialized into the goto URL, discarded
		const p = new URLSearchParams();
		p.set('window', String(data.windowDays));
		if (v) p.set('target', v);
		goto(`/trends?${p}`, { noScroll: true, keepFocus: true, replaceState: true });
	}

	// "Am I on pace?" verdict copy.
	let paceText = $derived.by(() => {
		switch (energy.pace.verdict) {
			case 'on-track':
				return 'Losing about as fast as your calorie deficit predicts. 👍';
			case 'slower':
				return 'Losing slower than your logged deficit predicts — your real maintenance looks lower than the formula’s estimate (or recent water retention is masking fat loss).';
			case 'faster':
				return 'Losing faster than your deficit predicts — likely early water/glycogen drop, or your real maintenance is higher than estimated.';
			case 'gaining':
				return 'Trending up over this window.';
			case 'surplus':
				return 'Your logged intake is at/above your estimated maintenance — not a deficit. Since your weight isn’t climbing, your real maintenance is likely higher than the formula estimates.';
			default:
				return 'Log more days of food (and a few weigh-ins) so we can compare your loss against your deficit.';
		}
	});

	async function saveGoals(ev: SubmitEvent) {
		ev.preventDefault();
		saving = true;
		saveError = null;
		try {
			const res = await fetch('/api/goals', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					goalWeightKg: goalWeightLb === '' ? null : lbToKg(Number(goalWeightLb)),
					goalBodyFatPct: goalBodyFatPct === '' ? null : Number(goalBodyFatPct)
				})
			});
			if (!res.ok) {
				saveError = (await res.text()) || 'Save failed';
				return;
			}
			savedAt = Date.now();
			await invalidateAll();
		} finally {
			saving = false;
		}
	}
</script>

<main
	class="mx-auto max-w-md p-6 pb-12"
	style="padding-bottom: calc(3rem + env(safe-area-inset-bottom));"
	use:pullToRefresh
>
	<header class="mb-4 flex items-center gap-3">
		<a
			href="/deficit"
			class="card-sm flex h-9 w-9 items-center justify-center text-white transition hover:brightness-125"
			aria-label="Back to energy balance"
		>
			<svg
				width="16"
				height="16"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2.5"
				stroke-linecap="round"
				stroke-linejoin="round"><path d="M15 18l-6-6 6-6" /></svg
			>
		</a>
		<div>
			<p
				class="text-xs font-semibold tracking-widest uppercase"
				style="color: var(--color-text-subtle);"
			>
				Body composition
			</p>
			<h1 class="text-2xl font-bold text-white">Trends</h1>
		</div>
	</header>

	<!-- Lookback window (drives chart range + trend/projection calc) -->
	<div class="seg mb-3 flex w-full" role="group" aria-label="Lookback window">
		{#each WINDOWS as w (w.days)}
			<button
				class="seg-btn flex-1"
				class:seg-on={data.windowDays === w.days}
				onclick={() => setWindow(w.days)}>{w.label}</button
			>
		{/each}
	</div>

	{#if series.length === 0}
		<div class="card p-6 text-center text-sm" style="color: var(--color-text-subtle);">
			<p class="mb-1 font-medium text-white">No weigh-ins yet</p>
			<p>Sync some weigh-ins to see weight &amp; body-fat trends.</p>
		</div>
	{:else}
		<section class="card p-4">
			<!-- Metric selector — toggle which lines (each shows its own trend line). -->
			<div class="mb-2 flex flex-wrap justify-center gap-2">
				{#each METRICS as m (m.key)}
					<button
						class="chip"
						class:chip-off={!visible[m.key]}
						aria-pressed={visible[m.key]}
						onclick={() => (visible = { ...visible, [m.key]: !visible[m.key] })}
					>
						<span
							class="chip-dot"
							style="background: {visible[m.key]
								? m.color
								: 'transparent'}; border-color: {m.color};"
						></span>
						{m.label}
					</button>
				{/each}
			</div>
			<WeightChart
				{series}
				weight={insights.weight}
				leanMass={insights.leanMass}
				bodyFat={insights.bodyFat}
				today={insights.asOf}
				show={visible}
			/>
			<p class="mt-1 text-center text-[11px]" style="color: var(--color-text-subtle);">
				% change since {fmtDate(series[0].date)} — dashed = trend. Tap or hover for values.
			</p>
		</section>

		<!-- Current trend (kept) -->
		<section class="card mt-3 p-5">
			<h2
				class="mb-3 text-xs font-semibold tracking-widest uppercase"
				style="color: var(--color-text-subtle);"
			>
				Current trend <span class="normal-case" style="font-weight:400;"
					>· last {data.windowDays === 9999 ? 'all' : data.windowDays + 'd'}</span
				>
			</h2>
			<div class="trend-row">
				<span>Weight</span><b>{insights.weight ? rateLb(insights.weight.ratePerWeek) : '—'}</b>
			</div>
			<div class="trend-row">
				<span>Body fat</span><b style="color: var(--color-fat);"
					>{insights.bodyFat ? rateLabel(insights.bodyFat.ratePerWeek, '%') : '—'}</b
				>
			</div>
			<div class="trend-row">
				<span>Lean mass</span><b
					>{insights.leanMass ? rateLb(insights.leanMass.ratePerWeek) : '—'}</b
				>
			</div>
		</section>

		<!-- Pace vs deficit (NEW) -->
		<section class="card mt-3 p-5">
			<h2
				class="mb-3 text-xs font-semibold tracking-widest uppercase"
				style="color: var(--color-text-subtle);"
			>
				Are you on pace?
			</h2>
			<div class="trend-row">
				<span>Actual loss</span><b>{rateLb(energy.measuredRatePerWeekKg)}</b>
			</div>
			<div class="trend-row">
				<span>Deficit predicts</span><b>{rateLb(energy.expectedRatePerWeekKg)}</b>
			</div>
			<div
				class="trend-row"
				style="border-top: 1px solid var(--color-border); margin-top: 4px; padding-top: 8px;"
			>
				<span>Real maintenance <span style="color: var(--color-text-subtle);">measured</span></span>
				<b
					>{energy.calibratedTdee != null
						? energy.calibratedTdee.toLocaleString() + ' kcal'
						: '—'}</b
				>
			</div>
			<div class="trend-row">
				<span>Est. maintenance <span style="color: var(--color-text-subtle);">formula</span></span
				><b style="color: var(--color-text-muted);"
					>{energy.estimatedTdee != null ? energy.estimatedTdee.toLocaleString() + ' kcal' : '—'}</b
				>
			</div>
			{#if energy.avgIntakeKcal != null}
				<div class="trend-row">
					<span>Avg intake · protein</span><b
						>{energy.avgIntakeKcal.toLocaleString()} · {energy.avgProteinG ?? '—'}g {#if energy.proteinPerKg}<span
								class="text-xs"
								style="color: {energy.proteinAdequate ? '#4ade80' : '#fbbf24'};"
								>({energy.proteinPerKg}g/kg{energy.proteinAdequate ? '' : ' low'})</span
							>{/if}</b
					>
				</div>
			{/if}
			<p class="mt-3 text-xs leading-relaxed" style="color: var(--color-text-subtle);">
				{paceText}
			</p>
		</section>

		<!-- Projections, method-selectable (NEW) -->
		<section class="card mt-3 p-5">
			<h2
				class="mb-3 text-xs font-semibold tracking-widest uppercase"
				style="color: var(--color-text-subtle);"
			>
				Projections
			</h2>
			<div class="seg mb-3 flex w-full" role="group" aria-label="Projection method">
				{#each energy.methods as m (m.method)}
					<button
						class="seg-btn flex-1"
						class:seg-on={selectedMethod?.method === m.method}
						onclick={() => (method = m.method)}>{methodLabel[m.method] ?? m.label}</button
					>
				{/each}
			</div>

			{#if selectedMethod}
				<p class="mb-2 text-xs leading-relaxed" style="color: var(--color-text-subtle);">
					{selectedMethod.note}{#if selectedMethod.ratePerWeekKg != null}
						<span class="text-white">{rateLb(selectedMethod.ratePerWeekKg)}.</span>{/if}
				</p>
				<table class="w-full text-sm">
					<thead>
						<tr style="color: var(--color-text-subtle);" class="text-[11px] uppercase">
							<th class="py-1 text-left font-medium">When</th>
							<th class="py-1 text-right font-medium">Wt (lb)</th>
							<th class="py-1 text-right font-medium">BF%</th>
							<th class="py-1 text-right font-medium">Lean (lb)</th>
						</tr>
					</thead>
					<tbody>
						{#each selectedMethod.rows as p (p.date)}
							<tr style="border-top: 1px solid var(--color-border);">
								<td class="py-1.5"
									><div class="text-white">{p.label === data.target ? 'Target' : p.label}</div>
									<div class="text-[11px]" style="color: var(--color-text-subtle);">
										{fmtDate(p.date)}
									</div></td
								>
								<td class="py-1.5 text-right font-semibold" style="color: var(--color-accent-from);"
									>{fmtLb(p.weightKg)}</td
								>
								<td class="py-1.5 text-right font-semibold" style="color: var(--color-fat);"
									>{fmt(p.bodyFatPct)}</td
								>
								<td class="py-1.5 text-right text-white">{fmtLb(p.leanMassKg)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}

			<label class="mt-4 flex flex-col gap-1">
				<span class="text-xs font-medium" style="color: var(--color-text-subtle);"
					>Project to a specific date</span
				>
				<input
					type="date"
					min={tomorrow}
					value={data.target ?? ''}
					onchange={onTargetChange}
					class="card-sm block w-full min-w-0 px-3 py-2 text-sm text-white"
					style="color-scheme: dark; background: var(--color-bg-elevated); width: 100%; max-width: 100%; box-sizing: border-box; -webkit-appearance: none; appearance: none;"
				/>
			</label>
		</section>

		<!-- What-if deficit (NEW) -->
		<section class="card mt-3 p-5">
			<h2
				class="mb-1 text-xs font-semibold tracking-widest uppercase"
				style="color: var(--color-text-subtle);"
			>
				What if my deficit were…
			</h2>
			<p class="mb-3 text-xs leading-relaxed" style="color: var(--color-text-subtle);">
				{#if energy.currentDeficitKcal != null}
					Your current average is a <b class="text-white"
						>{energy.currentDeficitKcal >= 0 ? '−' : '+'}{Math.abs(
							energy.currentDeficitKcal
						).toLocaleString()}</b
					>
					kcal/day {energy.currentDeficitKcal >= 0 ? 'deficit' : 'surplus'} (prefilled below). Try a different
					one:
				{:else}
					Log more days of food so we can estimate your maintenance first.
				{/if}
			</p>
			<span class="mb-1 block text-xs font-medium" style="color: var(--color-text-subtle);"
				>Daily deficit (kcal)</span
			>
			<div class="flex items-stretch gap-2">
				<input
					type="number"
					min="-2000"
					max="3000"
					step="50"
					bind:value={whatIfInput}
					onchange={applyWhatIf}
					class="min-w-0 flex-1 rounded-lg border bg-transparent px-3 py-2 text-white outline-none focus:border-orange-400"
					style="border-color: var(--color-border);"
				/>
				<button
					onclick={applyWhatIf}
					class="shrink-0 rounded-lg px-4 text-sm font-semibold text-black"
					style="background: #fb923c;">Project</button
				>
			</div>

			{#if energy.whatIf}
				<div class="trend-row mt-4">
					<span>Projected loss</span><b>{rateLb(energy.whatIf.ratePerWeekKg)}</b>
				</div>
				<div class="trend-row">
					<span>Means eating</span><b>{energy.whatIf.plannedIntakeKcal.toLocaleString()} kcal/day</b
					>
				</div>
				<div class="mt-4 border-t pt-3" style="border-color: var(--color-border);">
					{#if insights.goal.weight}
						<p class="text-sm" style="color: var(--color-text-muted);">
							{#if energy.whatIf.goalWeightEtaDate}
								Reach <b class="text-white">{fmtLb(insights.goal.weight.goal)} lb</b> by
								<b class="text-white">{fmtDate(energy.whatIf.goalWeightEtaDate)}</b> (~{energy
									.whatIf.goalWeightEtaDays} days).
							{:else}
								Won't reach your {fmtLb(insights.goal.weight.goal)} lb goal at this deficit.
							{/if}
						</p>
					{/if}
					{#if insights.goal.bodyFat && energy.whatIf.goalBodyFatEtaDate}
						<p class="mt-1 text-sm" style="color: var(--color-text-muted);">
							Hit <b class="text-white">{fmt(insights.goal.bodyFat.goal)}% body fat</b> by
							<b class="text-white">{fmtDate(energy.whatIf.goalBodyFatEtaDate)}</b> (~{energy.whatIf
								.goalBodyFatEtaDays} days).
						</p>
					{/if}
					{#if !insights.goal.weight && !insights.goal.bodyFat}
						<p class="text-xs" style="color: var(--color-text-subtle);">
							Set a goal below to see time-to-goal at this deficit.
						</p>
					{/if}
				</div>
			{/if}
		</section>
	{/if}

	<!-- Goals (kept) -->
	<section class="card mt-3 p-5">
		<h2
			class="mb-3 text-xs font-semibold tracking-widest uppercase"
			style="color: var(--color-text-subtle);"
		>
			Goal
		</h2>
		<form onsubmit={saveGoals}>
			<div class="grid grid-cols-2 gap-3">
				<label class="flex flex-col gap-1">
					<span class="text-xs font-medium" style="color: var(--color-text-subtle);"
						>Goal weight (lb)</span
					>
					<input
						type="number"
						min="44"
						max="880"
						step="0.1"
						bind:value={goalWeightLb}
						class="rounded-lg border bg-transparent px-3 py-2 text-white outline-none focus:border-orange-400"
						style="border-color: var(--color-border);"
					/>
				</label>
				<label class="flex flex-col gap-1">
					<span class="text-xs font-medium" style="color: var(--color-text-subtle);"
						>Goal body fat %</span
					>
					<input
						type="number"
						min="1"
						max="75"
						step="0.1"
						bind:value={goalBodyFatPct}
						class="rounded-lg border bg-transparent px-3 py-2 text-white outline-none focus:border-orange-400"
						style="border-color: var(--color-border);"
					/>
				</label>
			</div>
			<div class="mt-4 flex items-center justify-between gap-3">
				<div class="text-xs" style="color: var(--color-text-subtle);">
					{#if saveError}<span class="text-red-300">{saveError}</span
						>{:else if savedAt}Saved{:else}Leave blank to clear a goal{/if}
				</div>
				<button
					type="submit"
					disabled={saving}
					class="rounded-lg px-4 py-2 text-sm font-semibold text-black transition disabled:opacity-40"
					style="background: #fb923c;">{saving ? 'Saving…' : 'Save'}</button
				>
			</div>
		</form>

		{#if insights.goal.weight || insights.goal.bodyFat}
			<div class="mt-4 border-t pt-3" style="border-color: var(--color-border);">
				{#if insights.goal.weight}
					<p class="text-sm" style="color: var(--color-text-muted);">
						{#if insights.goal.weight.etaDate}
							On track to hit <b class="text-white">{fmtLb(insights.goal.weight.goal)} lb</b> around
							<b class="text-white">{fmtDate(insights.goal.weight.etaDate)}</b>
							(~{insights.goal.weight.etaDays} days).
						{:else}
							Weight is not currently trending toward your {fmtLb(insights.goal.weight.goal)} lb goal.
						{/if}
					</p>
				{/if}
				{#if insights.goal.bodyFat}
					<p class="mt-2 text-sm" style="color: var(--color-text-muted);">
						{#if insights.goal.bodyFat.etaDate}
							On track to hit <b class="text-white">{fmt(insights.goal.bodyFat.goal)}% body fat</b>
							around <b class="text-white">{fmtDate(insights.goal.bodyFat.etaDate)}</b> (~{insights
								.goal.bodyFat.etaDays} days).
						{:else}
							Body fat is not currently trending toward your {fmt(insights.goal.bodyFat.goal)}%
							goal.
						{/if}
					</p>
				{/if}
			</div>
		{/if}
	</section>
</main>

<style>
	.trend-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		font-size: 13px;
		color: var(--color-text-muted);
		padding: 4px 0;
	}
	.trend-row b {
		color: white;
		font-weight: 600;
	}
	.seg {
		display: inline-flex;
		gap: 2px;
		padding: 2px;
		border-radius: 0.75rem;
		background: var(--color-bg-elevated);
		border: 1px solid var(--color-border);
	}
	.seg-btn {
		border-radius: 0.55rem;
		padding: 5px 10px;
		font-size: 12px;
		font-weight: 600;
		color: var(--color-text-muted);
		transition: all 0.12s;
		white-space: nowrap;
	}
	.seg-on {
		background: #fb923c;
		color: #000;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		border-radius: 999px;
		padding: 4px 11px;
		font-size: 12px;
		font-weight: 600;
		color: var(--color-text);
		background: var(--color-bg-elevated);
		border: 1px solid var(--color-border);
		transition: opacity 0.12s;
	}
	.chip-off {
		opacity: 0.4;
	}
	.chip-dot {
		width: 9px;
		height: 9px;
		border-radius: 999px;
		border: 1.5px solid;
		flex: none;
	}
</style>
