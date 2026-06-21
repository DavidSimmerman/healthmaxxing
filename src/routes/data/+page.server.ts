import { SOURCES, sourceTotals, type SourceKey } from '$lib/server/dataSources';

export async function load() {
	const totals = await sourceTotals();
	const sources = (Object.keys(SOURCES) as SourceKey[]).map((key) => ({
		key,
		label: SOURCES[key].label,
		tables: SOURCES[key].tables.map((t) => t.label),
		total: totals[key]
	}));
	return { sources };
}
