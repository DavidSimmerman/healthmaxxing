<script lang="ts">
	type Props = { onback: () => void; oncaptured: () => void };
	let { onback, oncaptured }: Props = $props();

	let fileInput: HTMLInputElement;
	let busy = $state(false);
	let caption = $state('');
	let preview = $state<string | null>(null);
	let file: File | null = null;

	function onPick(e: Event) {
		const f = (e.target as HTMLInputElement).files?.[0];
		if (!f) return;
		file = f;
		preview = URL.createObjectURL(f);
	}

	async function submit() {
		if (!file) return;
		busy = true;
		const fd = new FormData();
		fd.append('image', file);
		fd.append('caption', caption);
		fd.append('kind', 'label_photo');
		const res = await fetch('/api/pending', { method: 'POST', body: fd });
		if (res.ok) oncaptured();
		else busy = false;
	}
</script>

<div class="flex items-center justify-between">
	<button class="text-sm" style="color: var(--color-text-subtle);" onclick={onback}>← Back</button>
	<h2 class="font-semibold text-white">Label photo</h2>
	<div class="w-12"></div>
</div>

<input
	bind:this={fileInput}
	type="file"
	accept="image/*"
	capture="environment"
	class="hidden"
	onchange={onPick}
/>

{#if !preview}
	<button
		class="card-sm mt-4 flex w-full flex-col items-center gap-3 p-10 transition active:scale-95"
		onclick={() => fileInput.click()}
	>
		<svg
			class="h-12 w-12 text-white"
			fill="none"
			stroke="currentColor"
			stroke-width="1.5"
			viewBox="0 0 24 24"
		>
			<path
				stroke-linecap="round"
				stroke-linejoin="round"
				d="M3 16V8a2 2 0 012-2h3l2-2h4l2 2h3a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"
			/>
			<circle cx="12" cy="13" r="3.5" />
		</svg>
		<span class="text-sm font-semibold text-white">Take a photo</span>
		<span class="text-xs" style="color: var(--color-text-subtle);">
			Of the nutrition facts panel
		</span>
	</button>
{:else}
	<img src={preview} alt="Captured label" class="mt-4 w-full rounded-2xl" />
	<input
		bind:value={caption}
		placeholder="Optional note (e.g. 'Publix bakery rolls, ate 2')"
		class="card-sm mt-3 w-full bg-transparent px-4 py-3 text-white outline-none placeholder:text-zinc-500"
	/>
	<div class="mt-3 flex gap-2">
		<button
			class="card-sm flex-1 py-3 text-white"
			onclick={() => {
				preview = null;
				file = null;
			}}
		>
			Retake
		</button>
		<button
			class="accent-gradient flex-1 rounded-2xl py-3 font-bold text-white disabled:opacity-60"
			disabled={busy}
			onclick={submit}
		>
			{busy ? 'Saving…' : 'Save as pending'}
		</button>
	</div>
	<p class="mt-3 text-center text-xs" style="color: var(--color-text-subtle);">
		Claude Code will OCR this when you run <code>/process-health</code>.
	</p>
{/if}
