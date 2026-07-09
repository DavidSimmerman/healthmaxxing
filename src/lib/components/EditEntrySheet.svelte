<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { UNITS, UNIT_LABEL, toServings, type Unit } from '$lib/units';

	type Entry = {
		id: string;
		foodId: string;
		servings: number;
		amount: number | null;
		unit: string | null;
		loggedAt: string | Date;
		foodName: string;
		foodServingSize: string | null;
		foodServingGrams: number | null;
		foodCalories: number;
		foodProteinG: number;
		foodCarbsG: number;
		foodFatG: number;
	};

	type Props = { entry: Entry | null; onclose: () => void; onsaved: () => void };
	let { entry, onclose, onsaved }: Props = $props();
	let sheetEl = $state<HTMLElement | undefined>(undefined);

	// Initial state derived from entry
	let unit = $state<Unit>('serving');
	let amount = $state<number>(1);
	let time = $state(''); // HH:MM of loggedAt, editable
	let saving = $state(false);
	let deleting = $state(false);

	// Editable title. Track the name locally so a rename shows immediately without
	// reloading; the underlying food row is what actually gets patched.
	let name = $state('');
	let editingName = $state(false);
	let nameDraft = $state('');
	let savingName = $state(false);

	// Initialize the amount/unit when a different entry opens. Reads only the
	// serving fields so a rename (which touches name state) can't reset them.
	$effect(() => {
		if (!entry) return;
		// Use the stored amount/unit, but only if that unit is still valid — a food
		// can lose its serving weight (e.g. after a barcode source sync), which would
		// make a stored gram/volume unit unconvertible. Fall back to servings then.
		if (entry.amount != null && entry.unit && isAvail(entry.unit as Unit)) {
			unit = entry.unit as Unit;
			amount = entry.amount;
		} else {
			unit = 'serving';
			amount = entry.servings;
		}
		const d = new Date(entry.loggedAt);
		time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
		sheetEl?.focus(); // initial focus into the dialog (container — no keyboard pop)
	});

	// Seed the editable name from the entry, keyed on entry identity.
	$effect(() => {
		if (!entry) return;
		name = entry.foodName;
		editingName = false;
	});

	let hasGrams = $derived(!!entry?.foodServingGrams && entry.foodServingGrams > 0);
	let servingsPreview = $derived(
		entry ? toServings(Number(amount) || 0, unit, entry.foodServingGrams) : 0
	);
	let kcal = $derived(entry ? entry.foodCalories * servingsPreview : 0);
	let p = $derived(entry ? entry.foodProteinG * servingsPreview : 0);
	let c = $derived(entry ? entry.foodCarbsG * servingsPreview : 0);
	let f = $derived(entry ? entry.foodFatG * servingsPreview : 0);

	async function save() {
		if (!entry) return;
		saving = true;
		// Keep the entry's original date; only apply the edited H:M.
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local: built, mutated, serialized to ISO in one call
		const when = new Date(entry.loggedAt);
		if (time) {
			const [h, m] = time.split(':').map(Number);
			when.setHours(h, m, 0, 0);
		}
		const res = await fetch(`/api/log/${entry.id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ amount: Number(amount), unit, loggedAt: when.toISOString() })
		});
		if (res.ok) onsaved();
		else {
			saving = false;
			alert('Failed to save');
		}
	}

	function startEditName() {
		if (!entry) return;
		nameDraft = name;
		editingName = true;
	}

	async function saveName() {
		// Capture the open entry before awaiting: the user may close the sheet or
		// switch entries mid-request, which would otherwise null/repoint `entry`.
		const target = entry;
		const foodId = target?.foodId;
		if (!foodId) return;
		const next = nameDraft.trim();
		if (!next || next === name) {
			editingName = false;
			return;
		}
		savingName = true;
		try {
			const res = await fetch(`/api/foods/${foodId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: next })
			});
			// Only touch the UI if the same entry is still open. We deliberately do
			// not mutate `entry.foodName` — that proxied prop feeds the init effect,
			// so writing it would reset any unsaved amount/unit edits.
			if (entry !== target) return;
			if (res.ok) {
				name = next;
				editingName = false;
				// Refresh page data so the list + quick-add tiles pick up the new name.
				// `entry` keeps its identity, so the open sheet's amount/unit don't reset.
				await invalidateAll();
			} else {
				alert('Failed to rename');
			}
		} finally {
			savingName = false;
		}
	}

	async function remove() {
		if (!entry) return;
		if (!confirm(`Remove "${entry.foodName}"?`)) return;
		deleting = true;
		const res = await fetch(`/api/log/${entry.id}`, { method: 'DELETE' });
		if (res.ok) onsaved();
		else {
			deleting = false;
			alert('Failed to remove');
		}
	}

	function isAvail(u: Unit): boolean {
		// Volume + gram units need food.servingGrams to convert sensibly.
		if (u === 'serving') return true;
		return hasGrams;
	}

	// Step size by unit — fine increments for fractional servings, coarser for grams.
	function step(): number {
		switch (unit) {
			case 'serving':
				return 0.25;
			case 'gram':
				return 5;
			case 'cup':
				return 0.25;
			case 'tbsp':
			case 'tsp':
				return 1;
		}
	}
</script>

