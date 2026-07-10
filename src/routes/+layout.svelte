<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.png';
	import { onMount } from 'svelte';
	import BottomNav from '$lib/components/BottomNav.svelte';
	import CaptureSheet from '$lib/components/CaptureSheet.svelte';
	import ChatSheet from '$lib/components/ChatSheet.svelte';
	import { captureOpen } from '$lib/stores/capture';

	let { children, data } = $props();

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

<BottomNav unread={data.unreadChats} />
<CaptureSheet bind:open={$captureOpen} />
<ChatSheet />
