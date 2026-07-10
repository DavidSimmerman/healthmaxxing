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
// Field names below are confirmed against live responses (see the sync's
// {"debug":true} mode). Sleep efficiency is computed (minutesAsleep /
// minutesInSleepPeriod) — Fitbit's response carries no efficiency field. Stage
// types are matched by substring (DEEP/REM/LIGHT) so a CLASSIC sleep log degrades
// to just sleep_min without breaking.

export type MetricRow = { date: string; metric: string; value: number };

export type SleepSession = {
	date: string; // local wake date
	startAt: string; // ISO, sleep start
	endAt: string; // ISO, wake
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
function fitPoints(j: unknown): unknown[] {
	const dp = dig(j, 'dataPoints');
	if (!Array.isArray(dp)) return [];
	return dp.filter((p) => dig(p, 'dataSource', 'platform') === 'FITBIT');
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

	// Sleep (Session): one dataPoint per session. `summary` carries Fitbit's own
	// minute totals (int64 → JSON strings); attribute to the wake date (interval end).
	for (const dp of fitPoints(r.sleep)) {
		const s = dig(dp, 'sleep');
		const sum = dig(s, 'summary');
		const date = localDate(dig(s, 'interval', 'endTime'), tz);
		const asleep = num(dig(sum, 'minutesAsleep'));
		const inBed = num(dig(sum, 'minutesInSleepPeriod'));
		push(date, 'sleep_min', asleep);
		push(date, 'time_in_bed_min', inBed);
		push(date, 'sleep_awake_min', num(dig(sum, 'minutesAwake')));
		if (asleep !== null && inBed && inBed > 0) {
			push(date, 'sleep_efficiency_pct', (asleep / inBed) * 100);
		}
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
	}

	// Daily summaries (date is given directly — no timezone needed).
	for (const dp of fitPoints(r.restingHr)) {
		const d = dig(dp, 'dailyRestingHeartRate');
		push(ymd(dig(d, 'date')), 'sleep_resting_hr', num(dig(d, 'beatsPerMinute')));
	}
	for (const dp of fitPoints(r.respRate)) {
		const d = dig(dp, 'dailyRespiratoryRate');
		push(ymd(dig(d, 'date')), 'sleep_resp_rate', num(dig(d, 'breathsPerMinute')));
	}
	for (const dp of fitPoints(r.skinTemp)) {
		const d = dig(dp, 'dailySleepTemperatureDerivations');
		const nightly = num(dig(d, 'nightlyTemperatureCelsius'));
		const baseline = num(dig(d, 'baselineTemperatureCelsius'));
		if (nightly !== null && baseline !== null) {
			push(ymd(dig(d, 'date')), 'sleep_skin_temp_dev_c', nightly - baseline);
		}
	}

	// Sample types → one averaged value per local night.
	rows.push(
		...avgSamples(
			fitPoints(r.hrv),
			'heartRateVariability',
			'rootMeanSquareOfSuccessiveDifferencesMilliseconds',
			'sleep_hrv_ms',
			tz
		)
	);
	// floor 70%: a real sleeping SpO2 below 70 is non-physiological — those reads
	// are sensor noise / non-wear (Fitbit emits ~50), and would bias the mean low.
	rows.push(
		...avgSamples(fitPoints(r.spo2), 'oxygenSaturation', 'percentage', 'sleep_spo2_pct', tz, 70)
	);

	return foldDaily(rows);
}

// Per-night stage timeline for the hypnogram: the main (longest) session per local
// wake date, with each stage segment as a minute offset+duration from sleep start.
export function parseSleepSessions(sleep: unknown, tz: string): SleepSession[] {
	const byDate = new Map<string, SleepSession>();
	for (const dp of fitPoints(sleep)) {
		const s = dig(dp, 'sleep');
		const start = dig(s, 'interval', 'startTime');
		const end = dig(s, 'interval', 'endTime');
		const date = localDate(end, tz);
		const startMs = typeof start === 'string' ? Date.parse(start) : NaN;
		const rawStages = dig(s, 'stages');
		if (!date || typeof start !== 'string' || typeof end !== 'string') continue;
		if (!Number.isFinite(startMs) || !Array.isArray(rawStages)) continue;

		const segments: SleepSession['segments'] = [];
		for (const seg of rawStages) {
			const st = dig(seg, 'startTime');
			const en = dig(seg, 'endTime');
			const stage = dig(seg, 'type');
			const sMs = typeof st === 'string' ? Date.parse(st) : NaN;
			const eMs = typeof en === 'string' ? Date.parse(en) : NaN;
			if (typeof stage !== 'string' || !Number.isFinite(sMs) || !Number.isFinite(eMs) || eMs <= sMs)
				continue;
			segments.push({ stage, startMin: (sMs - startMs) / 60000, durationMin: (eMs - sMs) / 60000 });
		}
		if (!segments.length) continue;

		// Keep the longest session for the date (the main sleep, not a nap).
		const lenMs = Date.parse(end) - startMs;
		const prev = byDate.get(date);
		if (!prev || lenMs > Date.parse(prev.endAt) - Date.parse(prev.startAt)) {
			byDate.set(date, { date, startAt: start, endAt: end, segments });
		}
	}
	return [...byDate.values()];
}

// A night can have several sleep sessions (main sleep + a nap), which yields
// duplicate (date, metric) rows. Fold to ONE per (date, metric) so the
// daily_metrics upsert never hits the same conflict target twice in one statement
// (Postgres rejects that). Durations (`_min`) sum across sessions; everything else
// (efficiency %, rates) averages. ponytail: efficiency is a simple mean of
// sessions — fine for the rare main+nap case; time-weight it only if it matters.
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
