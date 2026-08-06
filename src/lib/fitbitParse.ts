// Pure mapping of Google Health API dataPoints → daily_metrics rows. (The Fitbit
// device data is read through Google's Health API — the legacy Fitbit Web API was
// retired Sept 2026.) Kept free of server/$env imports so it's unit-testable
// (see fitbitParse.selfcheck.ts); the caller passes the app timezone.
//
// All metrics are namespaced `sleep_*` so they NEVER collide with the Apple
// (unprefixed) daytime metrics. Two things enforce "Apple takes priority":
//   1. separate keys (sleep_* vs the unprefixed Apple keys), and
//   2. fitPoints() drops every non-FITBIT dataPoint — Google's reconciled stream
//      also serves the user's Apple Health (HEALTH_KIT) data, which we ignore.
// SLEEP is the one exception to (2): the Apple Watch is the backup sleep tracker
// for nights the Fitbit wasn't worn, so the sleep type allows HEALTH_KIT too and
// keeps exactly ONE session per night — the longest, tie → Fitbit. A night never
// draws from two devices, so nothing can be double-counted.
// Field names below are confirmed against live responses (see the sync's
// {"debug":true} mode). Sleep efficiency is computed (minutesAsleep /
// minutesInSleepPeriod) — Fitbit's response carries no efficiency field. Stage
// types are matched by substring (DEEP/REM/LIGHT) so a CLASSIC sleep log degrades
// to just sleep_min without breaking.

export type MetricRow = { date: string; metric: string; value: number };

export type SleepSource = 'fitbit' | 'apple';

export type SleepSession = {
	date: string; // local wake date
	startAt: string; // ISO, sleep start
	endAt: string; // ISO, wake
	source: SleepSource; // which watch recorded this night
	segments: { stage: string; startMin: number; durationMin: number }[];
};

function num(v: unknown): number | null {
	if (typeof v === 'number') return Number.isFinite(v) ? v : null;
	// Google encodes int64 fields (e.g. beatsPerMinute) as JSON strings.
	if (typeof v === 'string' && v.trim() !== '') {
		const n = Number(v);
		return Number.isFinite(n) ? n : null;
	}
	return null;
}

function dig(o: unknown, ...path: (string | number)[]): unknown {
	let cur: unknown = o;
	for (const k of path) {
		if (cur == null) return undefined;
		if (typeof k === 'number') cur = Array.isArray(cur) ? cur[k] : undefined;
		else cur = typeof cur === 'object' ? (cur as Record<string, unknown>)[k] : undefined;
	}
	return cur;
}

// proto Date {year,month,day} → 'YYYY-MM-DD'.
function ymd(d: unknown): string | null {
	const y = dig(d, 'year'),
		m = dig(d, 'month'),
		day = dig(d, 'day');
	if (typeof y === 'number' && typeof m === 'number' && typeof day === 'number') {
		return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
	}
	return null;
}

// RFC-3339 instant → calendar date in the app timezone (so a 1am sample lands on
// the right local day, not the UTC day).
function localDate(instant: unknown, tz: string): string | null {
	if (typeof instant !== 'string') return null;
	const d = new Date(instant);
	if (Number.isNaN(d.getTime())) return null;
	return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d); // en-CA → YYYY-MM-DD
}

// Only Fitbit-platform points. Google's "reconciled" stream ALSO returns the
// user's Apple Health (HEALTH_KIT) data on these data types; we drop it so Apple
// stays exclusively on the unprefixed daytime keys (pulled via HealthKit) and
// Fitbit owns only the sleep_* keys — that's the "Apple takes priority" rule.
function fitPoints(j: unknown, platforms: string[] = ['FITBIT']): unknown[] {
	const dp = dig(j, 'dataPoints');
	if (!Array.isArray(dp)) return [];
	return dp.filter((p) => platforms.includes(String(dig(p, 'dataSource', 'platform'))));
}

