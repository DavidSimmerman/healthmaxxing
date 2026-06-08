<script lang="ts">
	// Plain (non-enhanced) form on purpose: a successful authorization redirects
	// to an EXTERNAL url (claude.ai/...), which use:enhance's goto-based handling
	// can't follow. A native POST gets a real 303 the browser follows. The
	// wrong-password case re-renders this page server-side with `form.error`.
	let { data, form } = $props();
	const p = data.params;
	// Keep the OAuth query params on the action URL so a failed submit re-renders
	// with the error instead of losing client_id and 400-ing.
	const authorizeAction = '?/authorize' + (data.search ? '&' + data.search.replace(/^\?/, '') : '');
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
					<path
						d="M12 2a3 3 0 00-3 3v1H7a2 2 0 00-2 2v3a7 7 0 0014 0V8a2 2 0 00-2-2h-2V5a3 3 0 00-3-3z"
					/>
				</svg>
			</div>
			<div>
				<p
					class="text-xs font-semibold tracking-widest uppercase"
					style="color: var(--color-text-subtle);"
				>
					Authorize access
				</p>
				<h1 class="text-xl font-bold text-white">Health Dashboard</h1>
			</div>
		</div>

		<p class="mb-5 text-sm" style="color: var(--color-text-subtle);">
			<span class="font-semibold text-white">{data.clientName ?? 'An application'}</span>
			wants to connect to your health dashboard and log foods on your behalf. Enter your authorization
			password to allow it.
		</p>

		<form method="POST" action={authorizeAction}>
			<input type="hidden" name="client_id" value={p.clientId} />
			<input type="hidden" name="redirect_uri" value={p.redirectUri} />
			<input type="hidden" name="code_challenge" value={p.codeChallenge} />
			<input type="hidden" name="code_challenge_method" value={p.codeChallengeMethod} />
			<input type="hidden" name="state" value={p.state} />
			<input type="hidden" name="scope" value={p.scope} />
			<input type="hidden" name="resource" value={p.resource} />

			<label
				class="mb-1 block text-xs font-medium"
				style="color: var(--color-text-subtle);"
				for="pw"
			>
				Authorization password
			</label>
			<input
				id="pw"
				name="password"
				type="password"
				autocomplete="current-password"
				required
				autofocus
				class="w-full rounded-lg border bg-transparent px-3 py-2 text-white outline-none focus:border-orange-400"
				style="border-color: var(--color-border);"
			/>

			{#if form?.error}
				<p class="mt-2 text-xs text-red-300">{form.error}</p>
			{/if}

			<div class="mt-5 flex gap-3">
				<button
					type="submit"
					formaction="?/deny"
					class="flex-1 rounded-lg border px-4 py-2 text-sm font-medium text-white transition hover:bg-white/5"
					style="border-color: var(--color-border);"
				>
					Deny
				</button>
				<button
					type="submit"
					class="flex-[2] rounded-lg px-4 py-2 text-sm font-semibold text-black transition"
					style="background: #fb923c;"
				>
					Allow access
				</button>
			</div>
		</form>
	</div>

	<p class="mt-4 text-center text-xs" style="color: var(--color-text-subtle);">
		You're approving a connection for {p.redirectUri ? new URL(p.redirectUri).host : 'the client'}.
	</p>
</main>
