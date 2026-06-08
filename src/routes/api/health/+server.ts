import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { sql } from 'drizzle-orm';

// GET /api/health — liveness + DB reachability for Coolify's healthcheck.
export async function GET() {
	try {
		await db.execute(sql`select 1`);
		return json({ status: 'ok', db: 'up' });
	} catch {
		return json({ status: 'degraded', db: 'down' }, { status: 503 });
	}
}
