// UUID shape guard for `[id]`-style route params and body ids: a malformed id
// becomes a clean 404 instead of a Postgres uuid-cast 500. Mirrors the check in
// routes/mcp/+server.ts.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