// Average a Sample-type's value field per local date (HRV/SpO2 may emit several
// samples a night; we want one nightly number).
function avgSamples(
	pts: unknown[],
	key: string,
	field: string,
	metric: string,
	tz: string,
	floor = -Infinity // drop sub-physiological noise (e.g. SpO2 non-wear reads ~50)
): MetricRow[] {
	const acc = new Map<string, { sum: number; n: number }>();
	for (const dp of pts) {
		const o = dig(dp, key);
		const date = localDate(dig(o, 'sampleTime', 'physicalTime'), tz);
		const v = num(dig(o, field));
		if (date && v !== null && v >= floor) {
			const a = acc.get(date) ?? { sum: 0, n: 0 };
			a.sum += v;
			a.n += 1;
			acc.set(date, a);
		}
	}
	return [...acc].map(([date, a]) => ({ date, metric, value: a.sum / a.n }));
}

/** Map the six raw dataPoints responses for the window into metric rows. Every
 *  source is optional (a 4xx/empty response arrives as null) and contributes
 *  nothing rather than throwing. */
export function parseHealthData(
	r: {
		sleep?: unknown;
		restingHr?: unknown;
		hrv?: unknown;
		spo2?: unknown;
		respRate?: unknown;
		skinTemp?: unknown;
	},
	tz: string
): MetricRow[] {
	const rows: MetricRow[] = [];
	const push = (date: string | null, metric: string, v: number | null) => {
		if (date && v !== null && Number.isFinite(v)) rows.push({ date, metric, value: v });
	};

	// Sleep (Session): one dataPoint per session, from EITHER watch. Only the
	// WINNING session per night contributes, so daily_metrics and the hypnogram
	// (sleep_stages) always describe the same night from the same device — and a
	// night is never assembled from two devices. `summary` carries Fitbit's own
	// minute totals (int64 → JSON strings); attribute to the wake date (interval end).
	const sessions = winningSessions(r.sleep, tz);
	// Nights the Apple Watch won. The vitals below (resting HR, HRV, SpO2, resp
	// rate, skin temp) are Fitbit-only and come from separate data types — on an
	// Apple night the Fitbit's daytime wear would still emit them, which would
	// silently cross-source the night. Absent is the honest answer.
	const appleNights = new Set(
		sessions.filter((c) => c.session.source === 'apple').map((c) => c.session.date)
	);
	const pushFitbitOnly = (date: string | null, metric: string, v: number | null) => {
		if (date && !appleNights.has(date)) push(date, metric, v);
	};

	for (const c of sessions) {
		const { date, segments } = c.session;
		const sum = c.summary;
		const asleep = num(dig(sum, 'minutesAsleep'));
		if (asleep !== null) {
			const inBed = num(dig(sum, 'minutesInSleepPeriod'));
			push(date, 'sleep_min', asleep);
			push(date, 'time_in_bed_min', inBed);
			push(date, 'sleep_awake_min', num(dig(sum, 'minutesAwake')));
			if (inBed && inBed > 0) push(date, 'sleep_efficiency_pct', (asleep / inBed) * 100);
			const stages = dig(sum, 'stagesSummary');
			if (Array.isArray(stages)) {
				for (const st of stages) {
					const t = String(dig(st, 'type') ?? '').toUpperCase();
					const mins = num(dig(st, 'minutes'));
					if (t.includes('DEEP')) push(date, 'sleep_deep_min', mins);
					else if (t.includes('REM')) push(date, 'sleep_rem_min', mins);
					else if (t.includes('LIGHT')) push(date, 'sleep_light_min', mins);
					// AWAKE comes from summary.minutesAwake above; classic ASLEEP/RESTLESS
					// have no deep/light/rem breakdown and only feed sleep_min.
				}
			}
		} else {
			// No minute summary (the Apple path): derive the totals from this
			// session's own segments, so they can't disagree with the hypnogram and
			// nothing is borrowed from the other device.
			const mins = (stage: string) =>
				segments.filter((s) => s.stage === stage).reduce((t, s) => t + s.durationMin, 0);
			const inBed = c.lenMs / 60000;
			const slept = c.synth
				? inBed // no stage data at all: the whole session is the night
				: segments.filter((s) => s.stage !== 'AWAKE').reduce((t, s) => t + s.durationMin, 0);
			push(date, 'time_in_bed_min', inBed);
			push(date, 'sleep_min', slept);
			if (c.staged) {
				// Only with a real stage breakdown — an undifferentiated block has no
				// awake data, and reporting 100% efficiency would be a fabrication.
				// Awake = the rest of the night, so it can't contradict efficiency even
				// when the device leaves gaps between segments.
				push(date, 'sleep_awake_min', inBed - slept);
				push(date, 'sleep_efficiency_pct', (slept / inBed) * 100);
				for (const [stage, key] of [
					['DEEP', 'sleep_deep_min'],
					['REM', 'sleep_rem_min'],
					['LIGHT', 'sleep_light_min']
				] as const) {
					const v = mins(stage);
					if (v > 0) push(date, key, v);
				}
			}
		}
	}

	// Daily summaries (date is given directly — no timezone needed).
	for (const dp of fitPoints(r.restingHr)) {
		const d = dig(dp, 'dailyRestingHeartRate');
		pushFitbitOnly(ymd(dig(d, 'date')), 'sleep_resting_hr', num(dig(d, 'beatsPerMinute')));
	}
	for (const dp of fitPoints(r.respRate)) {
		const d = dig(dp, 'dailyRespiratoryRate');
		pushFitbitOnly(ymd(dig(d, 'date')), 'sleep_resp_rate', num(dig(d, 'breathsPerMinute')));
	}
	for (const dp of fitPoints(r.skinTemp)) {
		const d = dig(dp, 'dailySleepTemperatureDerivations');
		const nightly = num(dig(d, 'nightlyTemperatureCelsius'));
		const baseline = num(dig(d, 'baselineTemperatureCelsius'));
		if (nightly !== null && baseline !== null) {
			pushFitbitOnly(ymd(dig(d, 'date')), 'sleep_skin_temp_dev_c', nightly - baseline);
		}
	}

	// Sample types → one averaged value per local night.
	const notAppleNight = (m: MetricRow) => !appleNights.has(m.date);
	rows.push(
		...avgSamples(
			fitPoints(r.hrv),
			'heartRateVariability',
			'rootMeanSquareOfSuccessiveDifferencesMilliseconds',
			'sleep_hrv_ms',
			tz
		).filter(notAppleNight)
	);
	// floor 70%: a real sleeping SpO2 below 70 is non-physiological — those reads
	// are sensor noise / non-wear (Fitbit emits ~50), and would bias the mean low.
	rows.push(
		...avgSamples(
			fitPoints(r.spo2),
			'oxygenSaturation',
			'percentage',
			'sleep_spo2_pct',
			tz,
			70
		).filter(notAppleNight)
	);

	return foldDaily(rows);
}

