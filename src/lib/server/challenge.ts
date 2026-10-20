import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { bodyComp, settings } from '$lib/server/db/schema';
import { APP_TZ } from '$lib/server/day';
import { isSealed, openSecret, sealSecret, secretBoxEnabled } from '$lib/server/secretBox';
import { recordSync } from '$lib/server/syncStatus';
import { kgToLb } from '$lib/energy';

// Auto-upload of weigh-ins to a friend's weight-loss challenge (the "Dialed" Cloudflare
// worker). Its own page posts `PUT /api/challenges/<id>/weighins` with
// `{ weighins: [{ date, pounds }] }` and `Authorization: Bearer <t>`, where <t> comes from
// the share link's #t= fragment and identifies which side of the challenge you are. We
// replay exactly that request, nothing else.

export type ChallengeLink = { origin: string; id: string; token: string };

// `https://host/c/<id>#t=<token>` → its parts, or null if it isn't that shape.
export function parseChallengeLink(link: string): ChallengeLink | null {
	let u: URL;
	try {
		u = new URL(link.trim());
	} catch {
		return null;
	}
	const id = u.pathname.match(/^\/c\/([A-Za-z0-9_-]+)\/?$/)?.[1];
	const token = new URLSearchParams(u.hash.slice(1)).get('t');
	if (u.protocol !== 'https:' || !id || !token) return null;
	return { origin: u.origin, id, token };
}

export const sealLink = (link: string) => (secretBoxEnabled() ? sealSecret(link) : link);
const openLink = (stored: string) => (isSealed(stored) ? openSecret(stored) : stored);

const localDate = sql<string>`((${bodyComp.measuredAt} at time zone 'UTC' at time zone ${APP_TZ})::date)::text`;

// Send the day's weigh-in for each of `dates` (local YYYY-MM-DD) that's on/after the date the
// link was saved. One number per day: the FIRST weigh-in of the morning, so a second step on
// the scale after breakfast can't replace it. Never throws — a challenge site being down
// must not fail the Apple Health sync that triggered it; the outcome lands on Settings.
export async function pushChallengeWeighins(dates: string[]): Promise<void> {
	try {
		const [s] = await db
			.select({ link: settings.challengeLink, since: settings.challengeSince })
			.from(settings)
			.where(eq(settings.id, 1));
		if (!s?.link) return;
		const link = parseChallengeLink(openLink(s.link));
		if (!link) return recordSync('challenge', false, 'Saved challenge link is not valid');
		const wanted = [...new Set(dates)].filter((d) => !s.since || d >= s.since);
		if (!wanted.length) return;

		const weighins: { date: string; pounds: number }[] = [];
		for (const date of wanted.sort()) {
			const [first] = await db
				.select({ weightKg: bodyComp.weightKg })
				.from(bodyComp)
				.where(and(sql`${localDate} = ${date}`))
				.orderBy(asc(bodyComp.measuredAt))
				.limit(1);
			if (first) weighins.push({ date, pounds: Math.round(kgToLb(first.weightKg) * 10) / 10 });
		}
		if (!weighins.length) return;

		const res = await fetch(`${link.origin}/api/challenges/${link.id}/weighins`, {
			method: 'PUT',
			headers: { authorization: `Bearer ${link.token}`, 'content-type': 'application/json' },
			body: JSON.stringify({ weighins }),
			signal: AbortSignal.timeout(10_000)
		});
		if (!res.ok) {
			const detail = (await res.text().catch(() => '')).slice(0, 120);
			return recordSync(
				'challenge',
				false,
				`Challenge rejected the weigh-in (${res.status}) ${detail}`
			);
		}
		const last = weighins[weighins.length - 1];
		await recordSync('challenge', true, `Sent ${last.pounds} lb for ${last.date}`);
	} catch (e) {
		await recordSync('challenge', false, e instanceof Error ? e.message : 'upload failed');
	}
}
