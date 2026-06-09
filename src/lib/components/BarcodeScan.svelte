<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { UNITS, UNIT_LABEL, toServings, type Unit } from '$lib/units';

	type Props = { onback: () => void; onlogged: () => void };
	let { onback, onlogged }: Props = $props();

	let liveScanner: any = null;
	let status = $state<
		'scanning' | 'decoding_file' | 'looking_up' | 'found' | 'not_found' | 'error'
	>('scanning');
	let message = $state('');
	let result = $state<any>(null);
	let scannedCode = $state('');
	// Amount to log from the "found" card, in `unit` (grams/volume convert via servingGrams).
	let unit = $state<Unit>('serving');
	let amount = $state(1);
	let manualCode = $state('');
	let fileInput: HTMLInputElement;

	// Inline-resolve form (shown when OFF misses)
	let resolveName = $state('');
	let resolveBrand = $state('');
	let resolveServingSize = $state('');
	let resolveServingGrams = $state<number | null>(null);
	let resolveCalories = $state<number | null>(null);
	let resolveProtein = $state<number | null>(null);
	let resolveCarbs = $state<number | null>(null);
	let resolveFat = $state<number | null>(null);
	let resolveBusy = $state(false);

	async function initLiveScan() {
		const { Html5Qrcode, Html5QrcodeSupportedFormats } = await import('html5-qrcode');
		liveScanner = new Html5Qrcode('qr-reader', {
			formatsToSupport: [
				Html5QrcodeSupportedFormats.EAN_13,
				Html5QrcodeSupportedFormats.EAN_8,
				Html5QrcodeSupportedFormats.UPC_A,
				Html5QrcodeSupportedFormats.UPC_E,
				Html5QrcodeSupportedFormats.CODE_128,
				Html5QrcodeSupportedFormats.CODE_39
			],
			useBarCodeDetectorIfSupported: true,
			verbose: false
		});

		try {
			await liveScanner.start(
				{ facingMode: 'environment' },
				{ fps: 15, qrbox: { width: 320, height: 180 }, aspectRatio: 1.333, disableFlip: false },
				async (decoded: string) => {
					if (status !== 'scanning') return;
					scannedCode = decoded;
					try {
						await liveScanner.stop();
					} catch {
						/* noop */
					}
					await lookup(decoded);
				},
				() => {
					/* per-frame error — ignore */
				}
			);
		} catch (e: any) {
			status = 'error';
			message =
				e?.message ||
				'Camera unavailable. Try uploading a photo of the barcode or typing the code.';
		}
	}

	onMount(initLiveScan);

	onDestroy(async () => {
		try {
			if (liveScanner && liveScanner.isScanning) await liveScanner.stop();
		} catch {
			/* noop */
		}
	});

	async function onPickFile(e: Event) {
		const file = (e.target as HTMLInputElement).files?.[0];
		if (!file) return;

		// stop the live camera so it can release its hold on the #qr-reader element
		try {
			if (liveScanner && liveScanner.isScanning) await liveScanner.stop();
		} catch {
			/* noop */
		}

		status = 'decoding_file';

		// zxing-wasm is much better at finding barcodes inside larger images
		// (full product photos, cluttered backgrounds, rotated/skewed codes).
		// We pass `tryHarder + tryRotate + tryInvert + tryDownscale` so it'll
		// scan multiple scales/orientations rather than only the full frame.
		try {
			const { readBarcodes, prepareZXingModule } = await import('zxing-wasm/reader');
			await prepareZXingModule({
				overrides: {
					locateFile: (path: string, prefix: string) => {
						if (path.endsWith('.wasm')) {
							return new URL('zxing-wasm/reader/zxing_reader.wasm', import.meta.url).href;
						}
						return prefix + path;
					}
				},
				fireImmediately: true
			});
			const results = await readBarcodes(file, {
				formats: ['EAN-13', 'EAN-8', 'UPC-A', 'UPC-E', 'Code128', 'Code39', 'ITF'],
				tryHarder: true,
				tryRotate: true,
				tryInvert: true,
				tryDownscale: true,
				maxNumberOfSymbols: 1
			});
			const hit = results.find((r) => r.isValid && r.text);
			if (!hit) throw new Error('no barcode detected');
			scannedCode = hit.text;
			await lookup(hit.text);
		} catch (e: any) {
			status = 'error';
			message =
				(typeof e === 'string' ? e : (e?.message ?? '')) ||
				"Couldn't decode that image. Try a closer/sharper photo or type the code below.";
		}
	}

	async function submitManualCode(ev?: Event) {
		ev?.preventDefault();
		const code = manualCode.trim();
		if (!/^\d{6,14}$/.test(code)) {
			message = 'Enter a 6–14 digit barcode';
			status = 'error';
			return;
		}
		try {
			if (liveScanner && liveScanner.isScanning) await liveScanner.stop();
		} catch {
			/* noop */
		}
		scannedCode = code;
		await lookup(code);
	}

	async function lookup(code: string) {
		status = 'looking_up';
		const res = await fetch(`/api/barcode/${code}`);
		const body = await res.json();
		if (body.food) {
			result = body.food;
			status = 'found';
		} else {
			status = 'not_found';
			message = body.message ?? '';
		}
	}

	let hasGrams = $derived(!!result?.servingGrams && result.servingGrams > 0);
	let servingsPreview = $derived(
		result ? toServings(Number(amount) || 0, unit, result.servingGrams) : 0
	);

	function unitAvail(u: Unit): boolean {
		return u === 'serving' || hasGrams;
	}

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

	async function logIt() {
		if (!(Number(amount) > 0)) return; // ignore cleared/NaN amount
		await fetch('/api/log', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ foodId: result.id, amount: Number(amount), unit })
		});
		onlogged();
	}

	let resolveValid = $derived(
		resolveName.trim().length > 0 &&
			resolveCalories !== null &&
			resolveProtein !== null &&
			resolveCarbs !== null &&
			resolveFat !== null
	);

	async function saveManual() {
		if (!resolveValid) return;
		resolveBusy = true;
		const res = await fetch(`/api/barcode/${scannedCode}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: resolveName,
				brand: resolveBrand || null,
				servingSize: resolveServingSize || null,
				servingGrams: resolveServingGrams,
				calories: resolveCalories,
				proteinG: resolveProtein,
				carbsG: resolveCarbs,
				fatG: resolveFat,
				source: 'manual'
			})
		});
		if (res.ok) onlogged();
		else {
			resolveBusy = false;
			message = 'Failed to save.';
		}
	}
</script>

<div class="flex items-center justify-between">
	<button class="text-sm" style="color: var(--color-text-subtle);" onclick={onback}>← Back</button>
	<h2 class="font-semibold text-white">Scan barcode</h2>
	<div class="w-12"></div>
</div>

<input bind:this={fileInput} type="file" accept="image/*" class="hidden" onchange={onPickFile} />

{#if status === 'scanning' || status === 'decoding_file'}
	<div id="qr-reader" class="mt-4 overflow-hidden rounded-2xl"></div>

	{#if status === 'decoding_file'}
		<p class="mt-3 text-center text-sm" style="color: var(--color-text-subtle);">Decoding image…</p>
	{:else}
		<p class="mt-3 text-center text-sm" style="color: var(--color-text-subtle);">
			Hold the barcode flat and fill the frame
		</p>
	{/if}

	<div class="mt-3 grid grid-cols-2 gap-2">
		<button
			type="button"
			class="card-sm py-3 text-sm font-semibold text-white transition active:scale-95"
			onclick={() => fileInput.click()}
		>
			Upload image
		</button>
		<button
			type="button"
			class="card-sm py-3 text-sm font-semibold text-white transition active:scale-95"
			onclick={() => {
				const code = prompt('Enter barcode digits');
				if (code) {
					manualCode = code;
					submitManualCode();
				}
			}}
		>
			Type code
		</button>
	</div>
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
				<div class="text-lg font-bold text-white">
					{Math.round(result.calories * servingsPreview)}
				</div>
				<div class="text-xs" style="color: var(--color-text-subtle);">kcal</div>
			</div>
			<div>
				<div class="text-lg font-bold" style="color: var(--color-protein);">
					{Math.round(result.proteinG * servingsPreview)}
				</div>
				<div class="text-xs" style="color: var(--color-text-subtle);">protein</div>
			</div>
			<div>
				<div class="text-lg font-bold" style="color: var(--color-carbs);">
					{Math.round(result.carbsG * servingsPreview)}
				</div>
				<div class="text-xs" style="color: var(--color-text-subtle);">carbs</div>
			</div>
			<div>
				<div class="text-lg font-bold" style="color: var(--color-fat);">
					{Math.round(result.fatG * servingsPreview)}
				</div>
				<div class="text-xs" style="color: var(--color-text-subtle);">fat</div>
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

		<div class="mt-3 flex items-center justify-center gap-3">
			<button
				class="card-sm flex h-10 w-10 items-center justify-center text-xl text-white"
				type="button"
				aria-label="Less"
				onclick={() => (amount = Math.max(0, Number((Number(amount) - step()).toFixed(2))))}
				>−</button
			>
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
				type="button"
				aria-label="More"
				onclick={() => (amount = Number((Number(amount) + step()).toFixed(2)))}>+</button
			>
		</div>
		<p class="mt-1 text-center text-xs" style="color: var(--color-text-subtle);">
			{UNIT_LABEL[unit]}{#if result.servingSize}
				· {result.servingSize}{/if}
		</p>
	</div>
	<button
		class="accent-gradient mt-4 w-full rounded-2xl py-4 font-bold text-white disabled:opacity-50"
		disabled={!(Number(amount) > 0)}
		onclick={logIt}
	>
		Log to today
	</button>
{:else if status === 'not_found'}
	<div class="card-sm mt-4 p-5">
		<p class="text-xs tracking-wider uppercase" style="color: #fdba74;">● Not in Open Food Facts</p>
		<p class="mt-2 text-sm text-white">
			Barcode <span class="font-mono">{scannedCode}</span> isn't in the database. Enter the macros from
			the label below — we'll save them under this barcode so next time it's instant. Or ask Claude to
			log it for you.
		</p>
	</div>

	<div class="mt-3 space-y-2">
		<input
			bind:value={resolveName}
			placeholder="Food name (required)"
			class="card-sm w-full bg-transparent px-4 py-3 text-white outline-none placeholder:text-zinc-500"
		/>
		<input
			bind:value={resolveBrand}
			placeholder="Brand (optional)"
			class="card-sm w-full bg-transparent px-4 py-3 text-white outline-none placeholder:text-zinc-500"
		/>
		<div class="grid grid-cols-2 gap-2">
			<input
				bind:value={resolveServingSize}
				placeholder="Serving (e.g. 1 cup)"
				class="card-sm w-full bg-transparent px-4 py-3 text-white outline-none placeholder:text-zinc-500"
			/>
			<input
				bind:value={resolveServingGrams}
				type="number"
				inputmode="numeric"
				placeholder="Grams per serving"
				class="card-sm w-full bg-transparent px-4 py-3 text-white outline-none placeholder:text-zinc-500"
			/>
		</div>
		<div class="grid grid-cols-2 gap-2">
			<input
				bind:value={resolveCalories}
				type="number"
				inputmode="numeric"
				placeholder="Calories"
				class="card-sm w-full bg-transparent px-4 py-3 text-white outline-none placeholder:text-zinc-500"
			/>
			<input
				bind:value={resolveProtein}
				type="number"
				inputmode="numeric"
				placeholder="Protein (g)"
				class="card-sm w-full bg-transparent px-4 py-3 text-white outline-none placeholder:text-zinc-500"
			/>
			<input
				bind:value={resolveCarbs}
				type="number"
				inputmode="numeric"
				placeholder="Carbs (g)"
				class="card-sm w-full bg-transparent px-4 py-3 text-white outline-none placeholder:text-zinc-500"
			/>
			<input
				bind:value={resolveFat}
				type="number"
				inputmode="numeric"
				placeholder="Fat (g)"
				class="card-sm w-full bg-transparent px-4 py-3 text-white outline-none placeholder:text-zinc-500"
			/>
		</div>
	</div>

	<button
		class="accent-gradient mt-3 w-full rounded-2xl py-4 font-bold text-white disabled:opacity-50"
		disabled={!resolveValid || resolveBusy}
		onclick={saveManual}
	>
		{resolveBusy ? 'Saving…' : 'Save & log to today'}
	</button>

	<button
		class="mt-2 w-full py-3 text-center text-sm"
		style="color: var(--color-text-subtle);"
		onclick={onback}
	>
		Cancel
	</button>
{:else if status === 'error'}
	<div class="card-sm mt-4 p-5 text-center">
		<p class="text-rose-400">{message}</p>
	</div>
	<div class="mt-3 grid grid-cols-2 gap-2">
		<button
			type="button"
			class="card-sm py-3 text-sm font-semibold text-white"
			onclick={() => fileInput.click()}
		>
			Upload image
		</button>
		<button
			type="button"
			class="card-sm py-3 text-sm font-semibold text-white"
			onclick={async () => {
				message = '';
				status = 'scanning';
				await Promise.resolve();
				await initLiveScan();
			}}
		>
			Try camera again
		</button>
	</div>

	<form class="mt-3" onsubmit={submitManualCode}>
		<label class="text-xs" style="color: var(--color-text-subtle);">Or type the code</label>
		<div class="mt-2 flex gap-2">
			<input
				bind:value={manualCode}
				inputmode="numeric"
				placeholder="e.g. 3017624010701"
				class="card-sm flex-1 bg-transparent px-3 py-3 font-mono text-white outline-none placeholder:text-zinc-500"
			/>
			<button class="accent-gradient rounded-2xl px-5 py-3 font-bold text-white">Look up</button>
		</div>
	</form>
{/if}
