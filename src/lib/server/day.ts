import { sql } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { dailyLog } from './db/schema';

// The calendar day that defines "today". `logged_at` is stored as a UTC
// wall-clock `timestamp` (the DB runs in UTC and the column has no time zone),
// so a naive server-local day boundary buckets entries by the *UTC* day — which
// drops a US user's afternoon entries once it passes midnight UTC. We instead
// reinterpret logged_at as UTC, convert to this zone, and bucket by its date.
// Postgres handles DST. Override with the APP_TZ env var.
export const APP_TZ = env.APP_TZ || 'America/New_York';

// Drizzle predicate selecting dailyLog rows whose loggedAt is "today" in APP_TZ.
export function loggedToday() {
	return sql`(${dailyLog.loggedAt} at time zone 'UTC' at time zone ${APP_TZ})::date = (now() at time zone ${APP_TZ})::date`;
}

// Today's date label (YYYY-MM-DD) in APP_TZ.
export function todayLabel(now = new Date()): string {
	return new Intl.DateTimeFormat('en-CA', { timeZone: APP_TZ }).format(now);
}
