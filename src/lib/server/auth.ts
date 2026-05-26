import { env } from '$env/dynamic/private';
import { error } from '@sveltejs/kit';

// Used to guard the /api/foods/* + /api/pending endpoints that Claude Code hits.
// The in-app same-origin calls (POST /api/log etc) don't go through this.
export function requireApiToken(request: Request): void {
	const token = env.API_TOKEN;
	if (!token) return; // dev convenience: if unset, allow
	const header = request.headers.get('authorization') ?? '';
	const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
	if (provided !== token) throw error(401, 'Unauthorized');
}
