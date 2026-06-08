<script lang="ts">
	// Plain native form: a successful login redirects (303) and the wrong-password
	// case re-renders this page with form.error. No enhance needed.
	let { data, form } = $props();
</script>

<main class="mx-auto flex min-h-screen max-w-md flex-col justify-center p-6">
	<div class="card p-6">
		<div class="mb-5 flex items-center gap-3">
			<div
				class="flex h-11 w-11 items-center justify-center rounded-2xl"
				style="background: rgba(251,146,60,0.15);"
			>
				<svg
					width="22"
					height="22"
					viewBox="0 0 24 24"
					fill="none"
					stroke="#fdba74"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
				>
					<rect x="3" y="11" width="18" height="11" rx="2" />
					<path d="M7 11V7a5 5 0 0110 0v4" />
				</svg>
			</div>
			<div>
				<p
					class="text-xs font-semibold tracking-widest uppercase"
					style="color: var(--color-text-subtle);"
				>
					Health Dashboard
				</p>
				<h1 class="text-xl font-bold text-white">Sign in</h1>
			</div>
		</div>

		<form method="POST">
			<input type="hidden" name="redirect" value={data.redirectTo} />

			<label
				class="mb-1 block text-xs font-medium"
				style="color: var(--color-text-subtle);"
				for="pw"
			>
				Password
			</label>
			<input
				id="pw"
				name="password"
				type="password"
				autocomplete="current-password"
				required
				class="w-full rounded-lg border bg-transparent px-3 py-2 text-white outline-none focus:border-orange-400"
				style="border-color: var(--color-border);"
			/>

			{#if form?.error}
				<p class="mt-2 text-xs text-red-300">{form.error}</p>
			{/if}

			<button
				type="submit"
				class="mt-5 w-full rounded-lg px-4 py-2 text-sm font-semibold text-black transition"
				style="background: #fb923c;"
			>
				Sign in
			</button>
		</form>
	</div>
</main>
