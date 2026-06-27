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

		<!-- Reports -->
		<a
			href="/reports"
			class="flex flex-col items-center gap-1 transition active:scale-95"
			style="color: {active.startsWith('/reports') ? 'var(--color-accent-to, #fb923c)' : 'var(--color-text-subtle)'};"
			aria-label="Reports"
			aria-current={active.startsWith('/reports') ? 'page' : undefined}
		>
			<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
				<polyline points="14 2 14 8 20 8" />
				<line x1="8" y1="13" x2="16" y2="13" />
				<line x1="8" y1="17" x2="16" y2="17" />
			</svg>
			<span class="text-[10px] font-medium">Reports</span>
		</a>
	</div>
</nav>
