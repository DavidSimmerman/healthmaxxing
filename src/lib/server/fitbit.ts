import { env } from '$env/dynamic/private';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { dailyMetrics, fitbitAuth, sleepStages } from '$lib/server/db/schema';
import { APP_TZ, todayLabel } from '$lib/server/day';
import { addDays } from '$lib/energy';
import { parseHealthData, parseSleepSessions, type MetricRow } from '$lib/fitbitParse';

// Fitbit (worn at night) → dashboard, via Google's Health API. The legacy Fitbit
// Web API was retired Sept 2026; Google OAuth 2.0 + https://health.googleapis.com
// replace it. We pull sleep + the sleep-derived vitals and store them under
// `sleep_*` keys only — never the Apple (unprefixed) daytime keys. One-time auth
// via the authorize/callback routes; a daily cron POSTs .../fitbit/sync.

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://health.googleapis.com/v4';
const SCOPES = [
	'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
	'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly'
].join(' ');

export function googleHealthEnabled(): boolean {
	return !!(env.GOOGLE_HEALTH_CLIENT_ID && env.GOOGLE_HEALTH_CLIENT_SECRET);
}

// CSRF state for the OAuth round-trip: an HMAC of the secret API token, so it
// proves the flow started from us without putting the token in the redirect URL.
export function oauthState(): string {
	return createHmac('sha256', env.API_TOKEN ?? '')
		.update('fitbit-oauth')
		.digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

export function authorizeUrl(redirectUri: string): string {
	const p = new URLSearchParams({
		client_id: env.GOOGLE_HEALTH_CLIENT_ID ?? '',
		redirect_uri: redirectUri,
		response_type: 'code',
		scope: SCOPES,
		access_type: 'offline', // ask for a refresh token...
		prompt: 'consent', // ...and force one to be issued even on re-auth
		include_granted_scopes: 'true',
		state: oauthState()
	});
	return `${AUTH_URL}?${p}`;
}

async function tokenRequest(params: Record<string, string>): Promise<{
	access_token: string;
	refresh_token?: string;
	scope?: string;
}> {
	const res = await fetch(TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: env.GOOGLE_HEALTH_CLIENT_ID ?? '',
			client_secret: env.GOOGLE_HEALTH_CLIENT_SECRET ?? '',
			...params
		})
	});
	if (!res.ok) {
		const detail = (await res.text().catch(() => '')).slice(0, 200);
		throw new Error(`Google token request failed (${res.status}): ${detail}`);
	}
	return res.json();
}

async function storeRefresh(refreshToken: string, scope: string | undefined): Promise<void> {
	await db
		.insert(fitbitAuth)
		.values({ id: 1, refreshToken, scope: scope ?? null })
		.onConflictDoUpdate({
			target: fitbitAuth.id,
			set: {
				refreshToken: sql`excluded.refresh_token`,
				scope: sql`excluded.scope`,
				updatedAt: new Date()
			}
		});
}

// One-time: exchange the authorization code for tokens and persist the refresh token.
export async function exchangeCode(code: string, redirectUri: string): Promise<void> {
	const tok = await tokenRequest({
		grant_type: 'authorization_code',
		code,
		redirect_uri: redirectUri
	});
	if (!tok.refresh_token) {
		throw new Error(
			'Google did not return a refresh token (re-consent with prompt=consent & access_type=offline).'
		);
	}
	await storeRefresh(tok.refresh_token, tok.scope);
}

// Refresh → fresh access token. Google keeps the refresh token valid (no rotation),
// so we only re-store it on the rare occasion it returns a new one.
async function accessToken(): Promise<string> {
	const [row] = await db.select().from(fitbitAuth).where(eq(fitbitAuth.id, 1));
	if (!row)
		throw new Error(
			'Fitbit not connected on this server. While logged in, open /api/integrations/fitbit/authorize to link it.'
		);
	const tok = await tokenRequest({ grant_type: 'refresh_token', refresh_token: row.refreshToken });
	if (tok.refresh_token && tok.refresh_token !== row.refreshToken) {
		await storeRefresh(tok.refresh_token, tok.scope);
	}
	return tok.access_token;
}

const enc = encodeURIComponent;
function pointsUrl(type: string, filter: string, pageSize: number): string {
	const f = filter ? `&filter=${enc(filter)}` : '';
	return `${API}/users/me/dataTypes/${type}/dataPoints?pageSize=${pageSize}${f}`;
}

