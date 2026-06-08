import { json, type Handle } from '@sveltejs/kit';
import { authEnabled, sessionValid, SESSION_COOKIE } from '$lib/server/session';
import { apiTokenOk } from '$lib/server/auth';

// Paths that participate in the OAuth + MCP flow and need permissive CORS so
// Claude.ai (web) can complete discovery, registration, and token exchange.
const CORS_PREFIXES = ['/mcp', '/token', '/register', '/authorize', '/.well-known/'];

// Paths exempt from the first-party session gate: the login/logout pages, the
// Claude connector flow (own auth), and the health check.
function isPublicPath(pathname: string): boolean {
	return (
		pathname === '/login' ||
		pathname === '/logout' ||
		pathname === '/authorize' ||
		pathname === '/token' ||
		pathname === '/register' ||
		pathname === '/mcp' ||
		pathname === '/api/health' ||
		pathname.startsWith('/.well-known/')
	);
}

function needsCors(pathname: string): boolean {
	return CORS_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}

function applyCors(response: Response, origin: string | null): Response {
	response.headers.set('Access-Control-Allow-Origin', origin ?? '*');
	response.headers.append('Vary', 'Origin');
	response.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
	response.headers.set(
		'Access-Control-Allow-Headers',
		'authorization, content-type, mcp-protocol-version, mcp-session-id'
	);
	// So a browser MCP client can read the OAuth challenge on the 401 from /mcp
	// and kick off discovery (non-safelisted response headers are hidden otherwise).
	response.headers.set('Access-Control-Expose-Headers', 'WWW-Authenticate');
	response.headers.set('Access-Control-Max-Age', '86400');
	return response;
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function isFormContentType(request: Request): boolean {
	const ct = (request.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
	return (
		ct === 'application/x-www-form-urlencoded' ||
		ct === 'multipart/form-data' ||
		ct === 'text/plain'
	);
}

export const handle: Handle = async ({ event, resolve }) => {
	const { pathname, origin } = event.url;
	const reqOrigin = event.request.headers.get('origin');

	// OAuth 2.0 Protected Resource Metadata (RFC 9728) — tells Claude.ai which
	// authorization server guards /mcp.
	if (pathname === '/.well-known/oauth-protected-resource') {
		return applyCors(
			json({ resource: `${origin}/mcp`, authorization_servers: [origin] }),
			reqOrigin
		);
	}

	// OAuth 2.0 Authorization Server Metadata (RFC 8414).
	if (pathname === '/.well-known/oauth-authorization-server') {
		return applyCors(
			json({
				issuer: origin,
				authorization_endpoint: `${origin}/authorize`,
				token_endpoint: `${origin}/token`,
				registration_endpoint: `${origin}/register`,
				response_types_supported: ['code'],
				response_modes_supported: ['query'],
				grant_types_supported: ['authorization_code', 'refresh_token'],
				code_challenge_methods_supported: ['S256'],
				token_endpoint_auth_methods_supported: ['none']
			}),
			reqOrigin
		);
	}

	// CORS preflight for the flow endpoints.
	if (event.request.method === 'OPTIONS' && needsCors(pathname)) {
		return applyCors(new Response(null, { status: 204 }), reqOrigin);
	}

	// Re-implement SvelteKit's CSRF same-origin check (disabled in svelte.config
	// so /token can take cross-origin OAuth posts). /token is exempt — its
	// security is the single-use code + PKCE verifier, not the Origin header.
	if (
		UNSAFE_METHODS.has(event.request.method) &&
		pathname !== '/token' &&
		isFormContentType(event.request) &&
		reqOrigin !== origin
	) {
		return new Response('Cross-site form submission forbidden', { status: 403 });
	}

	// First-party auth gate. When a password is configured, everything outside
	// the public set needs a valid session cookie — or, for /api/* (Claude Code),
	// a valid Bearer API token. Page requests without it redirect to /login.
	if (authEnabled() && !isPublicPath(pathname)) {
		const ok =
			sessionValid(event.cookies.get(SESSION_COOKIE)) ||
			(pathname.startsWith('/api/') && apiTokenOk(event.request));
		if (!ok) {
			if (pathname.startsWith('/api/')) {
				return new Response('Unauthorized', { status: 401 });
			}
			const to = encodeURIComponent(pathname + event.url.search);
			return new Response(null, { status: 303, headers: { location: `/login?redirect=${to}` } });
		}
	}

	const response = await resolve(event);
	if (needsCors(pathname)) return applyCors(response, reqOrigin);
	return response;
};
