<script lang="ts">
	import MacroRing from '$lib/components/MacroRing.svelte';
	import MacroBar from '$lib/components/MacroBar.svelte';
	import { sumMacros, pct, formatTime } from '$lib/macros';
	import { entryDisplay } from '$lib/units';
	import CaptureSheet from '$lib/components/CaptureSheet.svelte';
	import EditEntrySheet from '$lib/components/EditEntrySheet.svelte';

	let { data } = $props();

	let totals = $derived(sumMacros(data.todayEntries));
	let goalPct = $derived(pct(totals.calories, data.settings.calorieTarget));
	let captureOpen = $state(false);
	let editingEntry = $state<(typeof data.todayEntries)[number] | null>(null);

	const today = new Date();
	const weekday = today.toLocaleDateString('en-US', { weekday: 'long' });
	const monthDay = today.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
</script>

<main
	class="mx-auto max-w-md p-6 pb-32"
	style="padding-bottom: calc(8rem + env(safe-area-inset-bottom));"
>
	<header class="mb-1 flex items-center justify-between">
		<div>
			<p
				class="text-xs font-semibold tracking-widest uppercase"
				style="color: var(--color-text-subtle);"
			>
				{weekday}
			</p>
			<h1 class="text-2xl font-bold text-white">{monthDay}</h1>
		</div>
		<div class="flex items-center gap-2">
			{#if data.pendingCount > 0}
				<a
					href="/pending"
					class="card-sm flex items-center gap-2 px-3 py-2 transition hover:brightness-125"
					title="Items awaiting Claude Code processing"
				>
					<span class="h-2 w-2 animate-pulse rounded-full bg-orange-400"></span>
					<span class="text-xs text-white">{data.pendingCount} pending</span>
				</a>
			{/if}
			<a
				href="/settings"
				class="card-sm flex h-9 w-9 items-center justify-center text-white transition hover:brightness-125"
				aria-label="Settings"
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
					<circle cx="12" cy="12" r="3" />
					<path
						d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 008 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H2a2 2 0 010-4h.09A1.65 1.65 0 004.6 8a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V2a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H22a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"
					/>
				</svg>
			</a>
		</div>
	</header>

	<section class="card mt-4 p-5">
		<div class="mb-3 flex items-center justify-between">
			<h2 class="font-semibold text-white">Today</h2>
			<span
				class="rounded-full px-2 py-0.5 text-xs font-semibold"
				style="background: rgba(251,146,60,0.15); color: #fdba74;"
			>
				{goalPct}%
			</span>
		</div>
		<div class="mb-4 flex justify-center">
			<MacroRing value={totals.calories} target={data.settings.calorieTarget} />
		</div>
		<div class="grid grid-cols-3 gap-3">
			<MacroBar
				label="Protein"
				value={totals.proteinG}
				target={data.settings.proteinTargetG}
				color="var(--color-protein)"
			/>
			<MacroBar label="Carbs" value={totals.carbsG} color="var(--color-carbs)" />
			<MacroBar label="Fat" value={totals.fatG} color="var(--color-fat)" />
		</div>
	</section>

	{#if data.quickAddItems.length > 0}
		<h3
			class="mt-6 mb-3 text-xs font-semibold tracking-wider uppercase"
			style="color: var(--color-text-subtle);"
		>
			Quick adds
		</h3>
		<div class="no-scrollbar flex gap-2 overflow-x-auto pb-1">
			{#each data.quickAddItems as q (q.id)}
				<button
					class="card-sm shrink-0 px-4 py-3 text-left transition hover:bg-white/10 active:scale-95"
					onclick={async () => {
						await fetch('/api/log', {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ foodId: q.foodId, servings: 1 })
						});
						location.reload();
					}}
				>
					<div class="text-sm font-semibold text-white">{q.name}</div>
					<div class="text-xs" style="color: var(--color-text-subtle);">
						{Math.round(q.calories)} · {Math.round(q.proteinG)}p
					</div>
				</button>
			{/each}
		</div>
	{/if}

	<h3
		class="mt-6 mb-3 text-xs font-semibold tracking-wider uppercase"
		style="color: var(--color-text-subtle);"
	>
		Eaten today
	</h3>
	{#if data.todayEntries.length === 0}
		<div class="card p-8 text-center" style="color: var(--color-text-subtle);">
			Nothing yet. Tap the + below to add something.
		</div>
	{:else}
		<div class="card divide-y" style="border-color: var(--color-border);">
			{#each data.todayEntries as e (e.id)}
				<button
					type="button"
					class="flex w-full items-center gap-3 p-4 text-left transition hover:bg-white/5"
					style="border-color: var(--color-border);"
					onclick={() => (editingEntry = e)}
				>
					<div class="flex-1">
						<div class="font-medium text-white">{e.foodName}</div>
						<div class="text-xs" style="color: var(--color-text-subtle);">
							{formatTime(new Date(e.loggedAt))} · {entryDisplay(
								e.amount,
								e.unit,
								e.servings,
								e.foodServingSize
							)}
						</div>
					</div>
					<div class="text-right text-sm">
						<div class="font-semibold text-white">{Math.round(e.calories)}</div>
						<div class="text-xs" style="color: var(--color-text-subtle);">
							{Math.round(e.proteinG)}p · {Math.round(e.carbsG)}c
						</div>
					</div>
				</button>
			{/each}
		</div>
		<p class="mt-2 text-center text-xs" style="color: var(--color-text-subtle);">
			Tap any entry to edit or remove
		</p>
	{/if}
</main>

<button
	type="button"
	onclick={() => (captureOpen = true)}
	class="accent-gradient accent-shadow fixed flex h-20 w-20 items-center justify-center rounded-full text-white transition active:scale-95"
	style="bottom: calc(2rem + env(safe-area-inset-bottom)); left: 50%; transform: translateX(-50%);"
	aria-label="Add food"
>
	<svg class="h-8 w-8" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
		<path stroke-linecap="round" d="M12 5v14m-7-7h14" />
	</svg>
</button>

<CaptureSheet bind:open={captureOpen} />

<EditEntrySheet
	entry={editingEntry}
	onclose={() => (editingEntry = null)}
	onsaved={() => location.reload()}
/>
