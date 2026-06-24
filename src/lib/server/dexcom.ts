import { env } from '$env/dynamic/private';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { eq, sql, inArray } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { dailyMetrics, dexcomAuth, glucoseReadings } from '$lib/server/db/schema';
import { todayLabel } from '$lib/server/day';
import { addDays } from '$lib/energy';
import { glucoseStats } from '$lib/glucose';

// Dexcom CGM → dashboard, via the official Dexcom v3 API (OAuth 2.0). We pull the
// EGV trace (every ~5 min) into glucose_readings, and roll each day up into
// daily_metrics (blood_glucose_mgdl avg, glucose_tir_pct, glucose_gmi_pct) so the
// existing vitals/MCP surface shows it. One-time auth via the authorize/callback
// routes; a cron POSTs .../dexcom/sync. Sandbox returns FAKE data — real glucose
// needs Dexcom "Limited"/Commercial production access; flip DEXCOM_API_BASE to prod.
//
// Insulin/pump data is NOT here: Tandem has no official API, and Dexcom's /events
// only has user-entered insulin (not pump auto-boluses). Deferred by design.

// Sandbox by default so a misconfig can't accidentally hit production.
const BASE = (env.DEXCOM_API_BASE || 'https://sandbox-api.dexcom.com').replace(/\/$/, '');
// OAuth endpoints are v3 per the current official docs (developer.dexcom.com →
// Authentication), same as the v3 EGV API. Dexcom historically used /v2/oauth2/*
// (still aliased) — if authorization ever 404s, try v2 here.
const AUTH_URL = `${BASE}/v3/oauth2/login`;
const TOKEN_URL = `${BASE}/v3/oauth2/token`;
const SCOPE = 'offline_access'; // the only scope Dexcom accepts

export function dexcomEnabled(): boolean {
	return !!(env.DEXCOM_CLIENT_ID && env.DEXCOM_CLIENT_SECRET);
}

// CSRF state for the OAuth round-trip: an HMAC of the secret API token, so it
// proves the flow started from us without putting the token in the redirect URL.
export function oauthState(): string {
	return createHmac('sha256', env.API_TOKEN ?? '')
		.update('dexcom-oauth')
		.digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

export function authorizeUrl(redirectUri: string): string {
	const p = new URLSearchParams({
		client_id: env.DEXCOM_CLIENT_ID ?? '',
		redirect_uri: redirectUri,
		response_type: 'code',
		scope: SCOPE,
		state: oauthState()
	});
	return `${AUTH_URL}?${p}`;
}

async function tokenRequest(params: Record<string, string>): Promise<{
	access_token: string;
	refresh_token?: string;
	expires_in?: number;
}> {
	const res = await fetch(TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: env.DEXCOM_CLIENT_ID ?? '',
			client_secret: env.DEXCOM_CLIENT_SECRET ?? '',
			...params
		})
	});
	if (!res.ok) {
		const detail = (await res.text().catch(() => '')).slice(0, 200);
		throw new Error(`Dexcom token request failed (${res.status}): ${detail}`);
	}
	return res.json();
}

async function storeRefresh(refreshToken: string): Promise<void> {
	await db
		.insert(dexcomAuth)
		.values({ id: 1, refreshToken })
		.onConflictDoUpdate({
			target: dexcomAuth.id,
			set: { refreshToken: sql`excluded.refresh_token`, updatedAt: new Date() }
		});
}

// One-time: exchange the authorization code for tokens and persist the refresh token.
export async function exchangeCode(code: string, redirectUri: string): Promise<void> {
	const tok = await tokenRequest({
		grant_type: 'authorization_code',
		code,
		redirect_uri: redirectUri
	});
	if (!tok.refresh_token) throw new Error('Dexcom did not return a refresh token.');
	await storeRefresh(tok.refresh_token);
}

// Refresh → fresh access token. Dexcom ROTATES the refresh token on every use, so
// we ALWAYS persist the new one (a missed rotation locks us out → re-auth).
async function accessToken(): Promise<string> {
	const [row] = await db.select().from(dexcomAuth).where(eq(dexcomAuth.id, 1));
	if (!row)
		throw new Error(
			'Dexcom not connected on this server. While logged in, open /api/integrations/dexcom/authorize to link it.'
		);
	const tok = await tokenRequest({ grant_type: 'refresh_token', refresh_token: row.refreshToken });
	if (!tok.refresh_token) throw new Error('Dexcom refresh did not return a new refresh token.');
	await storeRefresh(tok.refresh_token);
	return tok.access_token;
}

// Dexcom EGV record (the fields we use). value is null on sensor gaps/warmup.
type EgvRecord = {
	systemTime?: string; // UTC, e.g. '2026-06-24T00:00:00' (no zone suffix)
	displayTime?: string; // device-local wall clock, e.g. '2026-06-23T20:00:00'
	value?: number | null; // mg/dL
	trend?: string | null;
};

