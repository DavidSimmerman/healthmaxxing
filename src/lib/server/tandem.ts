import { env } from '$env/dynamic/private';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { insulinEvents, pumpGlucose, tandemAuth } from '$lib/server/db/schema';
import { todayLabel } from '$lib/server/day';
import { addDays } from '$lib/energy';

// Tandem t:slim insulin pump → dashboard. Tandem has NO official API, so this
// drives the reverse-engineered Tandem Source event log through a Python sidecar
// (scripts/tandem_sync.py, which reuses tconnectsync's binary parser) and stores
// the resulting intraday insulin trace in insulin_events. Unlike Dexcom's OAuth,
// Tandem Source uses username/password, so we keep the credentials — encrypted
// at rest because it's a reusable account password, not a revocable token.
//
// No daily_metrics rollup: the day chart reads insulin_events directly. (Daily
// TDD/bolus/basal totals would be a separate aggregate — add if ever needed.)

const execFileP = promisify(execFile);

// Enabled only when we have a key to encrypt credentials with — without it we
// can't safely store the password, so the whole integration stays off.
export function tandemEnabled(): boolean {
	return !!env.TANDEM_ENC_KEY;
}

// ── credential encryption (aes-256-gcm) ─────────────────────────────────────
function key(): Buffer {
	if (!env.TANDEM_ENC_KEY) throw new Error('TANDEM_ENC_KEY is not set.');
	return scryptSync(env.TANDEM_ENC_KEY, 'tandem-insulin', 32);
}

function encrypt(plain: string): string {
	const iv = randomBytes(12);
	const c = createCipheriv('aes-256-gcm', key(), iv);
	const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
	return [iv, c.getAuthTag(), ct].map((b) => b.toString('hex')).join(':');
}

