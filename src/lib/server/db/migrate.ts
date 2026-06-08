// Standalone migration runner for production (Coolify) startup.
// Runs the committed SQL migrations in ./drizzle without needing drizzle-kit
// (a dev dependency). Invoked by the container entrypoint before the server
// starts; DATABASE_URL is injected by the platform.
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

async function main() {
	// max:1 — a single connection is all the migrator needs, and it lets us close cleanly.
	const client = postgres(url!, { max: 1 });
	try {
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
