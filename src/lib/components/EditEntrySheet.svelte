<script lang="ts">
	import { UNITS, UNIT_LABEL, toServings, type Unit } from '$lib/units';

	type Entry = {
		id: string;
		servings: number;
		amount: number | null;
		unit: string | null;
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

	// Initial state derived from entry
	let unit = $state<Unit>('serving');
	let amount = $state<number>(1);
	let saving = $state(false);
	let deleting = $state(false);

	$effect(() => {
		if (!entry) return;
		if (entry.amount != null && entry.unit) {
			unit = entry.unit as Unit;
			amount = entry.amount;
		} else {
			unit = 'serving';
			amount = entry.servings;
		}
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
		const res = await fetch(`/api/log/${entry.id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ amount: Number(amount), unit })
		});
		if (res.ok) onsaved();
		else {
			saving = false;
			alert('Failed to save');
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

{#if entry}
	<div
		class="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
		onclick={onclose}
		role="button"
		tabindex="-1"
		aria-label="Close"
		onkeydown={(e) => e.key === 'Escape' && onclose()}
	></div>

	<div
		class="fixed right-0 bottom-0 left-0 z-50 rounded-t-3xl border-t p-5"
		style="background: var(--color-bg-elevated); border-color: var(--color-border); padding-bottom: calc(1.25rem + env(safe-area-inset-bottom));"
	>
		<div class="mx-auto mb-4 h-1 w-12 rounded-full bg-white/20"></div>

		<div class="mb-1 text-center">
			<h2 class="text-lg font-bold text-white">{entry.foodName}</h2>
			{#if entry.foodServingSize}
				<p class="text-xs" style="color: var(--color-text-subtle);">
					Base serving: {entry.foodServingSize}
				</p>
			{/if}
		</div>

		<!-- Unit picker -->
		<div class="no-scrollbar mt-4 flex gap-1 overflow-x-auto rounded-full bg-white/5 p-1">
			{#each UNITS as u}
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
