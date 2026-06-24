<script lang="ts">
	import { invalidateAll } from '$app/navigation';

	let { data } = $props();

	let calorieTarget = $state(data.settings.calorieTarget);
	let proteinTargetG = $state(data.settings.proteinTargetG);

	// Profile (BMR inputs). Height is entered as ft/in, stored as cm.
	const initialHeightCm = data.settings.heightCm ?? null;
	let heightFt = $state(
		initialHeightCm ? Math.floor(initialHeightCm / 2.54 / 12) : ('' as '' | number)
	);
	let heightIn = $state(
		initialHeightCm ? Math.round((initialHeightCm / 2.54) % 12) : ('' as '' | number)
	);
	let birthDate = $state(data.settings.birthDate ?? '');
	let sex = $state(data.settings.sex ?? '');
	// Bolusable-carb fiber rule (clinical calibration).
	let fiberMode = $state<'full' | 'half_over_5'>(
		data.settings.fiberMode === 'half_over_5' ? 'half_over_5' : 'full'
	);
	// Free-text context for the scheduled Claude review.
	let notes = $state(data.settings.notes ?? '');

	// A cleared number input binds as '' / null / undefined depending on path —
	// treat all as blank so clearing both fields saves null, not 0.
	const blank = (v: unknown) => v === '' || v == null;
	let heightCm = $derived(
		blank(heightFt) && blank(heightIn)
			? null
			: Math.round((Number(heightFt || 0) * 12 + Number(heightIn || 0)) * 2.54 * 10) / 10
	);

	let saving = $state(false);
	let savedAt = $state<number | null>(null);
	let saveError = $state<string | null>(null);

	let items = $state(data.quickAddItems);
	let busy = $state<string | null>(null);

	let dirty = $derived(
		calorieTarget !== data.settings.calorieTarget ||
			proteinTargetG !== data.settings.proteinTargetG ||
			heightCm !== (data.settings.heightCm ?? null) ||
			birthDate !== (data.settings.birthDate ?? '') ||
			sex !== (data.settings.sex ?? '') ||
			fiberMode !== (data.settings.fiberMode ?? 'full') ||
			notes !== (data.settings.notes ?? '')
	);

	async function saveTargets(e: SubmitEvent) {
		e.preventDefault();
		saving = true;
		saveError = null;
		try {
			const res = await fetch('/api/settings', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					calorieTarget: Number(calorieTarget),
					proteinTargetG: Number(proteinTargetG),
					heightCm,
					birthDate: birthDate || null,
					sex: sex || null,
					fiberMode,
					notes: notes.trim() || null
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

	async function unpin(id: string) {
		if (!confirm('Remove this quick-add tile?')) return;
		busy = id;
		try {
			const res = await fetch(`/api/quick-adds/${id}`, { method: 'DELETE' });
			if (!res.ok) {
				alert('Remove failed');
				return;
			}
			items = items.filter((i) => i.id !== id);
		} finally {
			busy = null;
		}
	}

	async function move(id: string, dir: -1 | 1) {
		const idx = items.findIndex((i) => i.id === id);
		const next = idx + dir;
		if (idx < 0 || next < 0 || next >= items.length) return;
		const reordered = [...items];
		[reordered[idx], reordered[next]] = [reordered[next], reordered[idx]];
		items = reordered;
		busy = id;
		try {
			const res = await fetch('/api/quick-adds/reorder', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ order: reordered.map((i) => i.id) })
			});
			if (!res.ok) {
				alert('Reorder failed');
				items = data.quickAddItems;
			}
		} finally {
			busy = null;
		}
	}
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
				Preferences
			</p>
			<h1 class="text-2xl font-bold text-white">Settings</h1>
		</div>
		{#if data.authEnabled}
			<form method="POST" action="/logout" class="ml-auto">
				<button
					type="submit"
					class="rounded-lg border px-3 py-1.5 text-xs font-medium text-white transition hover:bg-white/5"
					style="border-color: var(--color-border);"
				>
					Log out
				</button>
			</form>
		{/if}
	</header>

	<form onsubmit={saveTargets} class="card p-5">
		<h2 class="mb-4 text-sm font-semibold tracking-wide text-white uppercase">Daily targets</h2>

		<div class="grid grid-cols-2 gap-3">
			<label class="flex flex-col gap-1">
				<span class="text-xs font-medium" style="color: var(--color-text-subtle);">Calories</span>
				<input
					type="number"
					min="0"
					max="20000"
					step="10"
					bind:value={calorieTarget}
					class="rounded-lg border bg-transparent px-3 py-2 text-white outline-none focus:border-orange-400"
					style="border-color: var(--color-border);"
				/>
			</label>

			<label class="flex flex-col gap-1">
				<span class="text-xs font-medium" style="color: var(--color-text-subtle);">Protein (g)</span
				>
				<input
					type="number"
					min="0"
					max="1000"
					step="5"
					bind:value={proteinTargetG}
					class="rounded-lg border bg-transparent px-3 py-2 text-white outline-none focus:border-orange-400"
					style="border-color: var(--color-border);"
				/>
			</label>
		</div>

		<h2 class="mt-6 mb-2 text-sm font-semibold tracking-wide text-white uppercase">
			Carb counting
			<span class="ml-1 text-xs font-normal normal-case" style="color: var(--color-text-subtle);">
				— how bolusable carbs subtract fiber
			</span>
		</h2>
		<div class="flex gap-1 rounded-full bg-white/5 p-1">
			<button
				type="button"
				onclick={() => (fiberMode = 'full')}
				class="flex-1 rounded-full px-3 py-2 text-sm font-semibold transition"
				class:accent-gradient={fiberMode === 'full'}
				class:text-white={fiberMode === 'full'}
				style={fiberMode === 'full' ? '' : 'color: #e5e5e7;'}
			>
				Subtract all fiber
			</button>
			<button
				type="button"
				onclick={() => (fiberMode = 'half_over_5')}
				class="flex-1 rounded-full px-3 py-2 text-sm font-semibold transition"
				class:accent-gradient={fiberMode === 'half_over_5'}
				class:text-white={fiberMode === 'half_over_5'}
				style={fiberMode === 'half_over_5' ? '' : 'color: #e5e5e7;'}
			>
				Half over 5g
			</button>
		</div>
		<p class="mt-2 text-xs leading-relaxed" style="color: var(--color-text-subtle);">
			Bolusable (net glycemic) carbs = total carbs − this fiber adjustment − sugar-alcohol
			adjustment. <strong>Subtract all fiber</strong> removes the full fiber gram count;
			<strong>Half over 5g</strong> only subtracts half, and only when fiber exceeds 5g (ADA-style).
			Sugar alcohols are subtracted at a conservative 0.5× unless the polyol is known. This is a
			<strong>clinical calibration that feeds insulin dosing</strong> — review it with your care team
			and validate against CGM traces; it is not medical advice. Changing it recomputes every past day.
			Total carbs always stay visible alongside the bolusable figure.
		</p>

		<h2 class="mt-6 mb-4 text-sm font-semibold tracking-wide text-white uppercase">
			Profile
			<span class="ml-1 text-xs font-normal normal-case" style="color: var(--color-text-subtle);">
				— used to estimate calories burned
			</span>
		</h2>

		<div class="grid grid-cols-2 gap-3">
			<div class="flex flex-col gap-1">
				<span class="text-xs font-medium" style="color: var(--color-text-subtle);">Height</span>
				<div class="flex gap-2">
					<div class="relative flex-1">
						<input
							type="number"
							min="3"
							max="8"
							bind:value={heightFt}
							aria-label="Height feet"
							class="w-full rounded-lg border bg-transparent px-3 py-2 pr-7 text-white outline-none focus:border-orange-400"
							style="border-color: var(--color-border);"
						/>
						<span
							class="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs"
							style="color: var(--color-text-subtle);">ft</span
						>
					</div>
					<div class="relative flex-1">
						<input
							type="number"
							min="0"
							max="11"
							bind:value={heightIn}
							aria-label="Height inches"
							class="w-full rounded-lg border bg-transparent px-3 py-2 pr-7 text-white outline-none focus:border-orange-400"
							style="border-color: var(--color-border);"
						/>
						<span
							class="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs"
							style="color: var(--color-text-subtle);">in</span
						>
					</div>
				</div>
			</div>

			<label class="flex flex-col gap-1">
				<span class="text-xs font-medium" style="color: var(--color-text-subtle);">Sex</span>
				<select
					bind:value={sex}
					class="rounded-lg border bg-transparent px-3 py-2 text-white outline-none focus:border-orange-400"
					style="border-color: var(--color-border); color-scheme: dark;"
				>
					<option value="">—</option>
					<option value="male">Male</option>
					<option value="female">Female</option>
				</select>
			</label>

			<label class="col-span-2 flex flex-col gap-1">
				<span class="text-xs font-medium" style="color: var(--color-text-subtle);">Birth date</span>
				<input
					type="date"
					bind:value={birthDate}
					class="rounded-lg border bg-transparent px-3 py-2 text-white outline-none focus:border-orange-400"
					style="border-color: var(--color-border); color-scheme: dark;"
				/>
			</label>
		</div>

		<h2 class="mt-6 mb-2 text-sm font-semibold tracking-wide text-white uppercase">Notes</h2>
		<textarea
			bind:value={notes}
			rows="3"
			maxlength="4000"
			placeholder="Supplements, current questions, context…"
			class="w-full resize-y rounded-lg border bg-transparent px-3 py-2 text-sm text-white outline-none focus:border-orange-400"
			style="border-color: var(--color-border);"
		></textarea>
		<p class="mt-2 text-xs leading-relaxed" style="color: var(--color-text-subtle);">
			Supplements, current questions, context — included in the scheduled Claude review.
		</p>

		<div class="mt-4 flex items-center justify-between gap-3">
			<div class="text-xs" style="color: var(--color-text-subtle);">
				{#if saveError}
					<span class="text-red-300">{saveError}</span>
				{:else if savedAt && !dirty}
					Saved
				{:else if dirty}
					Unsaved changes
				{/if}
			</div>
			<button
				type="submit"
				disabled={!dirty || saving}
				class="rounded-lg px-4 py-2 text-sm font-semibold text-black transition disabled:opacity-40"
				style="background: #fb923c;"
			>
				{saving ? 'Saving…' : 'Save'}
			</button>
		</div>
	</form>

	<section class="mt-6">
		<h2
			class="mb-3 flex items-center gap-2 text-sm font-semibold tracking-wide text-white uppercase"
		>
			Quick-adds
			<span class="ml-auto text-xs font-normal" style="color: var(--color-text-subtle);">
				{items.length}
			</span>
		</h2>

		{#if items.length === 0}
			<div class="card p-6 text-center text-sm" style="color: var(--color-text-subtle);">
				No quick-adds yet. Save one from the manual-entry sheet to pin a tile here.
			</div>
		{:else}
			<div class="flex flex-col gap-2">
				{#each items as item, idx (item.id)}
					<article class="card-sm flex items-center gap-2 p-3">
						<div class="min-w-0 flex-1">
							<p class="truncate text-sm font-medium text-white">{item.name}</p>
							<p class="text-xs" style="color: var(--color-text-subtle);">
								{Math.round(item.calories)} kcal · {Math.round(item.proteinG)}g P
								{#if item.brand}
									<span> · {item.brand}</span>
								{/if}
							</p>
						</div>

						<div class="flex items-center gap-1">
							<button
								type="button"
								onclick={() => move(item.id, -1)}
								disabled={idx === 0 || busy === item.id}
								aria-label="Move up"
								class="rounded-md p-1.5 text-white transition hover:bg-white/10 disabled:opacity-30"
							>
								<svg
									width="14"
									height="14"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2.5"
									stroke-linecap="round"
									stroke-linejoin="round"
								>
									<path d="M18 15l-6-6-6 6" />
								</svg>
							</button>
							<button
								type="button"
								onclick={() => move(item.id, 1)}
								disabled={idx === items.length - 1 || busy === item.id}
								aria-label="Move down"
								class="rounded-md p-1.5 text-white transition hover:bg-white/10 disabled:opacity-30"
							>
								<svg
									width="14"
									height="14"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2.5"
									stroke-linecap="round"
									stroke-linejoin="round"
								>
									<path d="M6 9l6 6 6-6" />
								</svg>
							</button>
							<button
								type="button"
								onclick={() => unpin(item.id)}
								disabled={busy === item.id}
								aria-label="Unpin"
								class="rounded-md p-1.5 text-red-300 transition hover:bg-red-500/10 disabled:opacity-40"
							>
								<svg
									width="14"
									height="14"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2.5"
									stroke-linecap="round"
									stroke-linejoin="round"
								>
									<path
										d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"
									/>
								</svg>
							</button>
						</div>
					</article>
				{/each}
			</div>
		{/if}
	</section>
</main>
