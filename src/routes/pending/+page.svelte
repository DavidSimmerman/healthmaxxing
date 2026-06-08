<script lang="ts">
	import { invalidateAll } from '$app/navigation';

	let { data } = $props();

	let deleting = $state<string | null>(null);

	async function del(id: string) {
		if (!confirm('Delete this capture? This cannot be undone.')) return;
		deleting = id;
		try {
			const res = await fetch(`/api/pending/${id}`, { method: 'DELETE' });
			if (!res.ok) {
				alert('Delete failed');
				return;
			}
			await invalidateAll();
		} finally {
			deleting = null;
		}
	}

	function kindLabel(kind: string) {
		switch (kind) {
			case 'barcode':
				return 'Barcode';
			case 'label_photo':
				return 'Label photo';
			case 'paste':
				return 'Pasted text';
			case 'photo_with_caption':
				return 'Photo + caption';
			default:
				return kind;
		}
	}

	function relTime(d: string | Date | null) {
		if (!d) return '';
		const t = new Date(d).getTime();
		const diff = Date.now() - t;
		const min = Math.round(diff / 60000);
		if (min < 1) return 'just now';
		if (min < 60) return `${min}m ago`;
		const hr = Math.round(min / 60);
		if (hr < 24) return `${hr}h ago`;
		const day = Math.round(hr / 24);
		return `${day}d ago`;
	}
</script>

<main
	class="mx-auto max-w-md p-6 pb-12"
	style="padding-bottom: calc(3rem + env(safe-area-inset-bottom));"
>
	<header class="mb-6 flex items-center gap-3">
		<a
			href="/"
			class="card-sm flex h-9 w-9 items-center justify-center text-white transition hover:brightness-125"
			aria-label="Back to today"
		>
			<svg
				width="16"
				height="16"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2.5"
				stroke-linecap="round"
				stroke-linejoin="round"
			>
				<path d="M15 18l-6-6 6-6" />
			</svg>
		</a>
		<div>
			<p
				class="text-xs font-semibold tracking-widest uppercase"
				style="color: var(--color-text-subtle);"
			>
				Capture queue
			</p>
			<h1 class="text-2xl font-bold text-white">Pending</h1>
		</div>
	</header>

	<section>
		<h2
			class="mb-3 flex items-center gap-2 text-sm font-semibold tracking-wide text-white uppercase"
		>
			<span class="h-2 w-2 animate-pulse rounded-full bg-orange-400"></span>
			Awaiting Claude Code
			<span class="ml-auto text-xs font-normal" style="color: var(--color-text-subtle);">
				{data.pending.length}
			</span>
		</h2>

		{#if data.pending.length === 0}
			<div class="card p-6 text-center text-sm" style="color: var(--color-text-subtle);">
				Nothing pending. Captures will appear here while they wait for resolution.
			</div>
		{:else}
			<div class="flex flex-col gap-3">
				{#each data.pending as item (item.id)}
					<article class="card p-4">
						<div class="mb-2 flex items-center justify-between">
							<span
								class="rounded-full px-2 py-0.5 text-xs font-semibold"
								style="background: rgba(251,146,60,0.15); color: #fdba74;"
							>
								{kindLabel(item.kind)}
							</span>
							<span class="text-xs" style="color: var(--color-text-subtle);">
								{relTime(item.createdAt)}
							</span>
						</div>

						{#if item.imagePath}
							<a
								href={`/api/uploads/${item.imagePath}`}
								target="_blank"
								rel="noopener"
								class="mb-3 block overflow-hidden rounded-xl border"
								style="border-color: var(--color-border);"
							>
								<img
									src={`/api/uploads/${item.imagePath}`}
									alt="Capture"
									class="max-h-64 w-full object-contain"
									style="background: rgba(0,0,0,0.3);"
								/>
							</a>
						{/if}

						{#if item.barcode}
							<p class="mb-1 font-mono text-sm text-white">{item.barcode}</p>
						{/if}

						{#if item.text}
							<p class="mb-1 text-sm whitespace-pre-wrap text-white">{item.text}</p>
						{/if}

						<div class="mt-3 flex justify-end">
							<button
								type="button"
								onclick={() => del(item.id)}
								disabled={deleting === item.id}
								class="rounded-lg px-3 py-1.5 text-xs font-medium text-red-300 transition hover:bg-red-500/10 disabled:opacity-50"
							>
								{deleting === item.id ? 'Deleting…' : 'Delete'}
							</button>
						</div>
					</article>
				{/each}
			</div>
		{/if}
	</section>

	{#if data.resolved.length > 0}
		<section class="mt-8">
			<h2
				class="mb-3 flex items-center gap-2 text-sm font-semibold tracking-wide text-white uppercase"
			>
				<span class="h-2 w-2 rounded-full bg-emerald-400"></span>
				Recently resolved
				<span class="ml-auto text-xs font-normal" style="color: var(--color-text-subtle);">
					{data.resolved.length}
				</span>
			</h2>

			<div class="flex flex-col gap-3">
				{#each data.resolved as item (item.id)}
					<article class="card p-4 opacity-90">
						<div class="mb-2 flex items-center justify-between">
							<span
								class="rounded-full px-2 py-0.5 text-xs font-semibold"
								style="background: rgba(52,211,153,0.15); color: #6ee7b7;"
							>
								{kindLabel(item.kind)} · {item.status}
							</span>
							<span class="text-xs" style="color: var(--color-text-subtle);">
								{relTime(item.resolvedAt ?? item.createdAt)}
							</span>
						</div>

						{#if item.foodName}
							<p class="text-sm text-white">
								<span class="font-semibold">{item.foodName}</span>
								{#if item.foodBrand}
									<span style="color: var(--color-text-subtle);"> · {item.foodBrand}</span>
								{/if}
							</p>
						{/if}

						{#if item.text}
							<p
								class="mt-1 line-clamp-2 text-xs whitespace-pre-wrap"
								style="color: var(--color-text-subtle);"
							>
								{item.text}
							</p>
						{/if}

						{#if item.resolverNote}
							<p
								class="mt-2 rounded-lg p-2 text-xs italic"
								style="background: rgba(255,255,255,0.04); color: var(--color-text-subtle);"
							>
								“{item.resolverNote}”
							</p>
						{/if}

						<div class="mt-3 flex justify-end">
							<button
								type="button"
								onclick={() => del(item.id)}
								disabled={deleting === item.id}
								class="rounded-lg px-3 py-1.5 text-xs font-medium text-red-300 transition hover:bg-red-500/10 disabled:opacity-50"
							>
								{deleting === item.id ? 'Deleting…' : 'Delete'}
							</button>
						</div>
					</article>
				{/each}
			</div>
		</section>
	{/if}
</main>