<!-- Escape closes from anywhere while open (the backdrop is never focused, so a
     handler there would be dead code). Inner inputs stopPropagation their own Escape. -->
<svelte:window
	onkeydown={(e) => {
		if (entry && e.key === 'Escape') onclose();
	}}
/>

{#if entry}
	<div
		class="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
		onclick={onclose}
		aria-hidden="true"
	></div>

	<div
		bind:this={sheetEl}
		role="dialog"
		aria-modal="true"
		aria-label="Edit logged food"
		tabindex="-1"
		class="fixed right-0 bottom-0 left-0 z-50 rounded-t-3xl border-t p-5 outline-none"
		style="background: var(--color-bg-elevated); border-color: var(--color-border); padding-bottom: calc(1.25rem + env(safe-area-inset-bottom));"
	>
		<div class="mx-auto mb-4 h-1 w-12 rounded-full bg-white/20"></div>

		<div class="mb-1 text-center">
			{#if editingName}
				<input
					bind:value={nameDraft}
					autocomplete="off"
					aria-label="Food name"
					class="w-full rounded-lg bg-white/5 px-3 py-2 text-center text-lg font-bold text-white outline-none focus:bg-white/10"
					onkeydown={(e) => {
						if (e.key === 'Enter') saveName();
						if (e.key === 'Escape') {
							e.stopPropagation(); // cancel the edit only — window Escape closes the sheet
							editingName = false;
						}
					}}
				/>
				<div class="mt-2 flex justify-center gap-2">
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
				<button
					type="button"
					class="mx-auto flex items-center gap-1.5 rounded-lg px-2 py-1 transition hover:bg-white/5"
					onclick={startEditName}
					aria-label="Edit name"
				>
					<h2 class="text-lg font-bold text-white">{name}</h2>
					<svg
						class="h-3.5 w-3.5 shrink-0 text-zinc-500"
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
			{/if}
			{#if entry.foodServingSize && !editingName}
				<p class="text-xs" style="color: var(--color-text-subtle);">
					Base serving: {entry.foodServingSize}
				</p>
			{/if}
		</div>

		<!-- Unit picker -->
		<div class="no-scrollbar mt-4 flex gap-1 overflow-x-auto rounded-full bg-white/5 p-1">
			{#each UNITS as u (u)}
				{@const enabled = isAvail(u)}
				<button
					type="button"
					disabled={!enabled}
					onclick={() => (unit = u)}
					class="shrink-0 rounded-full px-4 py-2 text-sm font-semibold transition"
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
				Set "serving grams" on this food to enable g / cup / tbsp / tsp.
			</p>
		{/if}

		<!-- Amount + stepper -->
		<div class="mt-4 flex items-center justify-center gap-3">
			<button
				class="card-sm flex h-12 w-12 items-center justify-center text-2xl"
				onclick={() => (amount = Math.max(0, Number((amount - step()).toFixed(2))))}
				type="button">−</button
			>
			<input
				bind:value={amount}
				type="number"
				step={step()}
				min="0"
				inputmode="decimal"
				class="card-sm w-32 bg-transparent py-3 text-center text-2xl font-bold text-white outline-none"
			/>
			<button
				class="card-sm flex h-12 w-12 items-center justify-center text-2xl"
				onclick={() => (amount = Number((Number(amount) + step()).toFixed(2)))}
				type="button">+</button
			>
		</div>
		<p class="mt-1 text-center text-xs" style="color: var(--color-text-subtle);">
			{UNIT_LABEL[unit]}
		</p>

		<!-- Preview -->
		<div class="card-sm mt-4 grid grid-cols-4 gap-2 p-4 text-center">
			<div>
				<div class="text-lg font-bold text-white">{Math.round(kcal)}</div>
				<div class="text-xs" style="color: var(--color-text-subtle);">kcal</div>
			</div>
			<div>
				<div class="text-lg font-bold" style="color: var(--color-protein);">
					{Math.round(p)}
				</div>
				<div class="text-xs" style="color: var(--color-text-subtle);">protein</div>
			</div>
			<div>
				<div class="text-lg font-bold" style="color: var(--color-carbs);">
					{Math.round(c)}
				</div>
				<div class="text-xs" style="color: var(--color-text-subtle);">carbs</div>
			</div>
			<div>
				<div class="text-lg font-bold" style="color: var(--color-fat);">
					{Math.round(f)}
				</div>
				<div class="text-xs" style="color: var(--color-text-subtle);">fat</div>
			</div>
		</div>

		<!-- Logged-at time (editable) -->
		<div class="mt-4 flex items-center justify-between">
			<span class="text-sm" style="color: var(--color-text-subtle);">Time</span>
			<input
				type="time"
				bind:value={time}
				class="rounded-xl bg-white/10 px-3 py-2 text-sm text-white"
				aria-label="Logged time"
			/>
		</div>

		<div class="mt-4 flex gap-2">
			<button
				class="card-sm flex-1 py-4 text-rose-400 transition active:scale-95 disabled:opacity-50"
				disabled={deleting}
				onclick={remove}
			>
				Remove
			</button>
			<button
				class="accent-gradient flex-1 rounded-2xl py-4 font-bold text-white disabled:opacity-50"
				disabled={saving || amount <= 0}
				onclick={save}
			>
				{saving ? 'Saving…' : 'Save'}
			</button>
		</div>
	</div>
{/if}
