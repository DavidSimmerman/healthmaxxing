<script lang="ts">
	import BarcodeScan from './BarcodeScan.svelte';
	import LabelCapture from './LabelCapture.svelte';
	import PasteCapture from './PasteCapture.svelte';
	import ManualEntry from './ManualEntry.svelte';

	type Mode = 'menu' | 'barcode' | 'label' | 'paste' | 'manual';

	let { open = $bindable(false) }: { open: boolean } = $props();
	let mode = $state<Mode>('menu');

	function close() {
		open = false;
		// reset after the sheet animates out
		setTimeout(() => (mode = 'menu'), 200);
	}

	function reload() {
		close();
		location.reload();
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
		class="fixed right-0 bottom-0 left-0 z-50 rounded-t-3xl border-t p-5"
		style="background: var(--color-bg-elevated); border-color: var(--color-border); padding-bottom: calc(1.25rem + env(safe-area-inset-bottom));"
	>
		<div class="mx-auto mb-4 h-1 w-12 rounded-full bg-white/20"></div>

		{#if mode === 'menu'}
			<h2 class="mb-4 text-center text-lg font-bold text-white">Add food</h2>
			<div class="grid grid-cols-2 gap-3">
				<button
					class="card-sm flex flex-col items-center gap-2 p-5 transition active:scale-95"
					onclick={() => (mode = 'barcode')}
				>
					<svg
						class="h-7 w-7 text-white"
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
					<span class="text-sm font-semibold text-white">Barcode</span>
				</button>

				<button
					class="card-sm flex flex-col items-center gap-2 p-5 transition active:scale-95"
					onclick={() => (mode = 'label')}
				>
					<svg
						class="h-7 w-7 text-white"
						fill="none"
						stroke="currentColor"
						stroke-width="1.8"
						viewBox="0 0 24 24"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							d="M3 16V8a2 2 0 012-2h3l2-2h4l2 2h3a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"
						/>
						<circle cx="12" cy="13" r="3.5" stroke-width="1.8" />
					</svg>
					<span class="text-sm font-semibold text-white">Label photo</span>
				</button>

				<button
					class="card-sm flex flex-col items-center gap-2 p-5 transition active:scale-95"
					onclick={() => (mode = 'paste')}
				>
					<svg
						class="h-7 w-7 text-white"
						fill="none"
						stroke="currentColor"
						stroke-width="1.8"
						viewBox="0 0 24 24"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							d="M9 5h6a2 2 0 012 2v0H7v0a2 2 0 012-2zM5 7h14v12a2 2 0 01-2 2H7a2 2 0 01-2-2V7z"
						/>
						<path stroke-linecap="round" d="M9 12h6M9 16h4" />
					</svg>
					<span class="text-sm font-semibold text-white">Paste / describe</span>
				</button>

				<button
					class="card-sm flex flex-col items-center gap-2 p-5 transition active:scale-95"
					onclick={() => (mode = 'manual')}
				>
					<svg
						class="h-7 w-7 text-white"
						fill="none"
						stroke="currentColor"
						stroke-width="1.8"
						viewBox="0 0 24 24"
					>
						<path
							stroke-linecap="round"
							d="M11 4H5a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2v-6m-1.5-9.5l3 3L11 18H8v-3l9.5-9.5z"
						/>
					</svg>
					<span class="text-sm font-semibold text-white">Manual entry</span>
				</button>
			</div>

			<button
				class="mt-4 w-full py-3 text-sm"
				style="color: var(--color-text-subtle);"
				onclick={close}
			>
				Cancel
			</button>
		{:else if mode === 'barcode'}
			<BarcodeScan onback={() => (mode = 'menu')} onlogged={reload} />
		{:else if mode === 'label'}
			<LabelCapture onback={() => (mode = 'menu')} oncaptured={reload} />
		{:else if mode === 'paste'}
			<PasteCapture onback={() => (mode = 'menu')} oncaptured={reload} />
		{:else if mode === 'manual'}
			<ManualEntry onback={() => (mode = 'menu')} onlogged={reload} />
		{/if}
	</div>
{/if}
