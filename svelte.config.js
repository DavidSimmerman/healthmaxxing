import adapter from '@sveltejs/adapter-node';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		adapter: adapter(),
		// The OAuth /token endpoint must accept the spec-mandated cross-origin
		// (and origin-less server-to-server) `application/x-www-form-urlencoded`
		// POSTs, which SvelteKit's built-in CSRF origin check would 403. We turn
		// the global check off and re-implement a same-origin guard for every
		// other form POST in hooks.server.ts (exempting /token).
		csrf: { checkOrigin: false },
		typescript: {
			config: (config) => ({
				...config,
				include: [...config.include, '../drizzle.config.ts']
			})
		}
	}
};

export default config;
