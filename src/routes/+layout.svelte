<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.png';
	import { onMount } from 'svelte';
	import BottomNav from '$lib/components/BottomNav.svelte';
	import CaptureSheet from '$lib/components/CaptureSheet.svelte';
	import ChatSheet from '$lib/components/ChatSheet.svelte';
	import { captureOpen } from '$lib/stores/capture';
	import { chatOpen } from '$lib/stores/chat';

	let { children } = $props();

	// Inside the iOS app's WebView, nudge the home-screen widget to reload after
	// any food-log change (create / edit / delete — all hit /api/log) so it never
	// shows stale numbers. The reload re-fetches /api/today, which updates the
	// deficit too. No-op in a normal browser (the message handler doesn't exist).
	onMount(() => {
		const widget = (
			window as unknown as {
				webkit?: { messageHandlers?: { widget?: { postMessage(m: string): void } } };
			}
		).webkit?.messageHandlers?.widget;
		if (!widget) return;

		const orig = window.fetch;
		window.fetch = async (input, init) => {
			const res = await orig(input, init);
			const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
			const method = (
				init?.method ?? (input instanceof Request ? input.method : 'GET')
			).toUpperCase();
			if (
				res.ok &&
				method !== 'GET' &&
				(url.includes('/api/log') ||
					url.includes('/api/planned') ||
					url.includes('/api/chat/confirm'))
			)
				widget.postMessage('reload');
			return res;
		};
	});
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>

<!-- Pad below the iOS status bar / Dynamic Island in standalone PWA mode, and
     above the fixed bottom nav, so page content never hides behind either.
     env() resolves to 0 in a normal browser, so the insets are no-ops there. -->
<div
	style="padding-top: env(safe-area-inset-top); padding-bottom: calc(4.5rem + env(safe-area-inset-bottom));"
>
	{@render children()}
</div>

<!-- Floating AI chat launcher — above the bottom nav, out of the way of the centre FAB.
     Hidden while the chat is open (the full-screen sheet covers it anyway). -->
{#if !$chatOpen}
	<button
		type="button"
		onclick={() => chatOpen.set(true)}
		class="accent-shadow fixed right-4 z-40 flex h-13 w-13 items-center justify-center rounded-full text-xl text-white transition active:scale-95"
		style="bottom: calc(5rem + env(safe-area-inset-bottom)); height: 3.25rem; width: 3.25rem; background: var(--color-accent, #6366f1);"
		aria-label="Open AI assistant"
	>
		✨
	</button>
{/if}

<BottomNav />
<CaptureSheet bind:open={$captureOpen} />
<ChatSheet bind:open={$chatOpen} />