// The reads for the window. `daily-*` and the sample types filter by date/time
// (confirmed working). Sleep has no usable date-member filter, so we fetch the
// most recent sessions (pageSize max 25 for sleep) unfiltered and let the
// idempotent upsert sort out the dates — 25 sessions easily covers the window.
function windowUrls(startDate: string): { key: keyof RawWindow; url: string }[] {
	const startIso = `${startDate}T00:00:00Z`;
	return [
		{ key: 'sleep', url: pointsUrl('sleep', '', 25) },
		{
			key: 'restingHr',
			url: pointsUrl(
				'daily-resting-heart-rate',
				`daily_resting_heart_rate.date >= "${startDate}"`,
				100
			)
		},
		{
			key: 'hrv',
			url: pointsUrl(
				'heart-rate-variability',
				`heart_rate_variability.sample_time.physical_time >= "${startIso}"`,
				1440
			)
		},
		{
			key: 'spo2',
			url: pointsUrl(
				'oxygen-saturation',
				`oxygen_saturation.sample_time.physical_time >= "${startIso}"`,
				1440
			)
		},
		{
			key: 'respRate',
			url: pointsUrl('daily-respiratory-rate', `daily_respiratory_rate.date >= "${startDate}"`, 100)
		},
		{
			key: 'skinTemp',
			url: pointsUrl(
				'daily-sleep-temperature-derivations',
				`daily_sleep_temperature_derivations.date >= "${startDate}"`,
				100
			)
		}
	];
}

type RawWindow = {
	sleep?: unknown;
	restingHr?: unknown;
	hrv?: unknown;
	spo2?: unknown;
	respRate?: unknown;
	skinTemp?: unknown;
};

// 4xx (bad scope / unsupported type) and empty → null, so one source can't sink
// the whole sync. (Pagination not implemented — a few nights fit one page; if a
// window ever exceeds pageSize the older points are dropped, which the next sync
// refills.)
async function getJson(url: string, token: string): Promise<unknown> {
	const res = await fetch(url, {
		headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
	});
	if (!res.ok) return null;
	return res.json().catch(() => null);
}

async function fetchWindow(token: string, startDate: string): Promise<RawWindow> {
	const reads = windowUrls(startDate);
	const results = await Promise.all(reads.map((r) => getJson(r.url, token)));
	const out: RawWindow = {};
	reads.forEach((r, i) => (out[r.key] = results[i]));
	return out;
}

export async function syncHealth(days = 3): Promise<{ days: number; metrics: number }> {
	const token = await accessToken();
	const startDate = addDays(todayLabel(), -days);
	const raw = await fetchWindow(token, startDate);
	const rows: MetricRow[] = parseHealthData(raw, APP_TZ);
	if (rows.length) {
		await db
			.insert(dailyMetrics)
			.values(rows)
			.onConflictDoUpdate({
				target: [dailyMetrics.date, dailyMetrics.metric],
				set: { value: sql`excluded.value`, updatedAt: new Date() }
			});
	}

	// Per-night stage timeline (for the hypnogram). The sleep endpoint returns the
	// recent ~25 sessions, so this also backfills history on the first sync.
	const sessions = parseSleepSessions(raw.sleep, APP_TZ);
	if (sessions.length) {
		await db
			.insert(sleepStages)
			.values(
				sessions.map((s) => ({
					date: s.date,
					startAt: new Date(s.startAt),
					endAt: new Date(s.endAt),
					segments: s.segments
				}))
			)
			.onConflictDoUpdate({
				target: sleepStages.date,
				set: {
					startAt: sql`excluded.start_at`,
					endAt: sql`excluded.end_at`,
					segments: sql`excluded.segments`,
					updatedAt: new Date()
				}
			});
	}

	return { days: new Set(rows.map((r) => r.date)).size, metrics: rows.length };
}

// Debug: raw status + body per data type, so the exact response schema / filter
// fields can be confirmed against a live account before trusting the parser.
export async function peekHealth(days = 2): Promise<unknown> {
	const token = await accessToken();
	const startDate = addDays(todayLabel(), -days);
	const reads = windowUrls(startDate);
	return Promise.all(
		reads.map(async (r) => {
			const res = await fetch(r.url, {
				headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
			});
			const body = await res.text().catch(() => '');
			let parsed: unknown = body;
			try {
				parsed = JSON.parse(body);
			} catch {
				/* leave as text (e.g. an HTML error page) */
			}
			return { dataType: r.key, status: res.status, url: r.url, body: parsed };
		})
	);
}
