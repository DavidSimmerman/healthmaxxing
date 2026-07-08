<script lang="ts">
	import { page } from '$app/state';
	import { captureOpen } from '$lib/stores/capture';

	// Centre button is "home" everywhere except the home page, where it becomes
	// the "+" that opens the log-food sheet. So from any other page it's two taps
	// to log: home, then +.
	let atHome = $derived(page.url.pathname === '/');
	let active = $derived(page.url.pathname);
</script>

<nav
	class="fixed inset-x-0 bottom-0 z-40 border-t backdrop-blur"
	style="border-color: var(--color-border); background: color-mix(in srgb, var(--color-bg, #0a0a0c) 90%, transparent); padding-bottom: env(safe-area-inset-bottom);"
	aria-label="Primary"
>
	<div class="mx-auto grid h-16 max-w-md grid-cols-3 items-center px-6">
		<!-- Trends -->
		<a
			href="/trends"
			class="flex flex-col items-center gap-1 transition active:scale-95"
			style="color: {active.startsWith('/trends') ? 'var(--color-accent-to, #fb923c)' : 'var(--color-text-subtle)'};"
			aria-label="Trends"
			aria-current={active.startsWith('/trends') ? 'page' : undefined}
		>
			<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<polyline points="3 17 9 11 13 15 21 7" />
				<polyline points="15 7 21 7 21 13" />
			</svg>
			<span class="text-[10px] font-medium">Trends</span>
		</a>

		<!-- Centre: home everywhere, + on the home page -->
		<div class="flex justify-center">
			{#if atHome}
				<button
					type="button"
					onclick={() => captureOpen.set(true)}
					class="accent-gradient accent-shadow -mt-6 flex h-16 w-16 items-center justify-center rounded-full text-white transition active:scale-95"
					aria-label="Log food"
				>
					<svg class="h-7 w-7" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
						<path stroke-linecap="round" d="M12 5v14m-7-7h14" />
					</svg>
				</button>
			{:else}
				<a
					href="/"
					class="accent-gradient accent-shadow -mt-6 flex h-16 w-16 items-center justify-center rounded-full text-white transition active:scale-95"
					aria-label="Home"
				>
					<svg class="h-7 w-7" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
						<path d="M3 11.5 12 4l9 7.5" />
						<path d="M5 10v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9" />
					</svg>
				</a>
			{/if}
		</div>

		<!-- Assistant (chats + reports) -->
		<a
			href="/reports"
			class="flex flex-col items-center gap-1 transition active:scale-95"
			style="color: {active.startsWith('/reports') ? 'var(--color-accent-to, #fb923c)' : 'var(--color-text-subtle)'};"
			aria-label="Assistant"
			aria-current={active.startsWith('/reports') ? 'page' : undefined}
		>
			<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
			</svg>
			<span class="text-[10px] font-medium">Assistant</span>
		</a>
	</div>
</nav>
