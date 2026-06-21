<script lang="ts">
	let { data } = $props();

	function cols(rows: Record<string, unknown>[]): string[] {
		return rows.length ? Object.keys(rows[0]) : [];
	}

	function fmt(v: unknown): string {
		if (v === null || v === undefined) return '—';
		if (v instanceof Date) return v.toLocaleString();
		if (typeof v === 'object') return JSON.stringify(v);
		return String(v);
	}
</script>

<svelte:head><title>{data.label} — data</title></svelte:head>

<main class="mx-auto max-w-5xl p-5">
	<header class="mb-5 flex items-center gap-3">
		<a href="/data" class="text-sm" style="color: var(--color-text-muted);">← Sources</a>
		<h1 class="text-2xl font-bold text-white">{data.label}</h1>
	</header>

	<div class="flex flex-col gap-7">
		{#each data.tables as t (t.key)}
			<section>
				<h2 class="mb-2 font-semibold text-white">
					{t.label}
					<span class="ml-1 text-sm font-normal" style="color: var(--color-text-subtle);">
						{t.count.toLocaleString()} rows{t.count > t.limit ? ` (showing latest ${t.limit})` : ''}
					</span>
				</h2>

				{#if t.rows.length}
					<div class="card overflow-x-auto">
						<table class="w-full text-left text-xs whitespace-nowrap">
							<thead style="color: var(--color-text-subtle);">
								<tr>
									{#each cols(t.rows) as c (c)}
										<th class="px-3 py-2 font-medium">{c}</th>
									{/each}
								</tr>
							</thead>
							<tbody>
								{#each t.rows as row, i (i)}
									<tr style="border-top: 1px solid var(--color-border);">
										{#each cols(t.rows) as c (c)}
											<td
												class="max-w-[20rem] truncate px-3 py-1.5"
												style="color: var(--color-text-muted);"
												title={fmt(row[c])}>{fmt(row[c])}</td
											>
										{/each}
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{:else}
					<p class="text-sm" style="color: var(--color-text-subtle);">No data yet.</p>
				{/if}
			</section>
		{/each}
	</div>
</main>
