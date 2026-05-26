<script lang="ts">
	type Props = { onback: () => void; oncaptured: () => void };
	let { onback, oncaptured }: Props = $props();

	let text = $state('');
	let busy = $state(false);

	async function submit() {
		if (!text.trim()) return;
		busy = true;
		const fd = new FormData();
		fd.append('kind', 'paste');
		fd.append('text', text);
		const res = await fetch('/api/pending', { method: 'POST', body: fd });
		if (res.ok) oncaptured();
		else busy = false;
	}
</script>

<div class="flex items-center justify-between">
	<button class="text-sm" style="color: var(--color-text-subtle);" onclick={onback}>← Back</button>
	<h2 class="font-semibold text-white">Describe it</h2>
	<div class="w-12"></div>
</div>

<textarea
	bind:value={text}
	rows="6"
	placeholder={`e.g.\n"Chipotle bowl, double chicken, brown rice, black beans, mild + corn salsa, cheese, lettuce"\n\nor paste a menu item, recipe, anything text-based.`}
	class="card-sm mt-4 w-full resize-none bg-transparent px-4 py-3 text-white outline-none placeholder:text-zinc-500"
></textarea>

<button
	class="accent-gradient mt-3 w-full rounded-2xl py-4 font-bold text-white disabled:opacity-60"
	disabled={busy || !text.trim()}
	onclick={submit}
>
	{busy ? 'Saving…' : 'Save as pending'}
</button>

<p class="mt-3 text-center text-xs" style="color: var(--color-text-subtle);">
	Claude Code will estimate macros when you run <code>/process-health</code>.
</p>
