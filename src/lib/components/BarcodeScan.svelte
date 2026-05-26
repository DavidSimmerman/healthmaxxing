<script lang="ts">
	import { onMount, onDestroy } from 'svelte';

	type Props = { onback: () => void; onlogged: () => void };
	let { onback, onlogged }: Props = $props();

	let scanner: any = null;
	let status = $state<'scanning' | 'looking_up' | 'found' | 'pending_created' | 'error'>(
		'scanning'
	);
	let message = $state('');
	let result = $state<any>(null);
	let scannedCode = $state('');
	let servings = $state(1);

	onMount(async () => {
		const { Html5Qrcode, Html5QrcodeSupportedFormats } = await import('html5-qrcode');
		scanner = new Html5Qrcode('qr-reader', {
			formatsToSupport: [
				Html5QrcodeSupportedFormats.EAN_13,
				Html5QrcodeSupportedFormats.EAN_8,
				Html5QrcodeSupportedFormats.UPC_A,
				Html5QrcodeSupportedFormats.UPC_E,
				Html5QrcodeSupportedFormats.CODE_128
			],
			useBarCodeDetectorIfSupported: true,
			verbose: false
		});

		try {
			await scanner.start(
				{ facingMode: 'environment' },
				{ fps: 10, qrbox: { width: 280, height: 140 }, aspectRatio: 1.333 },
				async (decoded: string) => {
					if (status !== 'scanning') return;
					scannedCode = decoded;
					await scanner.stop();
					await lookup(decoded);
				},
				() => {}
			);
		} catch (e: any) {
			status = 'error';
			message = e.message || 'Camera unavailable';
		}
	});

	onDestroy(async () => {
		try {
			if (scanner && scanner.isScanning) await scanner.stop();
		} catch {}
	});

	async function lookup(code: string) {
		status = 'looking_up';
		const res = await fetch(`/api/barcode/${code}`);
		const body = await res.json();
		if (body.food) {
			result = body.food;
			status = 'found';
		} else {
			status = 'pending_created';
			message = body.message ?? 'Saved as pending for Claude Code to resolve.';
		}
	}

	async function logIt() {
		await fetch('/api/log', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ foodId: result.id, servings })
		});
		onlogged();
	}
</script>

<div class="flex items-center justify-between">
	<button class="text-sm" style="color: var(--color-text-subtle);" onclick={onback}>← Back</button>
	<h2 class="font-semibold text-white">Scan barcode</h2>
	<div class="w-12"></div>
</div>

{#if status === 'scanning'}
	<div id="qr-reader" class="mt-4 overflow-hidden rounded-2xl"></div>
	<p class="mt-3 text-center text-sm" style="color: var(--color-text-subtle);">
		Point camera at the barcode
	</p>
{:else if status === 'looking_up'}
	<div class="card-sm mt-4 p-6 text-center">
		<p class="text-white">Looking up <span class="font-mono">{scannedCode}</span>…</p>
	</div>
{:else if status === 'found' && result}
	<div class="card-sm mt-4 p-5">
		<p class="text-xs tracking-wider uppercase" style="color: #34d399;">● Found</p>
		<h3 class="mt-1 text-xl font-bold text-white">{result.name}</h3>
		{#if result.brand}
			<p class="text-sm" style="color: var(--color-text-subtle);">{result.brand}</p>
		{/if}
		<div class="mt-4 grid grid-cols-4 gap-2 text-center">
			<div>
				<div class="text-lg font-bold text-white">{Math.round(result.calories)}</div>
				<div class="text-xs" style="color: var(--color-text-subtle);">kcal</div>
			</div>
			<div>
				<div class="text-lg font-bold" style="color: var(--color-protein);">
					{Math.round(result.proteinG)}
				</div>
				<div class="text-xs" style="color: var(--color-text-subtle);">protein</div>
			</div>
			<div>
				<div class="text-lg font-bold" style="color: var(--color-carbs);">
					{Math.round(result.carbsG)}
				</div>
				<div class="text-xs" style="color: var(--color-text-subtle);">carbs</div>
			</div>
			<div>
				<div class="text-lg font-bold" style="color: var(--color-fat);">
					{Math.round(result.fatG)}
				</div>
				<div class="text-xs" style="color: var(--color-text-subtle);">fat</div>
			</div>
		</div>

		<div class="mt-4 flex items-center justify-between">
			<span class="text-sm" style="color: var(--color-text-subtle);">Servings</span>
			<div class="flex items-center gap-3">
				<button
					class="card-sm flex h-9 w-9 items-center justify-center text-lg"
					onclick={() => (servings = Math.max(0.25, servings - 0.5))}>−</button
				>
				<span class="w-10 text-center font-bold text-white">{servings}</span>
				<button
					class="card-sm flex h-9 w-9 items-center justify-center text-lg"
					onclick={() => (servings += 0.5)}>+</button
				>
			</div>
		</div>
	</div>
	<button class="accent-gradient mt-4 w-full rounded-2xl py-4 font-bold text-white" onclick={logIt}>
		Log to today
	</button>
{:else if status === 'pending_created'}
	<div class="card-sm mt-4 p-5 text-center">
		<p class="text-xs tracking-wider uppercase" style="color: #fdba74;">● Saved as pending</p>
		<p class="mt-2 text-white">Barcode {scannedCode} wasn't in Open Food Facts.</p>
		<p class="mt-2 text-sm" style="color: var(--color-text-subtle);">{message}</p>
		<p class="mt-3 text-sm" style="color: var(--color-text-subtle);">
			Run <code>/process-health</code> in Claude Code later to resolve.
		</p>
	</div>
	<button class="card-sm mt-4 w-full py-3 text-white" onclick={onlogged}>Done</button>
{:else if status === 'error'}
	<div class="card-sm mt-4 p-5 text-center">
		<p class="text-rose-400">{message}</p>
	</div>
{/if}
