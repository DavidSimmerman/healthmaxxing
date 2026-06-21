<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { addDays, kgToLb, lbToKg, LB_PER_KG } from '$lib/energy';
	import WeightChart from '$lib/components/WeightChart.svelte';

	let { data } = $props();

	let insights = $derived(data.insights);
	let series = $derived(insights.series);

	// Furthest projection date — the chart extends its lines to here.
	let lastProjectionDate = $derived(
		insights.projections.length
			? insights.projections.reduce((m, p) => (p.date > m ? p.date : m), insights.projections[0].date)
			: addDays(insights.asOf, 90)
	);

	let tomorrow = $derived(addDays(insights.asOf, 1));

	// Goal form state — '' means cleared (→ null on save). Weight entered in lb;
	// stored in kg, so prefill the lb-converted value.
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

	// Format a kg value as pounds (weigh-ins/projections are stored in kg).
	function fmtLb(kg: number | null | undefined, digits = 1): string {
		return kg == null || !Number.isFinite(kg) ? '—' : kgToLb(kg).toFixed(digits);
	}

	// Signed rate with a direction arrow. Negative = losing.
	function rateLabel(ratePerWeek: number | null | undefined, unit: string, digits = 2): string {
		if (ratePerWeek == null || !Number.isFinite(ratePerWeek)) return '—';
		const arrow = ratePerWeek < -1e-6 ? '↓' : ratePerWeek > 1e-6 ? '↑' : '→';
		return `${arrow} ${Math.abs(ratePerWeek).toFixed(digits)} ${unit}/wk`;
	}

	function fmtDate(d: string): string {
		return new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			year: 'numeric',
			timeZone: 'UTC'
		});
	}

	function onTargetChange(e: Event) {
		const v = (e.currentTarget as HTMLInputElement).value;
		if (v) goto(`/trends?target=${v}&window=${data.windowDays}`);
	}

	async function saveGoals(e: SubmitEvent) {
		e.preventDefault();
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
>
	<header class="mb-6 flex items-center gap-3">
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
				Body composition
			</p>
			<h1 class="text-2xl font-bold text-white">Trends</h1>
		</div>
		<a
			href="/"
			class="card-sm ml-auto flex h-9 w-9 items-center justify-center text-white transition hover:brightness-125"
			aria-label="Home"
		>
			<svg
				width="16"
				height="16"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
			>
				<path d="M3 9.5L12 3l9 6.5" />
				<path d="M5 10v10h14V10" />
			</svg>
		</a>
	</header>

	{#if series.length === 0}
		<div class="card p-6 text-center text-sm" style="color: var(--color-text-subtle);">
			<p class="mb-1 font-medium text-white">No weigh-ins yet</p>
			<p>Sync some weigh-ins to see weight &amp; body-fat trends.</p>
		</div>
	{:else}
		<!-- Chart -->
		<section class="card p-4">
			<WeightChart
				{series}
				weight={insights.weight}
				leanMass={insights.leanMass}
				bodyFat={insights.bodyFat}
				today={insights.asOf}
				horizonEnd={lastProjectionDate}
			/>
		</section>

		<!-- Current trend -->
		<section class="card mt-3 p-5">
			<h2
				class="mb-3 text-xs font-semibold tracking-widest uppercase"
				style="color: var(--color-text-subtle);"
			>
				Current trend
			</h2>
			<div class="trend-row">
				<span>Weight</span>
				<b>
					{insights.weight ? rateLabel(insights.weight.ratePerWeek * LB_PER_KG, 'lb') : '—'}
				</b>
			</div>
			<div class="trend-row">
				<span>Body fat</span>
				<b style="color: var(--color-fat);">
					{insights.bodyFat ? rateLabel(insights.bodyFat.ratePerWeek, '%') : '—'}
				</b>
			</div>
			<div class="trend-row">
				<span>Lean mass</span>
				<b>{insights.leanMass ? rateLabel(insights.leanMass.ratePerWeek * LB_PER_KG, 'lb') : '—'}</b>
			</div>

			{#if insights.deficitImplied}
				<p class="mt-3 text-xs leading-relaxed" style="color: var(--color-text-subtle);">
					Calorie-deficit implies {rateLabel(insights.deficitImplied.ratePerWeekKg * LB_PER_KG, 'lb')} over
					the last {insights.deficitImplied.days} days (avg deficit {insights.deficitImplied.avgDeficitKcal.toLocaleString()}
					kcal).
				</p>
			{/if}
		</section>

		<!-- Projections -->
		<section class="card mt-3 p-5">
			<h2
				class="mb-3 text-xs font-semibold tracking-widest uppercase"
				style="color: var(--color-text-subtle);"
			>
				Projections
			</h2>
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
					{#each insights.projections as p (p.date)}
						<tr style="border-top: 1px solid var(--color-border);">
							<td class="py-1.5">
								<div class="text-white">{p.label}</div>
								<div class="text-[11px]" style="color: var(--color-text-subtle);">
									{fmtDate(p.date)}
								</div>
							</td>
							<td class="py-1.5 text-right font-semibold" style="color: var(--color-accent-from);">
								{fmtLb(p.weightKg)}
							</td>
							<td class="py-1.5 text-right font-semibold" style="color: var(--color-fat);">
								{fmt(p.bodyFatPct)}
							</td>
							<td class="py-1.5 text-right text-white">{fmtLb(p.leanMassKg)}</td>
						</tr>
					{/each}
				</tbody>
			</table>

			<label class="mt-4 flex flex-col gap-1">
				<span class="text-xs font-medium" style="color: var(--color-text-subtle);"
					>Project to a specific date</span
				>
				<input
					type="date"
					min={tomorrow}
					value={data.target ?? ''}
					onchange={onTargetChange}
					class="card-sm w-full px-3 py-2 text-sm text-white"
					style="color-scheme: dark; background: var(--color-bg-elevated);"
				/>
			</label>
		</section>
	{/if}

	<!-- Goals (always shown) -->
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
					{#if saveError}
						<span class="text-red-300">{saveError}</span>
					{:else if savedAt}
						Saved
					{:else}
						Leave blank to clear a goal
					{/if}
				</div>
				<button
					type="submit"
					disabled={saving}
					class="rounded-lg px-4 py-2 text-sm font-semibold text-black transition disabled:opacity-40"
					style="background: #fb923c;"
				>
					{saving ? 'Saving…' : 'Save'}
				</button>
			</div>
		</form>

		<!-- ETAs -->
		{#if insights.goal.weight}
			<p class="mt-4 text-sm" style="color: var(--color-text-muted);">
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
					around <b class="text-white">{fmtDate(insights.goal.bodyFat.etaDate)}</b>
					(~{insights.goal.bodyFat.etaDays} days).
				{:else}
					Body fat is not currently trending toward your {fmt(insights.goal.bodyFat.goal)}% goal.
				{/if}
			</p>
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
</style>
