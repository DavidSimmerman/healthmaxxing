import { error } from '@sveltejs/kit';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { db } from '$lib/server/db';
import { reports } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

// Render the report's markdown to sanitized HTML HERE (server-only) so neither
// marked nor sanitize-html reaches the client bundle. Conservative allowlist —
// no script/style/iframe; links are forced to rel="noopener noreferrer".
const SANITIZE_OPTS: sanitizeHtml.IOptions = {
	allowedTags: [
		'h1',
		'h2',
		'h3',
		'h4',
		'h5',
		'h6',
		'p',
		'ul',
		'ol',
		'li',
		'strong',
		'em',
		'code',
		'pre',
		'blockquote',
		'a',
		'hr',
		'br',
		'table',
		'thead',
		'tbody',
		'tr',
		'th',
		'td'
	],
	// `rel` must be allowed or sanitize-html strips the rel="noopener noreferrer"
	// forced by transformTags below (attribute filtering runs after the transform).
	allowedAttributes: { a: ['href', 'rel'] },
	allowedSchemes: ['http', 'https', 'mailto'],
	transformTags: {
		a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' })
	}
};

// uuid shape — guard before the query so a malformed id is a clean 404 instead of
// a Postgres "invalid input syntax for type uuid" 500.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function load({ params }) {
	if (!UUID_RE.test(params.id)) throw error(404, 'Report not found');
	const [row] = await db.select().from(reports).where(eq(reports.id, params.id)).limit(1);
	if (!row) throw error(404, 'Report not found');

	const rendered = await marked.parse(row.content, { async: true });
	const html = sanitizeHtml(rendered, SANITIZE_OPTS);

	return {
		report: {
			id: row.id,
			title: row.title,
			createdAt: row.createdAt.toISOString(),
			period: row.period,
			rangeFrom: row.rangeFrom,
			rangeTo: row.rangeTo,
			tag: row.tag
		},
		html
	};
}
