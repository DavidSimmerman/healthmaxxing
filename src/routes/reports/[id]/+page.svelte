<script lang="ts">
	let { data } = $props();
	// Derived so a direct /reports/[id] → /reports/[id] navigation (component reused,
	// only `data` updated) refreshes the header instead of showing the prior report's
	// title/date/tag next to the new body.
	const r = $derived(data.report);

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
	const range = $derived(fmtRange(r.rangeFrom, r.rangeTo));
</script>

<main class="mx-auto max-w-md p-5 pb-16">
	<header class="mb-5 flex items-center gap-3">
		<a href="/reports" class="text-sm" style="color: var(--color-text-muted);">← Reports</a>
	</header>

	<h1 class="text-xl font-bold text-white">{r.title}</h1>
	<p class="mt-1 text-xs" style="color: var(--color-text-subtle);">
		{fmtDate(r.createdAt)}
		{#if range}<span> · {range}</span>{/if}
		{#if r.tag}
			<span
				class="ml-1 rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase"
				style="background: rgba(255,255,255,0.07); color: var(--color-text-muted);">{r.tag}</span
			>
		{/if}
	</p>

	<article class="prose-report card mt-4 p-5 text-sm leading-relaxed">
		{@html data.html}
	</article>
</main>

<style>
	/* Minimal prose styling for the sanitized markdown, tuned for the dark card. */
	.prose-report {
		color: #d4d4d8;
	}
	.prose-report :global(h1),
	.prose-report :global(h2),
	.prose-report :global(h3),
	.prose-report :global(h4) {
		color: #fff;
		font-weight: 700;
		line-height: 1.25;
		margin: 1.1em 0 0.5em;
	}
	.prose-report :global(h1) {
		font-size: 1.25rem;
	}
	.prose-report :global(h2) {
		font-size: 1.1rem;
	}
	.prose-report :global(h3),
	.prose-report :global(h4) {
		font-size: 1rem;
	}
	.prose-report :global(:first-child) {
		margin-top: 0;
	}
	.prose-report :global(p),
	.prose-report :global(ul),
	.prose-report :global(ol),
	.prose-report :global(blockquote),
	.prose-report :global(table) {
		margin: 0.6em 0;
	}
	.prose-report :global(ul),
	.prose-report :global(ol) {
		padding-left: 1.25em;
	}
	.prose-report :global(ul) {
		list-style: disc;
	}
	.prose-report :global(ol) {
		list-style: decimal;
	}
	.prose-report :global(li) {
		margin: 0.2em 0;
	}
	.prose-report :global(strong) {
		color: #fff;
		font-weight: 600;
	}
	.prose-report :global(a) {
		color: #fb923c;
		text-decoration: underline;
	}
	.prose-report :global(code) {
		background: rgba(255, 255, 255, 0.08);
		border-radius: 4px;
		padding: 0.1em 0.35em;
		font-size: 0.85em;
	}
	.prose-report :global(pre) {
		background: rgba(0, 0, 0, 0.35);
		border-radius: 8px;
		padding: 0.75em 0.9em;
		overflow-x: auto;
	}
	.prose-report :global(pre code) {
		background: none;
		padding: 0;
	}
	.prose-report :global(blockquote) {
		border-left: 3px solid var(--color-border);
		padding-left: 0.9em;
		color: var(--color-text-muted);
	}
	.prose-report :global(hr) {
		border: none;
		border-top: 1px solid var(--color-border);
		margin: 1.2em 0;
	}
	.prose-report :global(table) {
		width: 100%;
		border-collapse: collapse;
	}
	.prose-report :global(th),
	.prose-report :global(td) {
		border: 1px solid var(--color-border);
		padding: 0.4em 0.6em;
		text-align: left;
	}
	.prose-report :global(th) {
		color: #fff;
		font-weight: 600;
	}
</style>
