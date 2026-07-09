<script lang="ts">
	import { pullToRefresh } from '$lib/actions/pullToRefresh';
	import { openNewChat, openChat } from '$lib/stores/chat';

	let { data } = $props();

	let opening = $state<string | null>(null);
	let error = $state<string | null>(null);

	async function openSaved(id: string) {
		if (opening) return;
		opening = id;
		error = null;
		try {
			const res = await fetch(`/api/chats/${id}`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const chat = await res.json();
			openChat(id, chat.messages ?? []);
		} catch (e) {
			error = e instanceof Error ? e.message : "couldn't open chat";
		} finally {
			opening = null;
		}
	}

	// Relative-ish time: today shows the clock, this week the weekday, else the date.
	function fmtWhen(iso: string): string {
		const d = new Date(iso);
		const now = new Date();
		const days = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
		if (days <= 0 && d.getDate() === now.getDate())
			return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
		if (days < 7) return d.toLocaleDateString([], { weekday: 'short' });
		return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
	}
</script>

<main class="mx-auto flex min-h-[100dvh] max-w-md flex-col p-5 pb-16" use:pullToRefresh>
	<header class="mb-5 flex items-center gap-3">
		<a href="/" class="text-sm" style="color: var(--color-text-muted);">← Home</a>
		<h1 class="text-lg font-bold text-white">Assistant</h1>
		<button
			onclick={openNewChat}
			class="accent-gradient ml-auto flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold text-white transition active:scale-95"
		>
			<svg
				class="h-3.5 w-3.5"
				fill="none"
				stroke="currentColor"
				stroke-width="2.5"
				viewBox="0 0 24 24"><path stroke-linecap="round" d="M12 5v14m-7-7h14" /></svg
			>
			New chat
		</button>
	</header>

	{#if error}
		<p class="mb-3 text-xs" style="color: var(--color-danger, #f87171);">{error}</p>
	{/if}

	{#if data.items.length === 0}
		<button
			onclick={openNewChat}
			class="card mt-6 flex flex-col items-center gap-2 p-8 text-center text-sm transition hover:brightness-110"
			style="color: var(--color-text-subtle);"
		>
			<span class="text-3xl">✨</span>
			Ask about your macros, plan a meal, or scan a label.
			<span class="font-medium text-white">Start a chat →</span>
		</button>
	{:else}
		<div class="flex flex-col gap-2">
			{#each data.items as item (item.kind + item.id)}
				{#if item.kind === 'report'}
					<a
						href="/reports/{item.id}"
						class="card-sm flex items-center gap-3 p-4 transition hover:brightness-125"
					>
						<span class="text-lg">📊</span>
						<div class="min-w-0 flex-1">
							<p class="truncate font-medium text-white">{item.title}</p>
							<p class="mt-0.5 text-xs" style="color: var(--color-text-subtle);">
								Report · {fmtWhen(item.at)}{#if item.tag}
									· {item.tag}{/if}
							</p>
						</div>
					</a>
				{:else}
					<button
						onclick={() => openSaved(item.id)}
						disabled={opening === item.id}
						class="card-sm flex items-center gap-3 p-4 text-left transition hover:brightness-125 disabled:opacity-60"
					>
						<span class="text-lg">💬</span>
						<div class="min-w-0 flex-1">
							<p class="truncate font-medium text-white">{item.title}</p>
							<p class="mt-0.5 text-xs" style="color: var(--color-text-subtle);">
								{opening === item.id ? 'Opening…' : fmtWhen(item.at)}
							</p>
						</div>
					</button>
				{/if}
			{/each}
		</div>
	{/if}
</main>