// ── Session selection: one night, one device ───────────────────────────────
type Candidate = {
	session: SleepSession;
	summary: unknown; // Fitbit's own minute totals, when the point carries them
	lenMs: number;
	staged: boolean; // a real breakdown → awake minutes / efficiency are knowable
	synth: boolean; // no stage data at all → the block was synthesised from the interval
};

// Fitbit emits DEEP/LIGHT/REM/AWAKE; Apple's CORE is the same thing as light.
// null = drop the segment: Apple's IN_BED spans the whole night *around* the
// stage segments, so counting it would double the night's minutes.
function normStage(t: string): string | null {
	const s = t.toUpperCase();
	if (s.includes('BED')) return null;
	if (s.includes('DEEP')) return 'DEEP';
	if (s.includes('REM')) return 'REM';
	if (s.includes('LIGHT') || s.includes('CORE')) return 'LIGHT';
	if (s.includes('WAKE')) return 'AWAKE';
	return 'ASLEEP'; // classic Fitbit logs / Apple's unspecified-asleep: no breakdown
}

function sleepCandidates(sleep: unknown, tz: string): Candidate[] {
	const out: Candidate[] = [];
	for (const dp of fitPoints(sleep, ['FITBIT', 'HEALTH_KIT'])) {
		const s = dig(dp, 'sleep');
		const start = dig(s, 'interval', 'startTime');
		const end = dig(s, 'interval', 'endTime');
		const date = localDate(end, tz);
		if (!date || typeof start !== 'string' || typeof end !== 'string') continue;
		const startMs = Date.parse(start);
		const endMs = Date.parse(end);
		if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;

		const segments: SleepSession['segments'] = [];
		const rawStages = dig(s, 'stages');
		let inBedOnly = Array.isArray(rawStages) && rawStages.length > 0;
		if (Array.isArray(rawStages)) {
			for (const seg of rawStages) {
				const st = dig(seg, 'startTime');
				const en = dig(seg, 'endTime');
				const stage = dig(seg, 'type');
				const sMs = typeof st === 'string' ? Date.parse(st) : NaN;
				const eMs = typeof en === 'string' ? Date.parse(en) : NaN;
				const norm = typeof stage === 'string' ? normStage(stage) : null;
				if (!norm || !Number.isFinite(sMs) || !Number.isFinite(eMs) || eMs <= sMs) continue;
				inBedOnly = false;
				segments.push({
					stage: norm,
					startMin: (sMs - startMs) / 60000,
					durationMin: (eMs - sMs) / 60000
				});
			}
		}
		// Stages that were ALL in-bed markers: the device tracked time in bed but not
		// sleep. Calling that a night's sleep would over-report it, so drop the
		// session — no data beats invented data.
		if (inBedOnly) continue;
		// A real breakdown means we can talk about awake time and efficiency. A single
		// undifferentiated "asleep" block can't — claiming 0 awake / 100% efficiency
		// off it would be a fabrication.
		const staged = segments.length > 1 || segments.some((x) => x.stage !== 'ASLEEP');
		// Apple often reports a session with no stage breakdown at all — render it as
		// one solid asleep block rather than a blank hypnogram.
		const synth = segments.length === 0;
		if (synth) {
			segments.push({ stage: 'ASLEEP', startMin: 0, durationMin: (endMs - startMs) / 60000 });
		}
		out.push({
			session: {
				date,
				startAt: start,
				endAt: end,
				source: dig(dp, 'dataSource', 'platform') === 'FITBIT' ? 'fitbit' : 'apple',
				segments
			},
			summary: dig(s, 'summary'),
			lenMs: endMs - startMs,
			staged,
			synth
		});
	}
	return out;
}

