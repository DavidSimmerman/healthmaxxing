<script lang="ts">
	let { data } = $props();
</script>

<svelte:head><title>Data sources</title></svelte:head>

<main class="mx-auto max-w-2xl p-5">
	<header class="mb-5 flex items-center gap-3">
		<a href="/" class="text-sm" style="color: var(--color-text-muted);">← Home</a>
		<h1 class="text-2xl font-bold text-white">Data sources</h1>
	</header>

	<div class="flex flex-col gap-3">
		{#each data.sources as source (source.key)}
			<a
				href="/data/{source.key}"
				class="card flex items-center justify-between p-4 transition hover:brightness-125"
			>
				<div>
					<p class="font-semibold text-white">{source.label}</p>
					<p class="text-sm" style="color: var(--color-text-muted);">
						{source.tables.join(' · ')}
					</p>
				</div>
				<span class="text-right text-sm" style="color: var(--color-text-subtle);">
					{source.total.toLocaleString()} rows →
				</span>
			</a>
		{/each}
	</div>
</main>
