// Standalone migration runner for production (Coolify) startup.
// Plain ESM so it runs directly with `node` at container start — no build step.
// Imports resolve from the runtime node_modules (drizzle-orm + postgres are
// production dependencies); migrations are read from ./drizzle. DATABASE_URL is
// injected by the platform.
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

async function main() {
	// max:1 — a single connection is all the migrator needs, and it lets us close cleanly.
	const client = postgres(url, { max: 1 });
	try {
		// Serialize concurrent boots (a restart racing a rolling deploy): drizzle's
		// migrator takes no lock of its own, so two runners can read the same
		// "last applied" row and collide. Advisory lock is per-connection; max:1
		// keeps it on this one, and closing the connection always releases it.
		await client`select pg_advisory_lock(727001)`;
		await migrate(drizzle(client), { migrationsFolder: './drizzle' });
		console.log('migrations applied');
	} finally {
		await client.end();
	}
}

main().catch((e) => {
	console.error('migration failed:', e);
	process.exit(1);
});
