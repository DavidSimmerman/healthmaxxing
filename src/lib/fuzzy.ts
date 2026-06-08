// Lightweight fuzzy finder with a recency boost, tuned for the personal
// food-history search. No external dependency — the dataset is small (a few
// hundred distinct foods at most), so we score every item on each keystroke.
//
// Matching is fzf-style subsequence matching: the query characters must appear
// in order in the target, with bonuses for contiguous runs and word-boundary
// starts. On top of the match score we layer a recency multiplier so that,
// among comparable matches, things you've eaten recently float to the top.

const BOUNDARY = /[^a-z0-9]/;

// Subsequence match score. Returns 0 when `query` is not a subsequence of
// `target`; otherwise a normalized score in roughly (0, 1.2]. Both inputs are
// expected lowercased.
export function matchScore(query: string, target: string): number {
	if (!query) return 0;

	let score = 0;
	let prev = -2;
	let ti = 0;

	for (let qi = 0; qi < query.length; qi++) {
		const c = query[qi];
		let found = -1;
		for (; ti < target.length; ti++) {
			if (target[ti] === c) {
				found = ti;
				break;
			}
		}
		if (found === -1) return 0; // not a subsequence — no match

		let charScore = 1;
		if (found === prev + 1) charScore += 3; // contiguous with previous match
		if (found === 0 || BOUNDARY.test(target[found - 1])) charScore += 4; // word start

		score += charScore;
		prev = found;
		ti = found + 1;
	}

	// Normalize against the best achievable per char (~8: boundary + consecutive).
	let norm = score / (query.length * 8);
	// Nudge toward targets the query covers more of ("apple" → "Apple" over
	// "Apple pie crumble") without letting it dominate the match shape.
	norm *= 1 + 0.15 * (query.length / target.length);
	return norm;
}

// Exponential decay weight in (0, 1]. 1 for something logged right now, halving
// every `halfLifeDays`. Accepts an ISO string or a Date.
export function recencyWeight(
	lastLoggedAt: string | Date | null,
	now: number,
	halfLifeDays = 7
): number {
	if (!lastLoggedAt) return 0;
	const t = typeof lastLoggedAt === 'string' ? Date.parse(lastLoggedAt) : lastLoggedAt.getTime();
	if (!Number.isFinite(t)) return 0;
	const days = Math.max(0, (now - t) / 86_400_000);
	return Math.pow(0.5, days / halfLifeDays);
}

// How strongly recency reorders comparable matches. At weight 1 (just logged) a
// match is boosted by up to RECENCY_BOOST; older items keep their raw score.
const RECENCY_BOOST = 0.6;

export type Scored<T> = { item: T; score: number };

// Fuzzy-search `items` by `query`, ranking with a recency boost. `text` pulls
// the primary searchable string; `lastLogged` pulls the freshness anchor.
// `keywords` is an optional secondary field (e.g. categories) matched at a
// reduced weight so it widens coverage without outranking real name matches.
export function fuzzySearch<T>(
	query: string,
	items: readonly T[],
	opts: {
		text: (item: T) => string;
		lastLogged: (item: T) => string | Date | null;
		now: number;
		keywords?: (item: T) => string | null;
		keywordWeight?: number;
		limit?: number;
	}
): Scored<T>[] {
	const q = query.trim().toLowerCase();
	if (!q) return [];

	const kw = opts.keywordWeight ?? 0.5;
	const out: Scored<T>[] = [];
	for (const item of items) {
		let m = matchScore(q, opts.text(item).toLowerCase());
		// Keywords (e.g. categories) are discrete terms, so match by substring
		// rather than subsequence — fuzzy subsequence over a long category list
		// produces scattered false positives ("spread" hitting "...Protein...").
		if (opts.keywords && m < kw) {
			const ktext = opts.keywords(item);
			if (ktext && ktext.toLowerCase().includes(q)) m = kw;
		}
		if (m <= 0) continue;
		const rw = recencyWeight(opts.lastLogged(item), opts.now);
		out.push({ item, score: m * (1 + RECENCY_BOOST * rw) });
	}

	out.sort((a, b) => b.score - a.score);
	return opts.limit ? out.slice(0, opts.limit) : out;
}
