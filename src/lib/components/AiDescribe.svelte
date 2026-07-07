<script lang="ts">
	import { UNIT_LABEL, type Unit } from '$lib/units';

	// Mirrors BarcodeScan's staged-item contract so a described food joins the meal
	// the same way a scanned one does.
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
	type DescribedFood = {
		id: string;
		name: string;
		brand: string | null;
		servingSize: string | null;
		servingGrams: number | null;
		calories: number;
		proteinG: number;
		carbsG: number;
		fatG: number;
		bolusableCarbsG: number;
		bolusableLowConfidence: boolean;
		source: string;
	};

	let {
		onback,
		onadd
	}: { onback: () => void; onadd: (item: StagedItem) => void; mealCount: number } = $props();

	let text = $state('');
	let imageDataUrl = $state<string | null>(null);
	let busy = $state(false);
	let error = $state<string | null>(null);
	let food = $state<DescribedFood | null>(null);
	let servings = $state(1);

	const canIdentify = $derived(!busy && (text.trim().length > 0 || !!imageDataUrl));

	// Downscale to ~1568px (Claude's optimal vision edge) as JPEG. A raw phone photo
	// is multi-MB; the app's body limit (adapter-node default 512KB) would reject it,
	// and the smaller image is cheaper + faster to analyze with no readability loss.
	// `imageOrientation: 'from-image'` bakes in EXIF rotation so sideways shots read upright.
	async function downscale(file: File, maxDim = 1568): Promise<string> {
		const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
		const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
		const w = Math.round(bitmap.width * scale);
		const h = Math.round(bitmap.height * scale);
		const canvas = document.createElement('canvas');
		canvas.width = w;
		canvas.height = h;
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('canvas unavailable');
		ctx.drawImage(bitmap, 0, 0, w, h);
		bitmap.close();
		return canvas.toDataURL('image/jpeg', 0.82);
	}

	async function onPick(e: Event) {
		const file = (e.currentTarget as HTMLInputElement).files?.[0];
		if (!file) return;
		if (!file.type.startsWith('image/')) {
			error = 'Please choose an image.';
			return;
		}
		error = null;
		try {
			imageDataUrl = await downscale(file);
		} catch {
			error = 'Could not read that image.';
		}
	}

	async function identify() {
		if (!canIdentify) return;
		busy = true;
		error = null;
		food = null;
		try {
			const res = await fetch('/api/describe', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ image: imageDataUrl ?? undefined, text: text.trim() || undefined })
			});
			if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
			food = (await res.json()).food as DescribedFood;
			servings = 1;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to identify.';
		} finally {
			busy = false;
		}
	}

	function add() {
		if (!food) return;
		const s = Math.max(0, Number(servings) || 0);
		if (s <= 0) return;
		onadd({
			foodId: food.id,
			name: food.name,
			amount: s,
			unit: 'serving' as Unit,
			servings: s,
			calories: food.calories * s,
			proteinG: food.proteinG * s,
			carbsG: food.carbsG * s,
			fatG: food.fatG * s,
			bolusableCarbsG: food.bolusableCarbsG * s,
			bolusableLowConfidence: food.bolusableLowConfidence
		});
	}
</script>

<div class="flex items-center gap-3">
	<button class="text-sm" style="color: var(--color-text-muted);" onclick={onback}>← Back</button>
	<h3 class="text-base font-bold text-white">Describe or scan a label</h3>
</div>

{#if !food}
	<label for="ai-desc" class="mt-4 block text-xs" style="color: var(--color-text-subtle);"
		>What did you eat? (or snap the nutrition label)</label
	>
	<textarea
		id="ai-desc"
		bind:value={text}
		rows="3"
		placeholder="e.g. two scrambled eggs and a slice of sourdough"
		class="mt-1 w-full rounded-xl bg-white/5 p-3 text-sm text-white outline-none placeholder:text-white/30"
	></textarea>

	<div class="mt-3 flex items-center gap-3">
		<label
			class="card-sm inline-flex cursor-pointer items-center gap-2 px-4 py-2 text-sm text-white active:scale-95"
		>
			📷 {imageDataUrl ? 'Retake' : 'Photo'}
			<input type="file" accept="image/*" capture="environment" class="hidden" onchange={onPick} />
		</label>
		{#if imageDataUrl}
			<img src={imageDataUrl} alt="selected food" class="h-12 w-12 rounded-lg object-cover" />
			<button
				class="text-xs"
				style="color: var(--color-text-subtle);"
				onclick={() => (imageDataUrl = null)}>remove</button
			>
		{/if}
	</div>

	<button
		onclick={identify}
		disabled={!canIdentify}
		class="mt-4 w-full rounded-xl py-3 text-sm font-semibold text-white transition disabled:opacity-50"
		style="background: rgba(255,255,255,0.12);"
	>
		{busy ? 'Asking Claude…' : 'Identify with Claude'}
	</button>
{:else}
	<div class="card mt-4 p-4">
		<div class="flex items-baseline justify-between">
			<h4 class="text-lg font-bold text-white">{food.name}</h4>
			<span class="text-[10px] tracking-wide uppercase" style="color: var(--color-text-subtle);"
				>{food.source === 'label_ocr' ? 'from label' : 'estimated'}</span
			>
		</div>
		{#if food.brand}<p class="text-sm" style="color: var(--color-text-subtle);">
				{food.brand}
			</p>{/if}
		<div class="mt-3 grid grid-cols-4 gap-2 text-center">
			{#each [['kcal', food.calories], ['P', food.proteinG], ['C', food.carbsG], ['F', food.fatG]] as [label, val] (label)}
				<div class="rounded-lg bg-white/5 py-2">
					<div class="text-sm font-bold text-white">{Math.round((val as number) * servings)}</div>
					<div class="text-[10px]" style="color: var(--color-text-subtle);">{label}</div>
				</div>
			{/each}
		</div>
		<p class="mt-2 text-[11px]" style="color: var(--color-text-subtle);">
			per serving{#if food.servingSize}
				· {food.servingSize}{/if}
		</p>

		<label for="ai-servings" class="mt-4 block text-xs" style="color: var(--color-text-subtle);"
			>Servings ({UNIT_LABEL['serving']})</label
		>
		<input
			id="ai-servings"
			type="number"
			min="0.25"
			step="0.25"
			bind:value={servings}
			class="mt-1 w-24 rounded-lg bg-white/5 p-2 text-sm text-white outline-none"
		/>

		<div class="mt-4 flex gap-2">
			<button
				onclick={() => (food = null)}
				class="flex-1 rounded-xl py-3 text-sm font-semibold text-white/80"
				style="background: rgba(255,255,255,0.06);">Redo</button
			>
			<button
				onclick={add}
				class="flex-1 rounded-xl py-3 text-sm font-semibold text-white"
				style="background: var(--color-accent, #6366f1);">Add to meal</button
			>
		</div>
	</div>
{/if}

{#if error}
	<p class="mt-3 text-xs" style="color: var(--color-danger, #f87171);">{error}</p>
{/if}
