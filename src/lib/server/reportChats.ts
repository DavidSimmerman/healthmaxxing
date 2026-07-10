import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { chats, settings, type ChatMessage } from '$lib/server/db/schema';
import { todayLabel } from '$lib/server/day';
import { addDays } from '$lib/energy';
import { generateInsight } from '$lib/server/agent';

export type ReportKind = 'daily' | 'weekly' | 'monthly';

// Built-in instruction bodies for the scheduled report chats. Overridable per
// cadence via settings.<kind>ReportPrompt (null/blank = use these).
export const DEFAULT_REPORT_PROMPTS: Record<ReportKind, string> = {
	daily:
		'Review the last 3 days with special focus on yesterday: nutrition (calories/protein/carbs vs targets), ' +
		'glucose control (GMI, time-in-range, lows/highs), activity/steps/exercise, sleep quality, weight trend, ' +
		'and goal scores. Call out what went well, what slipped, and the 1-3 most useful adjustments for today. ' +
		'Flag anything that looks like an emerging issue.',
	weekly:
		'Take a deeper look at the full past week: nutrition adherence, glucose control (GMI, time-in-range, ' +
		'variability), activity and exercise volume, sleep quality and consistency, weight trend, and goal ' +
		'scores/streaks. Look for patterns across days — weekday vs weekend differences, days that went off ' +
		'track and what preceded them, and habits that held or slipped as the week went on. Note any correlations ' +
		'worth calling out, like late meals and overnight glucose, or short sleep and next-day eating. Compare ' +
		'this week to recent weeks: is adherence trending up or down? Finish with a specific, realistic plan for ' +
		'next week — 2-4 concrete focus points, not a generic pep talk.',
	monthly:
		'Do a full deep-dive review of the calendar month. Cover trajectory versus goals: weight and ' +
		'body-composition trend, average daily deficit, glucose statistics (monthly GMI, time-in-range, ' +
		'lows/highs), nutrition averages vs targets, activity and exercise totals, and sleep quality. Identify ' +
		'habits that formed or broke over the month, and how goal scores and streaks evolved week by week. Call ' +
		'out the biggest wins and the biggest risks or regressions. Zoom out: at the current pace, where do the ' +
		'trends lead over the next 2-3 months? Close with strategic recommendations for next month — what to ' +
		'keep, what to change, and one or two measurable targets to aim for.'
};

const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

// APP_TZ-safe pretty dates: dateLabels are already APP_TZ days, so format the
// noon-UTC instant in UTC — never crosses a day boundary.
const noonUtc = (d: string) => new Date(`${d}T12:00:00Z`);
const fmtMD = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
const fmtMonth = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long' });

function reportTitle(kind: ReportKind, from: string, to: string, today: string): string {
	if (kind === 'daily') return `Daily report — ${fmtMD.format(noonUtc(today))}`;
	if (kind === 'monthly') return `Monthly report — ${fmtMonth.format(noonUtc(from))}`;
	const sameMonth = from.slice(0, 7) === to.slice(0, 7);
	return sameMonth
		? `Weekly report — ${fmtMD.format(noonUtc(from))}–${noonUtc(to).getUTCDate()}`
		: `Weekly report — ${fmtMD.format(noonUtc(from))} – ${fmtMD.format(noonUtc(to))}`;
}

// The analysis window [from..to], inclusive YYYY-MM-DD.
function reportSpan(kind: ReportKind, today: string): { from: string; to: string } {
	if (kind === 'daily') return { from: addDays(today, -3), to: today };
	if (kind === 'weekly') return { from: addDays(today, -7), to: addDays(today, -1) };
	const [y, m] = today.split('-').map(Number); // previous calendar month
	const py = m === 1 ? y - 1 : y;
	const pm = m === 1 ? 12 : m - 1;
	const last = new Date(Date.UTC(y, m - 1, 0)).getUTCDate(); // day 0 of this month
	const mm = String(pm).padStart(2, '0');
	return { from: `${py}-${mm}-01`, to: `${py}-${mm}-${String(last).padStart(2, '0')}` };
}

