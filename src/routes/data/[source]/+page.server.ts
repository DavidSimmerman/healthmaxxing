import { error } from '@sveltejs/kit';
import { SOURCES, sourceTables, isSourceKey } from '$lib/server/dataSources';

export async function load({ params }) {
	if (!isSourceKey(params.source)) throw error(404, 'Unknown data source');
	const tables = await sourceTables(params.source);
	return { label: SOURCES[params.source].label, tables };
}