// systemTime is documented UTC but ships without a zone — force UTC parsing
// unless Dexcom ever starts sending an explicit 'Z' or ±hh:mm offset.
export function asUtc(s: string): Date {
	return new Date(/(Z|[+-]\d\d:?\d\d)$/.test(s) ? s : `${s}Z`);
}

// Dexcom rejects (400) any window > 30 days. We start at 00:00:00 and end at
// 23:59:59, so the span is days + ~1 day — cap `days` at 29 to stay ≤ 30.
const MAX_WINDOW_DAYS = 29;
const clampDays = (days: number) => Math.min(Math.max(Math.floor(days), 1), MAX_WINDOW_DAYS);

// Dexcom wants naive ISO 8601 (no zone).
function egvUrl(startLabel: string, endLabel: string): string {
	const p = new URLSearchParams({
		startDate: `${startLabel}T00:00:00`,
		endDate: `${endLabel}T23:59:59`
	});
	return `${BASE}/v3/users/self/egvs?${p}`;
}

function* chunk<T>(arr: T[], size: number): Generator<T[]> {
	for (let i = 0; i < arr.length; i += size) yield arr.slice(i, i + size);
}

export async function syncGlucose(days = 3): Promise<{ days: number; readings: number }> {
	const token = await accessToken();
	const endLabel = todayLabel();
	const startLabel = addDays(endLabel, -clampDays(days));

	const res = await fetch(egvUrl(startLabel, endLabel), {
		headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
	});
	if (!res.ok) {
		const detail = (await res.text().catch(() => '')).slice(0, 200);
		throw new Error(`Dexcom EGV fetch failed (${res.status}): ${detail}`);
	}
	const body = (await res.json()) as { records?: EgvRecord[] };
	const rows = (body.records ?? [])
		.filter((r) => r.systemTime && r.displayTime && typeof r.value === 'number')
		.map((r) => ({
			at: asUtc(r.systemTime as string),
			date: (r.displayTime as string).slice(0, 10), // local day
			mgdl: r.value as number,
			trend: r.trend ?? null
		}));

	for (const part of chunk(rows, 500)) {
		await db
			.insert(glucoseReadings)
			.values(part)
			.onConflictDoUpdate({
				target: glucoseReadings.at,
				set: {
					date: sql`excluded.date`,
					mgdl: sql`excluded.mgdl`,
					trend: sql`excluded.trend`
				}
			});
	}

	// Roll each affected day up from ALL its stored readings (not just this window,
	// so a partial-day sync doesn't under-count) into daily_metrics.
	const dates = [...new Set(rows.map((r) => r.date))];
	if (dates.length) await rollUpDays(dates);

	return { days: dates.length, readings: rows.length };
}

async function rollUpDays(dates: string[]): Promise<void> {
	const stored = await db
		.select({ date: glucoseReadings.date, mgdl: glucoseReadings.mgdl })
		.from(glucoseReadings)
		.where(inArray(glucoseReadings.date, dates));

	const byDate = new Map<string, number[]>();
	for (const r of stored) {
		const arr = byDate.get(r.date) ?? [];
		arr.push(r.mgdl);
		byDate.set(r.date, arr);
	}

	const metrics: { date: string; metric: string; value: number }[] = [];
	for (const [date, vals] of byDate) {
		const s = glucoseStats(vals);
		if (!s) continue;
		metrics.push({ date, metric: 'blood_glucose_mgdl', value: Math.round(s.avgMgdl) });
		metrics.push({ date, metric: 'glucose_tir_pct', value: Math.round(s.tirPct) });
		metrics.push({ date, metric: 'glucose_gmi_pct', value: Math.round(s.gmiPct * 10) / 10 });
	}
	if (!metrics.length) return;
	await db
		.insert(dailyMetrics)
		.values(metrics)
		.onConflictDoUpdate({
			target: [dailyMetrics.date, dailyMetrics.metric],
			set: { value: sql`excluded.value`, updatedAt: new Date() }
		});
}

// Debug: raw status + body, so the live EGV schema can be confirmed against the
// sandbox/account before trusting the parser (mirrors fitbit's peekHealth).
export async function peekGlucose(days = 2): Promise<unknown> {
	const token = await accessToken();
	const endLabel = todayLabel();
	const startLabel = addDays(endLabel, -clampDays(days));
	const url = egvUrl(startLabel, endLabel);
	const res = await fetch(url, {
		headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
	});
	const text = await res.text().catch(() => '');
	let parsed: unknown = text;
	try {
		parsed = JSON.parse(text);
	} catch {
		/* leave as text (e.g. an HTML error page) */
	}
	return { status: res.status, url, body: parsed };
}
