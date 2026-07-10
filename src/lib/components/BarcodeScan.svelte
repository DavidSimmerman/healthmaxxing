<script lang="ts">
	import { onMount, onDestroy, tick } from 'svelte';
	import { UNITS, UNIT_LABEL, toServings, type Unit } from '$lib/units';
	import { loadReader, decodeBarcode, needsConfirmation } from '$lib/scanner';

	// Item staged into the current meal (mirrors CaptureSheet's MealItem) so a
	// scanned food can join a multi-item meal instead of logging straight away.
	type StagedItem = {
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
	type Props = {
		onback: () => void;
		onadd: (item: StagedItem) => void;
		mealCount: number;
	};
	let { onback, onadd, mealCount }: Props = $props();

	let stream: MediaStream | null = null;
	let video = $state<HTMLVideoElement | undefined>(undefined);
	// Generation token — bumping it cancels any in-flight scan loop, so a stale
	// loop can't fire a lookup after the camera was stopped or restarted.
	let scanGen = 0;
	let status = $state<
		'scanning' | 'decoding_file' | 'looking_up' | 'found' | 'not_found' | 'error'
	>('scanning');
	let message = $state('');
	let result = $state<any>(null);
	let scannedCode = $state('');
	// Set when the scan finds the source (Open Food Facts) now disagrees with our
	// saved override — { current: yours, incoming: source }. Drives the banner.
	let sourceUpdate = $state<{
		current: { calories: number; proteinG: number; carbsG: number; fatG: number };
		incoming: { calories: number; proteinG: number; carbsG: number; fatG: number };
		servingSize?: string | null;
	} | null>(null);
	let reconciling = $state(false);
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

	function stopCamera() {
		scanGen++;
		stream?.getTracks().forEach((t) => t.stop());
		stream = null;
	}

	async function initLiveScan() {
		const gen = ++scanGen;
		try {
			// Warm the wasm decoder while the camera permission prompt / open is
			// in flight — both are slow, so overlap them.
			const readerReady = loadReader();
			const media = await navigator.mediaDevices.getUserMedia({
				audio: false,
				video: {
					facingMode: { ideal: 'environment' },
					// High resolution so small / far-away barcodes still have enough
					// pixels per bar to decode (tryDownscale handles the cost).
					width: { ideal: 1920 },
					height: { ideal: 1080 }
				}
			});
			if (gen !== scanGen) {
				media.getTracks().forEach((t) => t.stop());
				return;
			}
			stream = media;

			// Continuous autofocus where supported (Android Chrome) — crinkled or
			// curved barcodes need the lens to keep refocusing.
			const track = media.getVideoTracks()[0];
			try {
				const caps = track.getCapabilities?.() as MediaTrackCapabilities & {
					focusMode?: string[];
				};
				if (caps?.focusMode?.includes('continuous')) {
					await track.applyConstraints({
						advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet]
					});
				}
			} catch {
				/* focus hint is best-effort */
			}

			await readerReady;
			if (gen !== scanGen) return;
			if (!video) {
				stopCamera();
				return;
			}
			video.srcObject = media;
			await video.play();
			void scanLoop(gen);
		} catch (e: any) {
			stopCamera(); // wasm load / play() can fail after the stream opened — don't leak it
			status = 'error';
			message =
				e?.message ||
				'Camera unavailable. Try uploading a photo of the barcode or typing the code.';
		}
	}

	// Decode full camera frames with zxing-wasm (tryHarder/tryRotate/tryInvert)
	// — works at any orientation and anywhere in the frame, unlike the old
	// box-cropped decoder that needed an upright, frame-filling barcode.
	async function scanLoop(gen: number) {
		const canvas = document.createElement('canvas');
		const ctx = canvas.getContext('2d', { willReadFrequently: true });
		if (!ctx) return;
		// Last read of a checksum-less format awaiting a confirming second read.
		let pending: string | null = null;
		let frame = 0;
		while (gen === scanGen && status === 'scanning' && video) {
			if (video.readyState >= video.HAVE_CURRENT_DATA && video.videoWidth > 0) {
				const vw = video.videoWidth;
				const vh = video.videoHeight;
				// zxing's 1D readers scan near-axis-aligned lines only (~±25°
				// tolerance around 0/90/180/270, the rest via tryRotate). Alternate
				// frames decode a 45°-pre-rotated copy, which shifts diagonal
				// barcodes back into that window — full 360° coverage.
				if (frame++ % 2 === 0) {
					canvas.width = vw;
					canvas.height = vh;
					ctx.drawImage(video, 0, 0);
				} else {
					const side = Math.ceil((vw + vh) / Math.SQRT2);
					canvas.width = side;
					canvas.height = side;
					ctx.fillStyle = '#fff';
					ctx.fillRect(0, 0, side, side);
					ctx.save();
					// Bicubic resampling keeps narrow bars legible through the rotation.
					ctx.imageSmoothingQuality = 'high';
					ctx.translate(side / 2, side / 2);
					ctx.rotate(Math.PI / 4);
					ctx.drawImage(video, -vw / 2, -vh / 2);
					ctx.restore();
				}
				let hit = null;
				try {
					hit = await decodeBarcode(ctx.getImageData(0, 0, canvas.width, canvas.height));
				} catch {
					/* per-frame decode failure — keep scanning */
				}
				if (gen !== scanGen || status !== 'scanning') return;
				if (hit) {
					if (!needsConfirmation(hit.format) || pending === hit.text) {
						stopCamera();
						scannedCode = hit.text;
						await lookup(hit.text);
						return;
					}
					pending = hit.text;
				}
			}
			// Brief yield between frames so the UI thread isn't saturated.
			await new Promise((r) => setTimeout(r, 50));
		}
	}

	onMount(initLiveScan);

	onDestroy(stopCamera);

	async function onPickFile(e: Event) {
		const file = (e.target as HTMLInputElement).files?.[0];
		if (!file) return;

		stopCamera();
		status = 'decoding_file';

		try {
			const hit = await decodeBarcode(file);
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
		stopCamera();
		scannedCode = code;
		await lookup(code);
	}

	async function lookup(code: string) {
		status = 'looking_up';
		sourceUpdate = null;
		try {
			const res = await fetch(`/api/barcode/${code}`);
			const body = await res.json();
			if (body.food) {
				result = body.food;
				sourceUpdate = body.sourceUpdate ?? null;
				status = 'found';
			} else {
				status = 'not_found';
				message = body.message ?? '';
			}
		} catch {
			// Live-scan path awaits this AFTER stopCamera() with no outer catch — a
			// network failure would strand 'looking_up' with a dead camera. Surface
			// the same error/retry UI the file-picker path shows.
			status = 'error';
			message = "Couldn't look up that barcode — check your connection and try again.";
		}
	}

	// Resolve a flagged source change. "update" trusts the new source (the server
	// drops the override and mirrors it going forward); "dismiss" keeps our value
	// and re-baselines so the same change won't alert again.
	async function reconcile(action: 'update' | 'dismiss') {
		reconciling = true;
		try {
			const res = await fetch(`/api/barcode/${scannedCode}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action })
			});
			if (res.ok) {
				if (action === 'update') {
					result = (await res.json()).food;
					// The new source value may have no serving weight; a stale g/cup/tbsp
					// selection would then log a gram amount as servings. Reset to serving.
					if (!(result.servingGrams && result.servingGrams > 0)) {
						unit = 'serving';
						amount = 1;
					}
				}
				sourceUpdate = null;
			}
		} finally {
			reconciling = false;
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

	// Stage the scanned food into the meal (the review screen shows the running
	// total, then one confirm logs them all) — the same flow as picking from
	// search/history, so several barcodes can go into a single meal.
	function addIt() {
		if (!result || !(Number(amount) > 0)) return; // ignore cleared/NaN amount
		const s = servingsPreview;
		onadd({
			foodId: result.id,
			name: result.name,
			amount: Number(amount),
			unit,
			servings: s,
			calories: result.calories * s,
			proteinG: result.proteinG * s,
			carbsG: result.carbsG * s,
			fatG: result.fatG * s,
			...bolus(result, s)
		});
	}

	// Bolusable for a staged item. SAFETY: if the derived figure is somehow absent,
	// fall back to TOTAL carbs (over-, never under-counting — the safe direction for
	// an insulin dose) and flag low-confidence; NEVER 0, which would under-dose.
	function bolus(food: any, servings: number) {
		const perServing = food.bolusableCarbsG ?? food.carbsG ?? 0;
		return {
			bolusableCarbsG: perServing * servings,
			bolusableLowConfidence:
				food.bolusableCarbsG == null ? true : (food.bolusableLowConfidence ?? false)
		};
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
		if (res.ok) {
			// Created (not logged) — stage it into the meal at one serving, same as the
			// found-barcode path, so an in-progress meal is never discarded.
			const food = (await res.json()).food;
			onadd({
				foodId: food.id,
				name: food.name,
				amount: 1,
				unit: 'serving',
				servings: 1,
				calories: food.calories,
				proteinG: food.proteinG,
				carbsG: food.carbsG,
				fatG: food.fatG,
				...bolus(food, 1)
			});
		} else {
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
	{#if status === 'scanning'}
		<div class="relative mt-4 overflow-hidden rounded-2xl bg-black" style="aspect-ratio: 3 / 4;">
			<video bind:this={video} autoplay playsinline muted class="h-full w-full object-cover"
			></video>
			<!-- Aiming guide only — the full frame is decoded, any angle works -->
			<div class="pointer-events-none absolute inset-0 flex items-center justify-center">
				<div class="h-2/5 w-4/5 rounded-2xl border-2 border-white/50"></div>
			</div>
		</div>
		<p class="mt-3 text-center text-sm" style="color: var(--color-text-subtle);">
			Point at the barcode — any angle works
		</p>
	{:else}
		<p class="mt-6 text-center text-sm" style="color: var(--color-text-subtle);">Decoding image…</p>
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

	{#if sourceUpdate}
		<div
			class="mt-4 rounded-2xl border p-4"
			style="border-color: rgba(251,146,60,0.45); background: rgba(251,146,60,0.08);"
		>
			<p class="text-xs font-semibold tracking-wider uppercase" style="color: #fdba74;">
				↻ Source updated
			</p>
			<p class="mt-1 text-sm text-white">
				Open Food Facts now lists different macros for this item. Your saved version is still being
				used — review the change below.
			</p>
			<div class="mt-3 grid grid-cols-2 gap-2 text-center">
				<div class="rounded-xl bg-white/5 p-3">
					<div class="text-xs" style="color: var(--color-text-subtle);">Yours (kept)</div>
					<div class="mt-1 font-bold text-white">
						{Math.round(sourceUpdate.current.calories)} kcal
					</div>
					<div class="text-xs" style="color: var(--color-text-subtle);">
						{Math.round(sourceUpdate.current.proteinG)}p · {Math.round(
							sourceUpdate.current.carbsG
						)}c · {Math.round(sourceUpdate.current.fatG)}f
					</div>
				</div>
				<div class="rounded-xl bg-white/5 p-3">
					<div class="text-xs" style="color: var(--color-text-subtle);">New (source)</div>
					<div class="mt-1 font-bold" style="color: #fdba74;">
						{Math.round(sourceUpdate.incoming.calories)} kcal
					</div>
					<div class="text-xs" style="color: var(--color-text-subtle);">
						{Math.round(sourceUpdate.incoming.proteinG)}p · {Math.round(
							sourceUpdate.incoming.carbsG
						)}c · {Math.round(sourceUpdate.incoming.fatG)}f
					</div>
				</div>
			</div>
			<div class="mt-3 flex gap-2">
				<button
					class="card-sm flex-1 py-2.5 text-sm font-semibold text-white transition active:scale-95 disabled:opacity-50"
					disabled={reconciling}
					onclick={() => reconcile('dismiss')}
				>
					Keep mine
				</button>
				<button
					class="accent-gradient flex-1 rounded-2xl py-2.5 text-sm font-bold text-white disabled:opacity-50"
					disabled={reconciling}
					onclick={() => reconcile('update')}
				>
					{reconciling ? '…' : 'Use new'}
				</button>
			</div>
		</div>
	{/if}

	<button
		class="accent-gradient mt-4 w-full rounded-2xl py-4 font-bold text-white disabled:opacity-50"
		disabled={!(Number(amount) > 0)}
		onclick={addIt}
	>
		{mealCount > 0 ? 'Add to meal' : 'Log to today'}
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
		{resolveBusy ? 'Saving…' : mealCount > 0 ? 'Save & add to meal' : 'Save & log to today'}
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
				await tick(); // let the <video> element mount before binding the stream
				await initLiveScan();
			}}
		>
			Try camera again
		</button>
	</div>

	<form class="mt-3" onsubmit={submitManualCode}>
		<label class="text-xs" style="color: var(--color-text-subtle);" for="manual-barcode"
			>Or type the code</label
		>
		<div class="mt-2 flex gap-2">
			<input
				id="manual-barcode"
				bind:value={manualCode}
				inputmode="numeric"
				placeholder="e.g. 3017624010701"
				class="card-sm flex-1 bg-transparent px-3 py-3 font-mono text-white outline-none placeholder:text-zinc-500"
			/>
			<button class="accent-gradient rounded-2xl px-5 py-3 font-bold text-white">Look up</button>
		</div>
	</form>
{/if}