// Last 2 completed reports of the same kind + the user's replies, so the model
// can follow up instead of repeating itself.
async function priorContext(kind: ReportKind, today: string): Promise<string> {
	const prior = await db
		.select({ dateLabel: chats.dateLabel, messages: chats.messages })
		.from(chats)
		.where(
			and(
				eq(chats.kind, kind),
				lt(chats.dateLabel, today),
				sql`jsonb_array_length(${chats.messages}) > 0`
			)
		)
		.orderBy(desc(chats.dateLabel))
		.limit(2);
	return prior
		.reverse() // oldest first reads chronologically
		.map((r) => {
			const lines = [`Previous ${kind} report (${r.dateLabel}):`];
			let seenReport = false;
			for (const m of r.messages as ChatMessage[]) {
				if (m.role === 'action') continue;
				if (!seenReport) {
					if (m.role === 'assistant') {
						lines.push(trunc(m.text, 1500));
						seenReport = true;
					}
				} else if (m.role === 'user') lines.push(`User replied: ${trunc(m.text, 400)}`);
				else lines.push(`You followed up: ${trunc(m.text, 400)}`);
			}
			return seenReport ? lines.join('\n') : '';
		})
		.filter(Boolean)
		.join('\n\n');
}

async function buildPrompt(kind: ReportKind, from: string, to: string, today: string) {
	const [cfg] = await db.select().from(settings).where(eq(settings.id, 1));
	const custom = (
		kind === 'daily'
			? cfg?.dailyReportPrompt
			: kind === 'weekly'
				? cfg?.weeklyReportPrompt
				: cfg?.monthlyReportPrompt
	)?.trim();
	const parts = [
		custom || DEFAULT_REPORT_PROMPTS[kind],
		`Analysis window: ${from}..${to} (today is ${today}). Use the health MCP tools to pull real data ` +
			'for the window (get_goal_report for goal scores/streaks, get_energy_ledger, get_nutrition, ' +
			'get_day_log, get_health_metrics for sleep/activity/glucose incl. glucose_gmi_pct and ' +
			'glucose_tir_pct, get_body_trends).'
	];
	// Settings → Notes is the user's standing context (supplements, open questions); the
	// settings UI promises it reaches the scheduled review, so pass it explicitly.
	const notes = cfg?.notes?.trim();
	if (notes) {
		parts.push(
			`The user's standing notes from Settings (supplements, context, questions they want ` +
				`considered):\n${trunc(notes, 2000)}`
		);
	}
	const history = await priorContext(kind, today);
	if (history) {
		parts.push(
			`Your previous ${kind} reports and the user's replies are below — do NOT repeat the same ` +
				'observations or advice unless still important (say so briefly if it is); acknowledge and ' +
				'follow up on anything the user replied.\n\n' +
				history
		);
	}
	parts.push(
		'FORMAT: plain conversational text for a chat bubble — short paragraphs, an emoji or two as ' +
			'section markers if helpful, NO markdown syntax (no #, no **, no tables). Lead with the single ' +
			'most important takeaway. Keep daily ≤300 words; weekly ≤500; monthly ≤800.'
	);
	return parts.join('\n\n');
}

// Generate today's report chat of `kind`. Claims the (kind, dateLabel) slot via
// the partial unique index first, so concurrent generators (old container during
// a rolling deploy, scheduler + manual run) collapse to one. `wait: false`
// returns right after the claim and fills in the background.
export async function generateReportChat(
	kind: ReportKind,
	opts?: { wait?: boolean }
): Promise<'created' | 'exists' | 'failed'> {
	const today = todayLabel();
	const { from, to } = reportSpan(kind, today);
	const claimed = await db
		.insert(chats)
		.values({
			title: reportTitle(kind, from, to, today),
			kind,
			dateLabel: today,
			unread: false,
			messages: []
		})
		.onConflictDoNothing()
		.returning({ id: chats.id });
	if (!claimed.length) return 'exists'; // another tick/container got it
	const id = claimed[0].id;

	// Never throws — a failure releases the claim so the next tick retries.
	const fill = async (): Promise<'created' | 'failed'> => {
		try {
			const text = await generateInsight(await buildPrompt(kind, from, to, today));
			await db
				.update(chats)
				.set({ messages: [{ role: 'assistant', text }], unread: true, updatedAt: new Date() })
				.where(eq(chats.id, id));
			return 'created';
		} catch (e) {
			console.error(`[reports] ${kind} report generation failed (claim released):`, e);
			await db
				.delete(chats)
				.where(eq(chats.id, id))
				.catch((e2) => console.error('[reports] claim release failed:', e2));
			return 'failed';
		}
	};
	if (opts?.wait === false) {
		void fill();
		return 'created';
	}
	return fill();
}

// A generator that crashed between claim and fill leaves an empty row that the
// unique index would let block the whole day — sweep claims older than 15 min.
export async function sweepAbandonedReportClaims(): Promise<void> {
	await db
		.delete(chats)
		.where(
			sql`${chats.kind} <> 'chat' and ${chats.messages} = '[]'::jsonb and ${chats.updatedAt} < now() - interval '15 minutes'`
		);
}
