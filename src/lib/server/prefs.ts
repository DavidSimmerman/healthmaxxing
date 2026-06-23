import { db } from '$lib/server/db';
import { settings } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import type { FiberMode } from '$lib/netCarbs';

// The fiber mode that governs bolusable-carb derivation. Single-row settings table
// (solo app). Defaults to 'full' (David's standing rule) when unset or unknown.
export async function getFiberMode(): Promise<FiberMode> {
	const [s] = await db
		.select({ fiberMode: settings.fiberMode })
		.from(settings)
		.where(eq(settings.id, 1));
	return s?.fiberMode === 'half_over_5' ? 'half_over_5' : 'full';
}
