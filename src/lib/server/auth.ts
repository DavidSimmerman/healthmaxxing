import { env } from '$env/dynamic/private';
import { error } from '@sveltejs/kit';
import { timingSafeEqual } from 'node:crypto';

// Used to guard the /api/foods + /api/today endpoints that Claude Code hits.
// The in-app same-origin calls (POST /api/log etc) don't go through this.
export function requireApiToken(request: Request): void {
	const token = env.API_TOKEN;
	if (!token) return; // dev convenience: if unset, allow
	const header = request.headers.get('authorization') ?? '';
	const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
	if (provided !== token) throw error(401, 'Unauthorized');
}

// Boolean form for the auth gate: true only when a token IS configured and the
// request presents it. Unlike requireApiToken, an unset token returns false —
// "no token configured" means the bearer path can't authenticate anyone.
export function apiTokenOk(request: Request): boolean {
	const token = env.API_TOKEN;
	if (!token) return false;
	const header = request.headers.get('authorization') ?? '';
	const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
	if (!provided) return false;
	const a = Buffer.from(provided);
	const b = Buffer.from(token);
	return a.length === b.length && timingSafeEqual(a, b);
}
