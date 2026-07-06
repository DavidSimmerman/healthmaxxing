<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { enhance } from '$app/forms';
	import { pullToRefresh } from '$lib/actions/pullToRefresh';

	let { data, form } = $props();
	let tandemSaving = $state(false);

	// Back-sync: pull the last 2 weeks from every connected source in one call.
	let backfilling = $state(false);
	let backfillMsg = $state<string | null>(null);
	let backfillOk = $state(true);
	async function backfill() {
		backfilling = true;
		backfillMsg = null;
		try {
			const res = await fetch('/api/integrations/backfill', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ days: 14 })
			});
			const r = await res.json();
			backfillOk = res.ok;
			if (!res.ok) {
				backfillMsg = r?.message || 'Back-sync failed.';
			} else {
				const parts = ['dexcom', 'tandem', 'fitbit']
					.map((k) => {
						const v = r[k];
						if (!v || v.skipped) return null;
						return v.error ? `${k}: ${v.error}` : `${k} ✓`;
					})
					.filter(Boolean);
				backfillMsg = `Synced ${r.days} days — ${parts.length ? parts.join(', ') : 'no sources connected'}.`;
				await invalidateAll();
			}
		} catch {
			backfillOk = false;
			backfillMsg = 'Back-sync failed.';
		} finally {
			backfilling = false;
		}
	}

	let calorieTarget = $state(data.settings.calorieTarget);
	let proteinTargetG = $state(data.settings.proteinTargetG);
	// Daily deficit target (kcal). Blank clears it.
	let deficitTarget = $state(data.settings.deficitTargetKcal ?? ('' as '' | number));

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

	let deficitTargetVal = $derived(blank(deficitTarget) ? null : Number(deficitTarget));

	let dirty = $derived(
		calorieTarget !== data.settings.calorieTarget ||
			proteinTargetG !== data.settings.proteinTargetG ||
			deficitTargetVal !== (data.settings.deficitTargetKcal ?? null) ||
			heightCm !== (data.settings.heightCm ?? null) ||
			birthDate !== (data.settings.birthDate ?? '') ||
			sex !== (data.settings.sex ?? '') ||
			fiberMode !== (data.settings.fiberMode ?? 'full') ||
			// compare trimmed — save sends notes.trim(), so trailing whitespace alone
			// isn't a real change and shouldn't keep the form stuck "unsaved".
			notes.trim() !== (data.settings.notes ?? '')
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
					deficitTargetKcal: deficitTargetVal,
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
	use:pullToRefresh
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

			<label class="col-span-2 flex flex-col gap-1">
				<span class="text-xs font-medium" style="color: var(--color-text-subtle);"
					>Daily deficit target (kcal)</span
				>
				<input
					type="number"
					min="0"
					max="10000"
					step="50"
					placeholder="e.g. 500 — leave blank for none"
					bind:value={deficitTarget}
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

	<section class="card mt-6 p-5">
		<h2 class="mb-1 text-sm font-semibold tracking-wide text-white uppercase">Vacation mode</h2>
		<p class="mb-4 text-xs" style="color: var(--color-text-subtle);">
			Days inside a trip are scored against easier goals — blood sugar targets loosen upward (running
			higher to avoid lows won't hurt your score), and steps, sleep, deficit, protein &amp; water all
			relax.
		</p>

		{#if data.vacations.length}
			<ul class="mb-4 flex flex-col gap-2">
				{#each data.vacations as v (v.id)}
					<li class="card-sm flex items-center gap-3 p-3">
						<span class="text-sm text-white">{v.from} → {v.to}</span>
						<form method="POST" action="?/deleteVacation" class="ml-auto" use:enhance>
							<input type="hidden" name="id" value={v.id} />
							<button
								type="submit"
								class="rounded-lg border px-3 py-1.5 text-xs font-medium text-white transition hover:bg-white/5"
								style="border-color: var(--color-border);"
							>
								Remove
							</button>
						</form>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="mb-4 text-sm" style="color: var(--color-text-subtle);">No trips scheduled.</p>
		{/if}

		<form method="POST" action="?/addVacation" class="flex flex-wrap items-end gap-3" use:enhance>
			<label class="flex flex-col gap-1">
				<span class="text-xs font-medium" style="color: var(--color-text-subtle);">Start</span>
				<input
					type="date"
					name="from"
					required
					class="rounded-lg border bg-transparent px-3 py-2 text-white outline-none focus:border-orange-400"
					style="border-color: var(--color-border); color-scheme: dark;"
				/>
			</label>
			<label class="flex flex-col gap-1">
				<span class="text-xs font-medium" style="color: var(--color-text-subtle);">End</span>
				<input
					type="date"
					name="to"
					required
					class="rounded-lg border bg-transparent px-3 py-2 text-white outline-none focus:border-orange-400"
					style="border-color: var(--color-border); color-scheme: dark;"
				/>
			</label>
			<button
				type="submit"
				class="rounded-lg px-4 py-2 text-sm font-semibold text-black transition"
				style="background: #fb923c;"
			>
				Add trip
			</button>
		</form>

		{#if form?.vacationError}
			<p class="mt-3 text-sm text-red-400">{form.vacationError}</p>
		{/if}
	</section>

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

	{#if data.dexcomConfigured || data.fitbitConfigured || data.tandemConfigured}
		<section class="mt-6">
			<h2 class="mb-3 text-sm font-semibold tracking-wide text-white uppercase">Integrations</h2>
			{#if data.dexcomConfigured}
				<article class="card-sm flex items-center gap-3 p-4">
					<div class="min-w-0 flex-1">
						<p class="flex items-center gap-2 text-sm font-medium text-white">
							Dexcom CGM
							{#if data.dexcomConnected}
								<span class="text-xs font-normal text-emerald-400">● Connected</span>
							{/if}
						</p>
						<p class="mt-0.5 text-xs leading-relaxed" style="color: var(--color-text-subtle);">
							Syncs your glucose trace, time-in-range and GMI from Dexcom.
						</p>
					</div>
					<!-- Full-page redirect to Dexcom's consent screen (no token needed — being
					     logged in is the owner check; see the authorize route). -->
					<a
						href="/api/integrations/dexcom/authorize"
						class="shrink-0 rounded-lg px-4 py-2 text-sm font-semibold text-black transition hover:brightness-110"
						style="background: #fb923c;"
					>
						{data.dexcomConnected ? 'Reconnect' : 'Connect'}
					</a>
				</article>
			{/if}

			{#if data.fitbitConfigured}
				<article class="card-sm mt-3 flex items-center gap-3 p-4">
					<div class="min-w-0 flex-1">
						<p class="flex items-center gap-2 text-sm font-medium text-white">
							Fitbit
							{#if data.fitbitConnected}
								<span class="text-xs font-normal text-emerald-400">● Connected</span>
							{/if}
						</p>
						<p class="mt-0.5 text-xs leading-relaxed" style="color: var(--color-text-subtle);">
							Syncs steps, sleep and resting heart rate via the Google Health API. Reconnect
							if the token expires or is revoked.
						</p>
					</div>
					<!-- Redirect to Google's consent screen (offline + prompt=consent mints a
					     fresh refresh token; being logged in is the owner check). Opens in a
					     new tab so the flow runs in the system browser, not the installed
					     PWA's webview — Google rejects embedded webviews (disallowed_useragent).
					     The callback stores the token server-side, so finishing in that tab is
					     all that's needed. -->
					<a
						href="/api/integrations/fitbit/authorize"
						target="_blank"
						rel="noopener"
						class="shrink-0 rounded-lg px-4 py-2 text-sm font-semibold text-black transition hover:brightness-110"
						style="background: #fb923c;"
					>
						{data.fitbitConnected ? 'Reconnect' : 'Connect'}
					</a>
				</article>
			{/if}

			{#if data.tandemConfigured}
				<article class="card-sm mt-3 p-4">
					<p class="flex items-center gap-2 text-sm font-medium text-white">
						Tandem t:slim (insulin)
						{#if data.tandemConnected}
							<span class="text-xs font-normal text-emerald-400">● Connected</span>
						{/if}
					</p>
					<p class="mt-0.5 text-xs leading-relaxed" style="color: var(--color-text-subtle);">
						Pulls your basal rate, boluses (carbs + delivered) and Control-IQ auto-corrections from
						Tandem Source. Uses your Tandem&nbsp;Source login — stored encrypted, only used to sync.
					</p>
					<form
						method="POST"
						action="?/connectTandem"
						class="mt-3 flex flex-col gap-2"
						use:enhance={() => {
							tandemSaving = true;
							return async ({ update }) => {
								await update();
								tandemSaving = false;
							};
						}}
					>
						<input
							name="username"
							type="email"
							autocomplete="username"
							placeholder="Tandem Source email"
							required
							class="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-white/30"
						/>
						<input
							name="password"
							type="password"
							autocomplete="current-password"
							placeholder="Tandem Source password"
							required
							class="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-white/30"
						/>
						<div class="flex items-center gap-2">
							<select
								name="region"
								class="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white"
							>
								<option value="US">US</option>
								<option value="EU">EU</option>
							</select>
							<button
								type="submit"
								disabled={tandemSaving}
								class="flex-1 rounded-lg px-4 py-2 text-sm font-semibold text-black transition hover:brightness-110 disabled:opacity-50"
								style="background: #fb923c;"
							>
								{tandemSaving ? 'Connecting…' : data.tandemConnected ? 'Reconnect' : 'Connect'}
							</button>
						</div>
						{#if form?.tandemError}
							<p class="text-xs text-rose-400">{form.tandemError}</p>
						{:else if form?.tandemConnected}
							<p class="text-xs text-emerald-400">
								Connected — pulled {form.tandemSynced} insulin event{form.tandemSynced === 1
									? ''
									: 's'}{form.tandemGlucose ? ` and ${form.tandemGlucose} glucose readings` : ''}.
							</p>
						{/if}
					</form>
				</article>
			{/if}

			<article class="card-sm mt-3 flex items-center gap-3 p-4">
				<div class="min-w-0 flex-1">
					<p class="text-sm font-medium text-white">Back-sync history</p>
					<p class="mt-0.5 text-xs leading-relaxed" style="color: var(--color-text-subtle);">
						Pull the last 2 weeks from every connected source at once.
					</p>
					{#if backfillMsg}
						<p
							class="mt-1 text-xs"
							class:text-emerald-400={backfillOk}
							class:text-rose-400={!backfillOk}
						>
							{backfillMsg}
						</p>
					{/if}
				</div>
				<button
					type="button"
					onclick={backfill}
					disabled={backfilling}
					class="shrink-0 rounded-lg px-4 py-2 text-sm font-semibold text-black transition hover:brightness-110 disabled:opacity-50"
					style="background: #fb923c;"
				>
					{backfilling ? 'Syncing…' : 'Back-sync 2 weeks'}
				</button>
			</article>
		</section>
	{/if}
</main>
