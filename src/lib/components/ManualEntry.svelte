<script lang="ts">
	type Props = { onback: () => void; onlogged: () => void };
	let { onback, onlogged }: Props = $props();

	let name = $state('');
	let servingSize = $state('');
	let calories = $state<number | null>(null);
	let proteinG = $state<number | null>(null);
	let carbsG = $state<number | null>(null);
	let fatG = $state<number | null>(null);
	let pinToQuickAdds = $state(false);
	let busy = $state(false);

	let valid = $derived(
		name.trim().length > 0 &&
			calories !== null &&
			proteinG !== null &&
			carbsG !== null &&
			fatG !== null
	);

	async function submit() {
		if (!valid) return;
		busy = true;
		const res = await fetch('/api/manual', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name,
				servingSize: servingSize || null,
				calories,
				proteinG,
				carbsG,
				fatG,
				pinToQuickAdds,
				logToday: true
			})
		});
		if (res.ok) onlogged();
		else busy = false;
	}
</script>

<div class="flex items-center justify-between">
	<button class="text-sm" style="color: var(--color-text-subtle);" onclick={onback}>← Back</button>
	<h2 class="font-semibold text-white">Manual entry</h2>
	<div class="w-12"></div>
</div>

<div class="mt-4 space-y-3">
	<input
		bind:value={name}
		placeholder="Food name"
		class="card-sm w-full bg-transparent px-4 py-3 text-white outline-none placeholder:text-zinc-500"
	/>
	<input
		bind:value={servingSize}
		placeholder="Serving size (optional)"
		class="card-sm w-full bg-transparent px-4 py-3 text-white outline-none placeholder:text-zinc-500"
	/>
	<div class="grid grid-cols-2 gap-3">
		<input
			bind:value={calories}
			type="number"
			placeholder="Calories"
			inputmode="numeric"
			class="card-sm w-full bg-transparent px-4 py-3 text-white outline-none placeholder:text-zinc-500"
		/>
		<input
			bind:value={proteinG}
			type="number"
			placeholder="Protein (g)"
			inputmode="numeric"
			class="card-sm w-full bg-transparent px-4 py-3 text-white outline-none placeholder:text-zinc-500"
		/>
		<input
			bind:value={carbsG}
			type="number"
			placeholder="Carbs (g)"
			inputmode="numeric"
			class="card-sm w-full bg-transparent px-4 py-3 text-white outline-none placeholder:text-zinc-500"
		/>
		<input
			bind:value={fatG}
			type="number"
			placeholder="Fat (g)"
			inputmode="numeric"
			class="card-sm w-full bg-transparent px-4 py-3 text-white outline-none placeholder:text-zinc-500"
		/>
	</div>
	<label class="card-sm flex w-full cursor-pointer items-center justify-between p-3">
		<span class="text-sm text-white">Pin to quick adds</span>
		<input type="checkbox" bind:checked={pinToQuickAdds} class="h-5 w-5" />
	</label>
</div>

<button
	class="accent-gradient mt-4 w-full rounded-2xl py-4 font-bold text-white disabled:opacity-50"
	disabled={!valid || busy}
	onclick={submit}
>
	{busy ? 'Saving…' : 'Log to today'}
</button>