function decrypt(blob: string): string {
	const [iv, tag, ct] = blob.split(':').map((h) => Buffer.from(h, 'hex'));
	if (!iv || !tag || !ct) throw new Error('Malformed stored Tandem credential.');
	const d = createDecipheriv('aes-256-gcm', key(), iv);
	d.setAuthTag(tag);
	return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

// ── connect / status ────────────────────────────────────────────────────────
export async function storeCreds(
	username: string,
	password: string,
	region: string
): Promise<void> {
	const reg = region === 'EU' ? 'EU' : 'US';
	const secret = encrypt(`${username}\n${password}`); // newline-joined: passwords can't contain \n on input
	await db
		.insert(tandemAuth)
		.values({ id: 1, username, secret, region: reg })
		.onConflictDoUpdate({
			target: tandemAuth.id,
			set: {
				username: sql`excluded.username`,
				secret: sql`excluded.secret`,
				region: sql`excluded.region`,
				updatedAt: new Date()
			}
		});
}

// Connect flow: store the submitted creds, then verify them by pulling a few
// days. If the verify sync fails (wrong password/region), roll back to the
// previous credentials — a failed reconnect must not clobber a working one, nor
// leave a bad row that the cron then keeps using.
export async function connectAndVerify(
	username: string,
	password: string,
	region: string
): Promise<{ days: number; events: number; glucose: number }> {
	const [prev] = await db.select().from(tandemAuth).where(eq(tandemAuth.id, 1));
	await storeCreds(username, password, region);
	try {
		return await syncInsulin(3);
	} catch (e) {
		if (prev) {
			await db
				.update(tandemAuth)
				.set({
					username: prev.username,
					secret: prev.secret,
					region: prev.region,
					updatedAt: new Date()
				})
				.where(eq(tandemAuth.id, 1));
		} else {
			await db.delete(tandemAuth).where(eq(tandemAuth.id, 1));
		}
		throw e;
	}
}

export async function tandemConnected(): Promise<boolean> {
	const [row] = await db.select({ id: tandemAuth.id }).from(tandemAuth).where(eq(tandemAuth.id, 1));
	return !!row;
}

async function creds(): Promise<{ email: string; password: string; region: string }> {
	const [row] = await db.select().from(tandemAuth).where(eq(tandemAuth.id, 1));
	if (!row)
		throw new Error(
			'Tandem not connected on this server. While logged in, connect it from /settings.'
		);
	const [email, password] = decrypt(row.secret).split('\n');
	return { email, password, region: row.region };
}

// ── sidecar ───────────────────────────────────────────────────────────────
type InsulinEvent = {
	at: string;
	date: string;
	kind: 'basal' | 'bolus' | 'cgm';
	units?: number;
	mgdl?: number; // cgm only
	requested?: number;
	bolusType?: string | null;
	carbs?: number | null;
	bg?: number | null;
};
type SidecarOut = { device?: unknown; range?: unknown; events: InsulinEvent[]; error?: string };

const MAX_DAYS = 30;
const clampDays = (d: number) => Math.min(Math.max(Math.floor(d), 1), MAX_DAYS);

// Run the Python sidecar. Credentials go via env (never argv — argv is visible
// in `ps`). Returns the parsed JSON trace; throws with the sidecar's own error.
async function runSidecar(startLabel: string, endLabel: string): Promise<SidecarOut> {
	const { email, password, region } = await creds();
	const python = env.TANDEM_PYTHON || 'python3';
	const script = env.TANDEM_SCRIPT || 'scripts/tandem_sync.py';
	let stdout: string;
	try {
		({ stdout } = await execFileP(python, [script], {
			env: {
				...process.env,
				TANDEM_EMAIL: email,
				TANDEM_PASSWORD: password,
				TANDEM_REGION: region,
				TANDEM_START: startLabel,
				TANDEM_END: endLabel,
				TIMEZONE_NAME: env.APP_TZ || 'America/New_York'
			},
			maxBuffer: 32 * 1024 * 1024,
			timeout: 120_000
		}));
	} catch (e) {
		// Sidecar exits non-zero on failure but still prints {"error": ...} JSON.
		const out = (e as { stdout?: string }).stdout;
		if (out) {
			try {
				const parsed = JSON.parse(out) as SidecarOut;
				if (parsed.error) throw new Error(`Tandem sync: ${parsed.error}`);
			} catch (inner) {
				if (inner instanceof Error && inner.message.startsWith('Tandem sync:')) throw inner;
			}
		}
		throw new Error(`Tandem sidecar failed: ${(e as Error).message}`);
	}
	const parsed = JSON.parse(stdout) as SidecarOut;
	if (parsed.error) throw new Error(`Tandem sync: ${parsed.error}`);
	return parsed;
}

function* chunk<T>(arr: T[], size: number): Generator<T[]> {
	for (let i = 0; i < arr.length; i += size) yield arr.slice(i, i + size);
}

export async function syncInsulin(
	days = 3
): Promise<{ days: number; events: number; glucose: number }> {
	const endLabel = todayLabel();
	const startLabel = addDays(endLabel, -clampDays(days));
	const { events } = await runSidecar(startLabel, endLabel);

	// Insulin (basal/bolus) → insulin_events; pump CGM → its own pump_glucose
	// table (kept separate from Dexcom's glucose_readings, see schema note).
	// Dedupe by the table's conflict key first: the pump can emit two rows at the
	// same timestamp (e.g. a backfill + realtime CGM reading), and Postgres rejects
	// a batched ON CONFLICT that touches the same key twice. Map keeps the last.
	const rows = [
		...new Map(
			events
				.filter((e) => e.kind === 'basal' || e.kind === 'bolus')
				.map((e) => [
					`${e.at}|${e.kind}`,
					{
						at: new Date(e.at),
						date: e.date,
						kind: e.kind,
						units: e.units ?? 0,
						bolusType: e.bolusType ?? null,
						carbs: e.carbs ?? null,
						bg: e.bg ?? null,
						requested: e.requested ?? null
					}
				])
		).values()
	];

	for (const part of chunk(rows, 500)) {
		await db
			.insert(insulinEvents)
			.values(part)
			.onConflictDoUpdate({
				target: [insulinEvents.at, insulinEvents.kind],
				set: {
					date: sql`excluded.date`,
					units: sql`excluded.units`,
					bolusType: sql`excluded.bolus_type`,
					carbs: sql`excluded.carbs`,
					bg: sql`excluded.bg`,
					requested: sql`excluded.requested`
				}
			});
	}

	const cgm = [
		...new Map(
			events
				.filter((e) => e.kind === 'cgm' && typeof e.mgdl === 'number')
				.map((e) => [e.at, { at: new Date(e.at), date: e.date, mgdl: e.mgdl as number }])
		).values()
	];

	for (const part of chunk(cgm, 500)) {
		await db
			.insert(pumpGlucose)
			.values(part)
			.onConflictDoUpdate({
				target: pumpGlucose.at,
				set: { date: sql`excluded.date`, mgdl: sql`excluded.mgdl` }
			});
	}

	const dates = new Set([...rows, ...cgm].map((r) => r.date));
	return { days: dates.size, events: rows.length, glucose: cgm.length };
}

// Debug: raw sidecar JSON without writing — confirm the trace against an account.
export async function peekInsulin(days = 2): Promise<SidecarOut> {
	const endLabel = todayLabel();
	const startLabel = addDays(endLabel, -clampDays(days));
	return runSidecar(startLabel, endLabel);
}
