<script lang="ts">
	import { onMount } from 'svelte';
	import BarcodeScan from './BarcodeScan.svelte';
	import AiDescribe from './AiDescribe.svelte';
	import { openNewChat } from '$lib/stores/chat';
	import { fuzzySearch } from '$lib/fuzzy';
	import { UNITS, UNIT_LABEL, toServings, formatAmount, type Unit } from '$lib/units';

	type Ingredient = {
		name: string;
		amount: string | null;
		calories: number;
		proteinG: number;
		carbsG: number;
		fatG: number;
	};

	type HistoryFood = {
		foodId: string;
		name: string;
		brand: string | null;
		servingSize: string | null;
		servingGrams: number | null;
		calories: number;
		proteinG: number;
		carbsG: number;
		fatG: number;
		// Derived per-serving bolusable (net glycemic) carbs; carbsG stays the total.
		bolusableCarbsG: number;
		bolusableLowConfidence: boolean;
		categories: string | null;
		ingredients: Ingredient[] | null;
		makesServings: number | null;
		totalGrams: number | null;
		lastLoggedAt: string | null;
		countTotal: number;
		count14d: number;
	};

	// A food staged into the current meal (not yet written). Macros are the amount
	// actually being logged (food per-serving × servings), so the review running
	// total is exact without a server round-trip. foodId/amount/unit replay the
	// same /api/log POST on confirm.
	type MealItem = {
		foodId: string;
		name: string;
		amount: number;
		unit: Unit;
		servings: number;
		calories: number;
		proteinG: number;
		carbsG: number;
		fatG: number;
		bolusableCarbsG: number;
		bolusableLowConfidence: boolean;
	};

	type Mode = 'browse' | 'detail' | 'review' | 'barcode' | 'ai';

	let { open = $bindable(false) }: { open: boolean } = $props();
	let mode = $state<Mode>('browse');

	let history = $state<HistoryFood[]>([]);
	let loading = $state(false);
	let loaded = $state(false);
	let query = $state('');
	let selected = $state<HistoryFood | null>(null);
	// Amount the user is logging, in `unit`. Grams/volume convert via servingGrams.
	let unit = $state<Unit>('serving');
	let amount = $state(1);
	let logging = $state(false);
	let deletingId = $state<string | null>(null);

	// Log time (HH:MM, local today), defaulted to now. A past/now time logs the
	// meal at that time; a future time schedules it (pending) for later today.
	let scheduleAt = $state(hhmm(new Date()));
	function hhmm(d: Date) {
		return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
	}
	// The chosen HH:MM resolved to a Date today, and whether it's in the future.
	let logWhen = $derived.by(() => {
		const d = new Date();
		if (scheduleAt) {
			const [h, m] = scheduleAt.split(':').map(Number);
			d.setHours(h, m, 0, 0);
		}
		return d;
	});
	let isFuture = $derived(logWhen.getTime() > Date.now());

	// Items staged into the current meal (T1D bolus: log several foods, see the
	// combined carb + bolusable total, then confirm once). Nothing is written until
	// confirmMeal(); closing the sheet discards an unconfirmed meal.
	let meal = $state<MealItem[]>([]);
	let mealError = $state<string | null>(null);
	let mealTotals = $derived(
		meal.reduce(
			(t, m) => ({
				calories: t.calories + m.calories,
				proteinG: t.proteinG + m.proteinG,
				carbsG: t.carbsG + m.carbsG,
				fatG: t.fatG + m.fatG,
				bolusableCarbsG: t.bolusableCarbsG + m.bolusableCarbsG,
				lowConfidence: t.lowConfidence || m.bolusableLowConfidence
			}),
			{ calories: 0, proteinG: 0, carbsG: 0, fatG: 0, bolusableCarbsG: 0, lowConfidence: false }
		)
	);

	const isRecipe = (f: HistoryFood) => !!f.ingredients && f.ingredients.length > 0;

	// Inline name editing (OFF names are often incomplete; let the user fix them).
	let editingName = $state(false);
	let nameDraft = $state('');
	let savingName = $state(false);

	// Keyboard handling: track the visible viewport so that, while the search
	// field is focused, the sheet can size itself to the space *above* the
	// on-screen keyboard instead of being covered by it.
	let searchFocused = $state(false);
	let viewportH = $state(0);
	let viewportTop = $state(0);
	// Space taken by the on-screen keyboard (and its accessory bar). The expanded
	// panel reaches the physical bottom so its background fills behind the
	// keyboard; this inset pads the scroll area so results can clear it.
	let keyboardInset = $state(0);

	onMount(() => {
		const vv = window.visualViewport;
		if (!vv) return;
		const update = () => {
			viewportH = vv.height;
			viewportTop = vv.offsetTop;
			keyboardInset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
		};
		update();
		vv.addEventListener('resize', update);
		vv.addEventListener('scroll', update);
		return () => {
			vv.removeEventListener('resize', update);
			vv.removeEventListener('scroll', update);
		};
	});

	// Load history the first time the sheet opens; refresh on each open so newly
	// logged foods (e.g. just added via Claude) show up. Also re-default the log
	// time to "now" on each open — the component is mounted once (in the layout),
	// so a load-time initializer would go stale across a long-lived session.
	$effect(() => {
		if (!open) return;
		scheduleAt = hhmm(new Date());
		if (mode !== 'barcode' && mode !== 'ai') loadHistory();
	});

	async function loadHistory() {
		loading = !loaded;
		try {
			const res = await fetch('/api/foods/history');
			if (res.ok) {
				history = (await res.json()).foods ?? [];
				loaded = true;
			}
		} finally {
			loading = false;
		}
	}

	// Most-logged foods over the last 14 days, busiest first.
	let popular = $derived(
		history
			.filter((f) => f.count14d > 0)
			.sort(
				(a, b) =>
					b.count14d - a.count14d ||
					Date.parse(b.lastLoggedAt ?? '') - Date.parse(a.lastLoggedAt ?? '')
			)
			.slice(0, 12)
	);

	let results = $derived(
		query.trim()
			? fuzzySearch(query, history, {
					text: (f) => `${f.name} ${f.brand ?? ''}`,
					keywords: (f) => f.categories,
					lastLogged: (f) => f.lastLoggedAt ?? '',
					now: Date.now(),
					limit: 50
				}).map((r) => r.item)
			: []
	);

	let shown = $derived(query.trim() ? results : popular);

	// Show the brand as a subtitle only when it isn't already part of the name
	// (OFF names now fold the brand in, so this avoids "Built · Built Puff …").
	function subBrand(f: HistoryFood): string | null {
		return f.brand && !f.name.toLowerCase().includes(f.brand.toLowerCase()) ? f.brand : null;
	}

	// Become a full-height panel anchored to the top (sized to the viewport above
	// the keyboard) while searching — either focused or with a query present.
	// Keeping it expanded once there's a query means tapping a result doesn't
	// blur → collapse → reflow the list out from under the tap. Otherwise sit as
	// a bottom sheet at a fixed height (so result count never shifts layout).
	let browseExpanded = $derived(
		mode === 'browse' && (searchFocused || query.trim().length > 0) && viewportH > 0
	);

	function close() {
		open = false;
		// reset after the sheet animates out — discards any unconfirmed meal.
		setTimeout(() => {
			mode = 'browse';
			query = '';
			selected = null;
			searchFocused = false;
			meal = [];
			mealError = null;
		}, 200);
	}

	function reload() {
		close();
		location.reload();
	}

	function pick(f: HistoryFood) {
		selected = f;
		unit = 'serving';
		amount = 1;
		mode = 'detail';
		searchFocused = false;
		editingName = false;
	}

	// Detail-view amount → servings multiplier (grams/volume convert via servingGrams).
	let hasGrams = $derived(!!selected?.servingGrams && selected.servingGrams > 0);
	let servingsPreview = $derived(
		selected ? toServings(Number(amount) || 0, unit, selected.servingGrams) : 0
	);
	// Carbs at the chosen amount: total (label) vs bolusable (net glycemic, the dose figure).
	let carbsPreview = $derived(selected ? selected.carbsG * servingsPreview : 0);
	let bolusPreview = $derived(selected ? selected.bolusableCarbsG * servingsPreview : 0);

	function unitAvail(u: Unit): boolean {
		return u === 'serving' || hasGrams;
	}

	// Step size by unit — fine for fractional servings, coarser for grams.
	function step(): number {
		switch (unit) {
			case 'gram':
				return 5;
			case 'tbsp':
			case 'tsp':
				return 1;
			default:
				return 0.25;
		}
	}

	// Swipe-to-delete: archive a food so it never shows in search again. Past days
	// keep it (they render from cached macros), so this is a soft delete.
	async function deleteFood(f: HistoryFood) {
		if (deletingId) return;
		if (!confirm(`Remove "${f.name}" from search? Past days keep it.`)) return;
		deletingId = f.foodId;
		try {
			const res = await fetch(`/api/foods/${f.foodId}`, { method: 'DELETE' });
			if (res.ok) history = history.filter((h) => h.foodId !== f.foodId);
		} finally {
			deletingId = null;
		}
	}

	// Reveal a Delete button by swiping a row left (pointer events → works for touch
	// and mouse). Suppresses the click that would otherwise fire `pick` after a drag.
	function swipeRow(node: HTMLElement) {
		const REVEAL = 88;
		let startX = 0;
		let startY = 0;
		let dx = 0;
		let dragging = false;
		let decided = false;
		let horizontal = false;
		let moved = false;
		let openState = false;

		const setX = (x: number, animate: boolean) => {
			node.style.transition = animate ? 'transform 0.18s ease' : 'none';
			node.style.transform = `translateX(${x}px)`;
		};
		const onDown = (e: PointerEvent) => {
			startX = e.clientX;
			startY = e.clientY;
			dragging = true;
			decided = false;
			horizontal = false;
			moved = false;
		};
		const onMove = (e: PointerEvent) => {
			if (!dragging) return;
			const ddx = e.clientX - startX;
			const ddy = e.clientY - startY;
			if (!decided) {
				if (Math.abs(ddx) < 6 && Math.abs(ddy) < 6) return;
				decided = true;
				horizontal = Math.abs(ddx) > Math.abs(ddy);
			}
			if (!horizontal) return;
			moved = true;
			e.preventDefault();
			const base = openState ? -REVEAL : 0;
			dx = Math.max(-REVEAL - 16, Math.min(0, base + ddx));
			setX(dx, false);
		};
		const onUp = () => {
			if (!dragging) return;
			dragging = false;
			if (moved && horizontal) {
				openState = dx < -REVEAL / 2;
				setX(openState ? -REVEAL : 0, true);
			} else if (openState) {
				// A tap on an open row closes it instead of picking.
				openState = false;
				moved = true;
				setX(0, true);
			}
		};
		const onClick = (e: MouseEvent) => {
			if (moved) {
				e.stopPropagation();
				e.preventDefault();
				moved = false;
			}
		};
		node.addEventListener('pointerdown', onDown);
		node.addEventListener('pointermove', onMove);
		node.addEventListener('pointerup', onUp);
		node.addEventListener('pointercancel', onUp);
		node.addEventListener('click', onClick, true);
		return {
			destroy() {
				node.removeEventListener('pointerdown', onDown);
				node.removeEventListener('pointermove', onMove);
				node.removeEventListener('pointerup', onUp);
				node.removeEventListener('pointercancel', onUp);
				node.removeEventListener('click', onClick, true);
			}
		};
	}

	function startEditName() {
		if (!selected) return;
		nameDraft = selected.name;
		editingName = true;
	}

	async function saveName() {
		// Capture the food before awaiting: the user may close the sheet or pick
		// another item mid-request, which would otherwise null/repoint `selected`.
		const food = selected;
		if (!food) return;
		const name = nameDraft.trim();
		if (!name || name === food.name) {
			editingName = false;
			return;
		}
		savingName = true;
		try {
			const res = await fetch(`/api/foods/${food.foodId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name })
			});
			if (res.ok) {
				// `food` is the same object held in `history`, so mutating it updates
				// the underlying list (and the detail view if still showing it).
				food.name = name;
				editingName = false;
			}
		} finally {
			savingName = false;
		}
	}

	// Stage the selected food (at the chosen amount) into the meal, then show the
	// review so the running carb + bolusable total is visible. Nothing is written yet.
	function addToMeal() {
		const f = selected;
		const s = servingsPreview;
		if (!f || !(s > 0)) return;
		meal.push({
			foodId: f.foodId,
			name: f.name,
			amount: Number(amount),
			unit,
			servings: s,
			calories: f.calories * s,
			proteinG: f.proteinG * s,
			carbsG: f.carbsG * s,
			fatG: f.fatG * s,
			bolusableCarbsG: f.bolusableCarbsG * s,
			bolusableLowConfidence: f.bolusableLowConfidence
		});
		mealError = null;
		selected = null;
		mode = 'review';
	}

	function removeMealItem(i: number) {
		meal.splice(i, 1);
		if (meal.length === 0) mode = 'browse';
	}

	// Go pick another food, keeping the staged meal.
	function logAnother() {
		mode = 'browse';
		query = '';
		selected = null;
	}

	// Commit every staged item at the chosen time. A future time schedules it
	// (pending row via /api/planned); a past/now time logs it at that time via
	// /api/log. Succeeded items are removed as they land, so a retry after a
	// mid-way failure only re-sends what's left (no double-logging). Reloads once
	// the whole meal is written.
	async function logMeal() {
		if (meal.length === 0 || logging) return;
		// Recompute fresh at click time — the derived values can go stale if the
		// sheet sat open past the chosen minute.
		const when = new Date();
		if (scheduleAt) {
			const [h, m] = scheduleAt.split(':').map(Number);
			when.setHours(h, m, 0, 0);
		}
		const future = when.getTime() > Date.now();
		const whenISO = when.toISOString();
		const url = future ? '/api/planned' : '/api/log';
		const verb = future ? 'schedule' : 'log';
		logging = true;
		mealError = null;
		try {
			while (meal.length > 0) {
				const m = meal[0];
				const res = await fetch(url, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						foodId: m.foodId,
						amount: m.amount,
						unit: m.unit,
						...(future ? { scheduledAt: whenISO } : { loggedAt: whenISO })
					})
				});
				if (!res.ok) {
					mealError = `Couldn't ${verb} "${m.name}". ${meal.length} item(s) left — tap to retry.`;
					return;
				}
				meal.shift();
			}
			reload();
		} catch {
			mealError = `Network error while ${verb === 'log' ? 'logging' : 'scheduling'}. Tap to retry.`;
		} finally {
			logging = false;
		}
	}
