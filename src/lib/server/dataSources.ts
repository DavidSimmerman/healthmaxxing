import { db } from './db';
import { foods, dailyLog, bodyComp, activityDays, workouts, dailyMetrics } from './db/schema';
import { desc, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';

// Backs the temporary /data viewer: a flat map of which tables belong to which
// data source. Adding a table here is all it takes to surface it.

type TableSpec = {
	key: string;
	label: string;
	table: PgTable;
	orderBy: PgColumn; // sorted newest-first by this column
};

export const SOURCES = {
	macros: {
		label: 'Healthmaxxing Macros',
		tables: [
			{ key: 'log', label: 'Food log', table: dailyLog, orderBy: dailyLog.loggedAt },
			{ key: 'foods', label: 'Food catalog', table: foods, orderBy: foods.createdAt }
		]
	},
	healthkit: {
		label: 'HealthKit',
		tables: [
			{ key: 'weigh_ins', label: 'Weigh-ins', table: bodyComp, orderBy: bodyComp.measuredAt },
			{ key: 'activity', label: 'Activity days', table: activityDays, orderBy: activityDays.date },
			{ key: 'workouts', label: 'Workouts', table: workouts, orderBy: workouts.startedAt },
			{ key: 'metrics', label: 'Daily metrics', table: dailyMetrics, orderBy: dailyMetrics.date }
		]
	}
} satisfies Record<string, { label: string; tables: TableSpec[] }>;

export type SourceKey = keyof typeof SOURCES;

export function isSourceKey(s: string): s is SourceKey {
	return Object.hasOwn(SOURCES, s);
}

const ROW_LIMIT = 200;

async function countRows(table: PgTable): Promise<number> {
	const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(table);
	return row?.n ?? 0;
}

// Total row count across every table of a source — for the source list.
export async function sourceTotals(): Promise<Record<SourceKey, number>> {
	const out = {} as Record<SourceKey, number>;
	for (const key of Object.keys(SOURCES) as SourceKey[]) {
		const counts = await Promise.all(SOURCES[key].tables.map((t) => countRows(t.table)));
		out[key] = counts.reduce((a, b) => a + b, 0);
	}
	return out;
}

// Per-table count + most recent rows for one source — for the detail page.
export async function sourceTables(key: SourceKey) {
	return Promise.all(
		SOURCES[key].tables.map(async (t) => {
			const [count, rows] = await Promise.all([
				countRows(t.table),
				db.select().from(t.table).orderBy(desc(t.orderBy)).limit(ROW_LIMIT) as Promise<
					Record<string, unknown>[]
				>
			]);
			return { key: t.key, label: t.label, count, rows, limit: ROW_LIMIT };
		})
	);
}
