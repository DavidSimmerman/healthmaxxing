<script lang="ts">
	import { pullToRefresh } from '$lib/actions/pullToRefresh';
	import { invalidateAll } from '$app/navigation';

	let { data } = $props();

	let generating = $state(false);
	let genError = $state<string | null>(null);

	// Ask the Claude sandbox to analyze recent data and save_report; the new report
	// arrives via invalidateAll(). Runs long (Claude reads the data + writes it), so
	// the button just spins until it lands.
	async function generate() {
		if (generating) return;
		generating = true;
		genError = null;
		try {
			const res = await fetch('/api/reports/generate', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ period: 'this week' })
			});
			if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
			await invalidateAll();
		} catch (e) {
			genError = e instanceof Error ? e.message : 'failed';
		} finally {
			generating = false;
		}
	}

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

<main class="mx-auto max-w-md p-5 pb-16" use:pullToRefresh>
	<header class="mb-5 flex items-center gap-3">
		<a href="/" class="text-sm" style="color: var(--color-text-muted);">← Home</a>
		<h1 class="text-lg font-bold text-white">Reports</h1>
		<button
			onclick={generate}
			disabled={generating}
			class="ml-auto rounded-full px-3 py-1.5 text-xs font-semibold text-white transition disabled:opacity-60"
			style="background: rgba(255,255,255,0.09);"
		>
			{generating ? 'Analyzing…' : '✨ Generate'}
		</button>
	</header>

	{#if genError}
		<p class="mb-3 text-xs" style="color: var(--color-danger, #f87171);">
			Couldn't generate: {genError}
		</p>
	{/if}

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