</script>

{#if open}
	<div
		class="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
		onclick={close}
		role="button"
		tabindex="-1"
		aria-label="Close"
		onkeydown={(e) => e.key === 'Escape' && close()}
	></div>

	<div
		class="fixed right-0 bottom-0 left-0 z-50 flex flex-col border-t"
		class:rounded-t-3xl={!browseExpanded}
		style="
			background: var(--color-bg-elevated);
			border-color: var(--color-border);
			{browseExpanded
			? `top: ${viewportTop}px; padding-top: env(safe-area-inset-top);`
			: mode === 'browse'
				? 'height: 82dvh;'
				: 'max-height: 90dvh;'}
		"
	>
		{#if mode === 'browse'}
			<div class="flex shrink-0 flex-col px-5 pt-3">
				{#if browseExpanded}
					<!-- Expanded panel covers the backdrop, so keep a close control at the
					     top (above the keyboard) — the bottom Cancel is hidden/offscreen. -->
					<div class="mb-2 flex justify-end">
						<button class="-mr-2 px-2 py-1 text-sm font-semibold text-white" onclick={close}>
							Cancel
						</button>
					</div>
				{:else}
					<div class="mx-auto mb-4 h-1 w-12 rounded-full bg-white/20"></div>
				{/if}

				{#if meal.length > 0}
					<!-- Meal in progress — jump back to review the running bolus total. -->
					<button
						class="mb-3 flex w-full items-center justify-between rounded-xl px-4 py-2.5"
						style="background: rgba(252,211,77,0.10); border: 1px solid rgba(252,211,77,0.22);"
						onclick={() => (mode = 'review')}
					>
						<span class="text-sm font-medium text-white">
							{meal.length} item{meal.length === 1 ? '' : 's'} in meal
						</span>
						<span class="text-sm font-semibold" style="color: var(--color-carbs);">
							{Math.round(mealTotals.bolusableCarbsG)}g bolusable · Review →
						</span>
					</button>
				{/if}

				<div class="flex items-center gap-2">
					<div class="card-sm flex flex-1 items-center gap-2 px-3 py-2.5">
						<svg
							class="h-4 w-4 shrink-0"
							style="color: var(--color-text-subtle);"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							viewBox="0 0 24 24"
						>
							<circle cx="11" cy="11" r="7" />
							<path stroke-linecap="round" d="m21 21-4.3-4.3" />
						</svg>
						<input
							bind:value={query}
							onfocus={() => (searchFocused = true)}
							onblur={() => (searchFocused = false)}
							placeholder="Search your foods"
							autocomplete="off"
							autocapitalize="off"
							spellcheck="false"
							class="w-full bg-transparent text-white outline-none placeholder:text-zinc-500"
						/>
						{#if query}
							<button
								class="shrink-0 text-zinc-500 transition hover:text-white"
								aria-label="Clear search"
								onclick={() => (query = '')}
							>
								<svg
									class="h-4 w-4"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									viewBox="0 0 24 24"
								>
									<path stroke-linecap="round" d="M6 6l12 12M18 6L6 18" />
								</svg>
							</button>
						{/if}
					</div>
					<button
						class="card-sm flex h-11 w-11 shrink-0 items-center justify-center text-lg text-white transition active:scale-95"
						aria-label="Ask the AI assistant"
						onclick={() => {
							open = false;
							openNewChat();
						}}
					>
						💬
					</button>
					<button
						class="card-sm flex h-11 w-11 shrink-0 items-center justify-center text-lg text-white transition active:scale-95"
						aria-label="Describe or scan a label with Claude"
						onclick={() => (mode = 'ai')}
					>
						✨
					</button>
					<button
						class="card-sm flex h-11 w-11 shrink-0 items-center justify-center text-white transition active:scale-95"
						aria-label="Scan barcode"
						onclick={() => (mode = 'barcode')}
					>
						<svg
							class="h-6 w-6"
							fill="none"
							stroke="currentColor"
							stroke-width="1.8"
							viewBox="0 0 24 24"
						>
							<path
								stroke-linecap="round"
								d="M4 6h2M8 6h1M11 6h2M15 6h1M18 6h2M4 18h2M8 18h1M11 18h2M15 18h1M18 18h2M4 10v4M20 10v4M8 10v4M16 10v4M12 10v4"
							/>
						</svg>
					</button>
				</div>

				{#if !query}
					<h3
						class="mt-3 px-1 text-xs font-semibold tracking-wider uppercase"
						style="color: var(--color-text-subtle);"
					>
						Popular · last 14 days
					</h3>
				{/if}
			</div>

			<div
				class="min-h-0 flex-1 overflow-y-auto px-5 pt-2"
				style={browseExpanded ? `padding-bottom: ${keyboardInset}px;` : ''}
			>
				{#if loading && shown.length === 0}
					<p class="py-10 text-center text-sm" style="color: var(--color-text-subtle);">Loading…</p>
				{:else if shown.length === 0}
					<p class="py-10 text-center text-sm" style="color: var(--color-text-subtle);">
						{#if query}
							No matches in your history. Scan a barcode, or ask Claude to log it.
						{:else}
							Nothing logged recently. Scan a barcode, or ask Claude to log a meal.
						{/if}
					</p>
				{:else}
					<div class="space-y-2 pb-2">
						{#each shown as f (f.foodId)}
							<div class="relative overflow-hidden rounded-2xl">
								<!-- Revealed by swiping the row left -->
								<button
									type="button"
									class="absolute inset-y-0 right-0 flex w-[88px] items-center justify-center rounded-r-2xl bg-rose-600 text-sm font-semibold text-white disabled:opacity-60"
									aria-label={`Remove ${f.name} from search`}
									disabled={deletingId === f.foodId}
									onclick={() => deleteFood(f)}
								>
									{deletingId === f.foodId ? '…' : 'Delete'}
								</button>
								<button
									type="button"
									use:swipeRow
									class="card-sm relative flex w-full touch-pan-y items-center gap-3 p-3.5 text-left transition hover:bg-white/5"
									style="border-radius: 0;"
									onclick={() => pick(f)}
								>
									<div class="min-w-0 flex-1">
										<div class="flex items-center gap-2">
											<span class="truncate font-semibold text-white">{f.name}</span>
											{#if isRecipe(f)}
												<span
													class="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold tracking-wide"
													style="background: rgba(251,146,60,0.14); color: #fdba74;"
												>
													RECIPE
												</span>
											{/if}
										</div>
										<div class="truncate text-xs" style="color: var(--color-text-subtle);">
											{#if subBrand(f)}{subBrand(f)} ·
											{/if}{Math.round(f.calories)} kcal · {Math.round(f.proteinG)}p
										</div>
									</div>
									{#if !query && f.count14d > 1}
										<span
											class="shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold"
											style="background: rgba(251,146,60,0.15); color: #fdba74;"
										>
											{f.count14d}×
										</span>
									{/if}
								</button>
							</div>
						{/each}
					</div>
				{/if}
			</div>

			{#if !browseExpanded}
				<button
					class="shrink-0 py-3 text-sm"
					style="color: var(--color-text-subtle); padding-bottom: calc(0.75rem + env(safe-area-inset-bottom));"
					onclick={close}
				>
					Cancel
				</button>
			{/if}
		{:else if mode === 'detail' && selected}
			<div
				class="flex flex-col p-5"
				style="padding-bottom: calc(1.25rem + env(safe-area-inset-bottom));"
			>
				<div class="mx-auto mb-4 h-1 w-12 shrink-0 rounded-full bg-white/20"></div>

				<div class="flex items-center justify-between">
					<button
						class="text-sm"
						style="color: var(--color-text-subtle);"
						onclick={() => (mode = 'browse')}
					>
						← Back
					</button>
					<h2 class="font-semibold text-white">Add food</h2>
					<div class="w-12"></div>
				</div>

				<div class="card-sm mt-4 p-5">
					{#if editingName}
						<input
							bind:value={nameDraft}
							autocomplete="off"
							class="w-full rounded-lg bg-white/5 px-3 py-2 text-xl font-bold text-white outline-none focus:bg-white/10"
							onkeydown={(e) => {
								if (e.key === 'Enter') saveName();
								if (e.key === 'Escape') editingName = false;
							}}
						/>
						<div class="mt-2 flex justify-end gap-2">
							<button
								class="rounded-lg px-3 py-1.5 text-sm"
								style="color: var(--color-text-subtle);"
								onclick={() => (editingName = false)}
							>
								Cancel
							</button>
							<button
								class="accent-gradient rounded-lg px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
								disabled={savingName || !nameDraft.trim()}
								onclick={saveName}
							>
								{savingName ? 'Saving…' : 'Save name'}
							</button>
						</div>
					{:else}
						<div class="flex items-start justify-between gap-2">
							<h3 class="text-xl font-bold text-white">{selected.name}</h3>
							<button
								class="-mt-1 -mr-1 shrink-0 rounded-lg p-1.5 text-zinc-500 transition hover:bg-white/5 hover:text-white"
								aria-label="Edit name"
								onclick={startEditName}
							>
								<svg
									class="h-4 w-4"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									viewBox="0 0 24 24"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										d="M11 4H5a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2v-6m-1.5-9.5l3 3L11 18H8v-3l9.5-9.5z"
									/>
								</svg>
							</button>
						</div>
						{#if subBrand(selected)}
							<p class="text-sm" style="color: var(--color-text-subtle);">{subBrand(selected)}</p>
						{/if}
					{/if}

					{#if isRecipe(selected)}
						<span
							class="mt-2 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold"
							style="background: rgba(251,146,60,0.12); color: #fdba74;"
						>
							🍳 Recipe · makes {formatAmount(selected.makesServings ?? 1)}{#if selected.totalGrams}
								· {Math.round(selected.totalGrams)}g batch{/if}
						</span>
					{/if}

					<div class="mt-4 grid grid-cols-4 gap-2 text-center">
						<div>
							<div class="text-lg font-bold text-white">
								{Math.round(selected.calories * servingsPreview)}
							</div>
							<div class="text-xs" style="color: var(--color-text-subtle);">kcal</div>
						</div>
						<div>
							<div class="text-lg font-bold" style="color: var(--color-protein);">
								{Math.round(selected.proteinG * servingsPreview)}
							</div>
							<div class="text-xs" style="color: var(--color-text-subtle);">protein</div>
						</div>
						<div>
							<div class="text-lg font-bold" style="color: var(--color-carbs);">
								{Math.round(selected.carbsG * servingsPreview)}
							</div>
							<div class="text-xs" style="color: var(--color-text-subtle);">carbs</div>
						</div>
						<div>
							<div class="text-lg font-bold" style="color: var(--color-fat);">
								{Math.round(selected.fatG * servingsPreview)}
							</div>
							<div class="text-xs" style="color: var(--color-text-subtle);">fat</div>
						</div>
					</div>

					<!-- Bolusable (net glycemic) carbs — the figure to dose off. Total stays visible. -->
					<div
						class="mt-4 flex items-center justify-between rounded-xl px-4 py-3"
						style="background: rgba(252,211,77,0.10); border: 1px solid rgba(252,211,77,0.22);"
					>
						<div>
							<div
								class="text-xs font-semibold tracking-wide uppercase"
								style="color: var(--color-carbs);"
							>
								Bolusable carbs
							</div>
							<div class="text-[11px]" style="color: var(--color-text-subtle);">
								of {Math.round(carbsPreview)}g total
								{#if selected.bolusableLowConfidence}· ⚠︎ fiber unknown — verify label{/if}
							</div>
						</div>
						<div class="text-2xl font-bold" style="color: var(--color-carbs);">
							{Math.round(bolusPreview)}<span class="text-sm font-medium">g</span>
						</div>
					</div>

					<!-- Unit picker — log by serving, grams, or volume -->
					<div class="no-scrollbar mt-4 flex gap-1 overflow-x-auto rounded-full bg-white/5 p-1">
						{#each UNITS as u (u)}
							{@const enabled = unitAvail(u)}
							<button
								type="button"
								disabled={!enabled}
								onclick={() => (unit = u)}
								class="shrink-0 rounded-full px-4 py-1.5 text-sm font-semibold transition"
								class:accent-gradient={unit === u}
								class:text-white={unit === u}
								style={unit === u ? '' : `color: ${enabled ? '#e5e5e7' : '#52525b'};`}
							>
								{UNIT_LABEL[u]}
							</button>
						{/each}
					</div>
					{#if !hasGrams}
						<p class="mt-2 text-center text-xs" style="color: var(--color-text-subtle);">
							Set a serving weight on this food to log by g / cup / tbsp / tsp.
						</p>
					{/if}

					<!-- Amount + stepper -->
					<div class="mt-3 flex items-center justify-center gap-3">
						<button
							class="card-sm flex h-10 w-10 items-center justify-center text-xl text-white"
							aria-label="Less"
							type="button"
							onclick={() => (amount = Math.max(0, Number((Number(amount) - step()).toFixed(2))))}
						>
							−
						</button>
						<input
							bind:value={amount}
							type="number"
							step={step()}
							min="0"
							inputmode="decimal"
							class="card-sm w-28 bg-transparent py-2.5 text-center text-2xl font-bold text-white outline-none"
						/>
						<button
							class="card-sm flex h-10 w-10 items-center justify-center text-xl text-white"
							aria-label="More"
							type="button"
							onclick={() => (amount = Number((Number(amount) + step()).toFixed(2)))}
						>
							+
						</button>
					</div>
					<p class="mt-1 text-center text-xs" style="color: var(--color-text-subtle);">
						{UNIT_LABEL[unit]}{#if selected.servingSize}
							· {selected.servingSize}{/if}
					</p>

					{#if isRecipe(selected) && selected.ingredients}
						<div class="mt-4 border-t pt-3" style="border-color: var(--color-border);">
							<p
								class="mb-2 text-xs font-semibold tracking-wider uppercase"
								style="color: var(--color-text-subtle);"
							>
								Ingredients · whole recipe
							</p>
							<div class="space-y-1.5">
								{#each selected.ingredients as ing, i (i)}
									<div class="flex items-baseline justify-between gap-2 text-sm">
										<span class="min-w-0 truncate text-zinc-200">
											{ing.name}{#if ing.amount}<span
													class="ml-1.5 text-xs"
													style="color: var(--color-text-subtle);">{ing.amount}</span
												>{/if}
										</span>
										<span class="shrink-0 text-xs" style="color: var(--color-text-subtle);">
											{Math.round(ing.calories)} kcal
										</span>
									</div>
								{/each}
							</div>
						</div>
					{/if}
				</div>

				<button
					class="accent-gradient mt-4 w-full rounded-2xl py-4 font-bold text-white disabled:opacity-50"
					disabled={!(Number(amount) > 0)}
					onclick={addToMeal}
				>
					{meal.length > 0 ? 'Add to meal' : 'Log to today'}
				</button>
			</div>
		{:else if mode === 'review'}
			<div
				class="flex flex-col p-5"
				style="padding-bottom: calc(1.25rem + env(safe-area-inset-bottom));"
			>
				<div class="mx-auto mb-4 h-1 w-12 shrink-0 rounded-full bg-white/20"></div>

				<div class="flex items-center justify-between">
					<div class="w-12"></div>
					<h2 class="font-semibold text-white">Your meal</h2>
					<button class="text-sm" style="color: var(--color-text-subtle);" onclick={close}>
						Cancel
					</button>
				</div>

				<!-- Combined bolus number for the whole meal — the point of multi-logging. -->
				<div
					class="mt-4 rounded-2xl px-5 py-4 text-center"
					style="background: rgba(252,211,77,0.10); border: 1px solid rgba(252,211,77,0.22);"
				>
					<div
						class="text-xs font-semibold tracking-wide uppercase"
						style="color: var(--color-carbs);"
					>
						Bolusable carbs
					</div>
					<div class="text-4xl font-extrabold" style="color: var(--color-carbs);">
						{Math.round(mealTotals.bolusableCarbsG)}<span class="text-lg font-semibold">g</span>
					</div>
					<div class="text-xs" style="color: var(--color-text-subtle);">
						of {Math.round(mealTotals.carbsG)}g total carbs · {Math.round(mealTotals.calories)} kcal
						{#if mealTotals.lowConfidence}<br />⚠︎ some items missing fiber data — verify from label{/if}
					</div>
				</div>

				<!-- Staged items, each with total + bolusable carbs -->
				<div class="mt-4 flex flex-col gap-2">
					{#each meal as m, i (i)}
						<div class="card-sm flex items-center justify-between gap-3 p-3">
							<div class="min-w-0">
								<div class="truncate text-sm font-medium text-white">{m.name}</div>
								<div class="text-xs" style="color: var(--color-text-subtle);">
									{formatAmount(m.amount)}
									{UNIT_LABEL[m.unit]} · {Math.round(m.calories)} kcal
								</div>
							</div>
							<div class="flex items-center gap-3">
								<div class="text-right">
									<div class="text-sm font-bold" style="color: var(--color-carbs);">
										{Math.round(m.bolusableCarbsG)}g
									</div>
									<div class="text-[10px]" style="color: var(--color-text-subtle);">
										of {Math.round(m.carbsG)}g{#if m.bolusableLowConfidence}
											⚠︎{/if}
									</div>
								</div>
								<button
									class="shrink-0 rounded-lg p-1.5 text-zinc-500 transition hover:bg-white/5 hover:text-white"
									aria-label="Remove {m.name}"
									onclick={() => removeMealItem(i)}
								>
									<svg
										class="h-4 w-4"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										viewBox="0 0 24 24"
									>
										<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
									</svg>
								</button>
							</div>
						</div>
					{/each}
				</div>

				{#if mealError}
					<p class="mt-3 text-center text-sm" style="color: #fb7185;">{mealError}</p>
				{/if}

				<button
					class="mt-4 w-full rounded-2xl border py-3 font-semibold text-white"
					style="border-color: var(--color-border);"
					onclick={logAnother}
				>
					+ Log another
				</button>
				<!-- Time defaults to now (logs immediately). Set a future time to schedule
				     it for later today — it counts against remaining until confirmed. -->
				<div class="mt-2 flex items-center gap-2">
					<input
						type="time"
						bind:value={scheduleAt}
						class="rounded-2xl bg-white/10 px-3 py-4 text-sm text-white"
						aria-label="Log time"
					/>
					<button
						class="accent-gradient flex-1 rounded-2xl py-4 font-bold text-white disabled:opacity-50"
						disabled={logging || meal.length === 0}
						onclick={logMeal}
					>
						{#if logging}
							{isFuture ? 'Scheduling…' : 'Logging…'}
						{:else}
							{isFuture ? 'Schedule' : 'Log'}
							{meal.length} item{meal.length === 1 ? '' : 's'}
							{isFuture ? 'for later' : ''}
						{/if}
					</button>
				</div>
			</div>
		{:else if mode === 'barcode'}
			<div class="p-5" style="padding-bottom: calc(1.25rem + env(safe-area-inset-bottom));">
				<div class="mx-auto mb-4 h-1 w-12 rounded-full bg-white/20"></div>
				<BarcodeScan
					onback={() => (mode = 'browse')}
					mealCount={meal.length}
					onadd={(item) => {
						meal.push(item);
						mealError = null;
						mode = 'review';
					}}
				/>
			</div>
		{:else if mode === 'ai'}
			<div class="p-5" style="padding-bottom: calc(1.25rem + env(safe-area-inset-bottom));">
				<div class="mx-auto mb-4 h-1 w-12 rounded-full bg-white/20"></div>
				<AiDescribe
					onback={() => (mode = 'browse')}
					mealCount={meal.length}
					onadd={(item) => {
						meal.push(item);
						mealError = null;
						mode = 'review';
					}}
				/>
			</div>
		{/if}
	</div>
{/if}