// ONE session per local wake date: the longest, tie → Fitbit. Longest-wins rather
// than "Fitbit, else Apple" because a Fitbit left on the nightstand still emits a
// short stub session that must not beat a real 8-hour Apple night. The tie-break
// keeps both-devices-worn nights on Fitbit, i.e. exactly today's behaviour.
// ponytail: this is also the anti-double-count guarantee — by construction, not by
// overlap arithmetic. It drops naps too (out of scope; see the ticket).
function winningSessions(sleep: unknown, tz: string): Candidate[] {
	const byDate = new Map<string, Candidate>();
	for (const c of sleepCandidates(sleep, tz)) {
		const prev = byDate.get(c.session.date);
		const wins =
			!prev ||
			c.lenMs > prev.lenMs ||
			(c.lenMs === prev.lenMs && c.session.source === 'fitbit' && prev.session.source !== 'fitbit');
		if (wins) byDate.set(c.session.date, c);
	}
	return [...byDate.values()];
}

// Per-night stage timeline for the hypnogram: the winning session per local wake
// date, with each stage segment as a minute offset+duration from sleep start.
export function parseSleepSessions(sleep: unknown, tz: string): SleepSession[] {
	return winningSessions(sleep, tz).map((c) => c.session);
}

// Guard against duplicate (date, metric) rows — the daily_metrics upsert cannot
// hit the same conflict target twice in one statement (Postgres rejects that).
// Sleep now contributes one session per date, but a repeated stagesSummary entry
// or a future multi-point metric would still collide. Durations (`_min`) sum;
// everything else (efficiency %, rates) averages.
function foldDaily(rows: MetricRow[]): MetricRow[] {
	const acc = new Map<string, { date: string; metric: string; sum: number; n: number }>();
	for (const r of rows) {
		const k = `${r.date} ${r.metric}`;
		const a = acc.get(k) ?? { date: r.date, metric: r.metric, sum: 0, n: 0 };
		a.sum += r.value;
		a.n += 1;
		acc.set(k, a);
	}
	return [...acc.values()].map((a) => ({
		date: a.date,
		metric: a.metric,
		value: a.metric.endsWith('_min') ? a.sum : a.sum / a.n
	}));
}
