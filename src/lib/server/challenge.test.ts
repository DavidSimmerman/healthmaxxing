import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { parseChallengeLink } from './challenge';

describe('parseChallengeLink', () => {
	it('splits a share link into origin, id and token', () => {
		expect(parseChallengeLink('https://x.workers.dev/c/abc123#t=tok456')).toEqual({
			origin: 'https://x.workers.dev',
			id: 'abc123',
			token: 'tok456'
		});
	});
	it('rejects links without a token or not over https', () => {
		expect(parseChallengeLink('https://x.workers.dev/c/abc123')).toBeNull();
		expect(parseChallengeLink('http://x.workers.dev/c/abc123#t=tok')).toBeNull();
		expect(parseChallengeLink('not a link')).toBeNull();
	});
});

// The upload against a real database, with the challenge site faked at fetch() — nothing
// leaves the machine. Writes weigh-ins and the settings link, so it only runs against an
// EMPTY database (no weigh-ins). Skipped without DATABASE_URL.
const url = process.env.DATABASE_URL;

describe.skipIf(!url)('pushChallengeWeighins', () => {
	let sql: any; // eslint-disable-line @typescript-eslint/no-explicit-any
	let empty = false;
	let today = '';
	const sent: { url: string; auth: string | null; body: unknown }[] = [];
	let status = 200;

	beforeAll(async () => {
		const { default: postgres } = await import('postgres');
		sql = postgres(url!, { max: 1 });
		empty = Number((await sql`SELECT count(*)::int AS n FROM body_comp`)[0].n) === 0;
		if (!empty) return;
		const { todayLabel } = await import('./day');
		today = todayLabel();
		const { sealLink } = await import('./challenge');
		await sql`INSERT INTO settings (id, challenge_link, challenge_since)
			VALUES (1, ${sealLink('https://dialed.example/c/abc123#t=secret-token')}, ${today})
			ON CONFLICT (id) DO UPDATE SET challenge_link = excluded.challenge_link, challenge_since = excluded.challenge_since`;
		// Today: first weigh-in 74.43 kg (164.1 lb) at 7 AM ET, a heavier one after breakfast.
		// Yesterday: before the link was saved — must never be sent.
		await sql`INSERT INTO body_comp (hk_uuid, measured_at, weight_kg) VALUES
			('m1', ${today + 'T11:00:00Z'}, 74.43),
			('m2', ${today + 'T14:00:00Z'}, 75.2),
			('y1', ${today + 'T11:00:00Z'}::timestamp - interval '1 day', 74.9)`;
		vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
			sent.push({
				url: String(input),
				auth: new Headers(init?.headers).get('authorization'),
				body: JSON.parse(String(init?.body))
			});
			return new Response('{}', { status });
		});
	});

	afterAll(async () => {
		vi.unstubAllGlobals();
		await sql?.end();
	});

	it("sends the day's first weigh-in in pounds, only from the link date on", async () => {
		if (!empty) return;
		const { pushChallengeWeighins } = await import('./challenge');
		const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000)
			.toISOString()
			.slice(0, 10);
		await pushChallengeWeighins([yesterday, today, today]);
		expect(sent).toHaveLength(1);
		expect(sent[0].url).toBe('https://dialed.example/api/challenges/abc123/weighins');
		expect(sent[0].auth).toBe('Bearer secret-token');
		expect(sent[0].body).toEqual({ weighins: [{ date: today, pounds: 164.1 }] });
		const [s] = await sql`SELECT ok, detail FROM sync_status WHERE source = 'challenge'`;
		expect(s.ok).toBe(true);
		// The token is sealed at rest when a key is configured, never stored in the clear then.
		const [row] = await sql`SELECT challenge_link FROM settings WHERE id = 1`;
		if (process.env.TANDEM_ENC_KEY) expect(row.challenge_link).not.toContain('secret-token');
	});

	it('records a rejection instead of throwing', async () => {
		if (!empty) return;
		const { pushChallengeWeighins } = await import('./challenge');
		status = 401;
		await expect(pushChallengeWeighins([today])).resolves.toBeUndefined();
		const [s] = await sql`SELECT ok, detail FROM sync_status WHERE source = 'challenge'`;
		expect(s.ok).toBe(false);
		expect(s.detail).toContain('401');
	});
});
