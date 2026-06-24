<script lang="ts">
	let { data } = $props();

	function fmtDate(iso: string): string {
		return new Date(iso).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			year: 'numeric'
		});
	}
	function fmtRange(from: string | null, to: string | null): string | null {
		if (!from && !to) return null;
		const f = (d: string) =>
			new Date(`${d}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
		if (from && to) return from === to ? f(from) : `${f(from)} – ${f(to)}`;
		return f((from ?? to)!);
	}
</script>

<main class="mx-auto max-w-md p-5 pb-16">
	<header class="mb-5 flex items-center gap-3">
		<a href="/" class="text-sm" style="color: var(--color-text-muted);">← Home</a>
		<h1 class="text-lg font-bold text-white">Reports</h1>
	</header>

	{#if data.reports.length === 0}
		<div class="card p-6 text-center text-sm" style="color: var(--color-text-subtle);">
			No reports yet. The scheduled Claude review writes its findings here.
		</div>
	{:else}
		<div class="flex flex-col gap-2">
			{#each data.reports as r (r.id)}
				{@const range = fmtRange(r.rangeFrom, r.rangeTo)}
				<a href="/reports/{r.id}" class="card-sm block p-4 transition hover:brightness-125">
					<p class="font-medium text-white">{r.title}</p>
					<p class="mt-1 text-xs" style="color: var(--color-text-subtle);">
						{fmtDate(r.createdAt)}
						{#if range}<span> · {range}</span>{/if}
						{#if r.tag}
							<span
								class="ml-1 rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase"
								style="background: rgba(255,255,255,0.07); color: var(--color-text-muted);"
								>{r.tag}</span
							>
						{/if}
					</p>
				</a>
			{/each}
		</div>
	{/if}
</main>
