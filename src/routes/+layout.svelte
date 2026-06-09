<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>

<!-- Pad below the iOS status bar / Dynamic Island in standalone PWA mode.
     env() resolves to 0 in a normal browser, so this is a no-op there. -->
<div style="padding-top: env(safe-area-inset-top);">
	{@render children()}
</div>
