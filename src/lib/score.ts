// Goal scoring engine — PURE (no DB, no I/O). The single source of truth for how
// a day / week / month of health data becomes a 0–100 score. Every threshold and
// weight is a named constant so the model can be tuned without touching the math.
// Companion runnable check: score.check.ts (npx tsx src/lib/score.check.ts).
//
// Model in one breath: each goal → attainment ∈ [0,1] (1 = fully met). The day's
// base score is the mean of the attainments that have data (missing data is
// excluded, never counted as 0 — we don't punish a sensor that isn't connected).
// Bonus points (for beating GMI / TIR / deficit, and for extra strength/running
// over a week) are added on top but capped, so they bump a good day to great
// without ever rescuing an awful one.

// ── Tunable constants ───────────────────────────────────────────────────────
export const BONUS_CAP_DAY = 8; // max bonus points a single day can earn
export const BONUS_CAP_WEEK = 10; // max bonus points a week/month can earn
export const W_WEEKLY = 0.25; // weight of the weekly goals (strength/running) in a period score
export const VERY_BAD_PROTEIN_G = 100; // protein below this flags a "very bad day"

// ── Goal specs ──────────────────────────────────────────────────────────────
// dir '>=' : higher is better, attainment 1.0 at `target`, 0 at `floor`.
// dir '<=' : lower is better,  attainment 1.0 at `target`, 0 at `floor`.
// `bonusTo` (optional): the value at which overshoot bonus maxes out (beyond target).
export type GoalKey =
	| 'gmi'
	| 'no_over_250'
	| 'tir'
	| 'time_below'
	| 'steps'
	| 'sleep'
	| 'deficit'
	| 'protein'
	| 'water'
	| 'strength'
	| 'running';

export type GoalSpec = {
	key: GoalKey;
	label: string;
	unit: string;
	dir: '>=' | '<=';
	target: number;
	floor: number;
	bonusTo?: number;
	scope: 'day' | 'week';
	// How to render the value (the engine works in canonical units below).
	fmt?: (v: number) => string;
};

// Canonical units: gmi %, tir %, over250/below %, steps count, sleep MINUTES,
// deficit kcal, protein g, water OUNCES, strength count, running MILES.
export const GOAL_SPECS: GoalSpec[] = [
	{
		key: 'gmi',
		label: 'GMI',
		unit: '%',
		dir: '<=',
		target: 6.5,
		floor: 8.0,
		bonusTo: 5.0,
		scope: 'day',
		fmt: (v) => `${v.toFixed(1)}%`
	},
	{
		key: 'no_over_250',
		label: 'Time over 250',
		unit: '%',
		dir: '<=',
		target: 0,
		floor: 10,
		scope: 'day',
		fmt: (v) => `${v.toFixed(1)}%`
	},
	{
		key: 'tir',
		label: 'Time in range',
		unit: '%',
		dir: '>=',
		target: 85,
		floor: 0,
		bonusTo: 100,
		scope: 'day',
		fmt: (v) => `${Math.round(v)}%`
	},
	{
		key: 'time_below',
		label: 'Time below 70',
		unit: '%',
		dir: '<=',
		target: 4, // clinical hypo target: < 4% time below 70 (Battelino consensus)
		floor: 8,
		scope: 'day',
		fmt: (v) => `${v.toFixed(1)}%`
	},
	{
		key: 'steps',
		label: 'Steps',
		unit: '',
		dir: '>=',
		target: 10000,
		floor: 0,
		scope: 'day',
		fmt: (v) => Math.round(v).toLocaleString()
	},
	{
		key: 'sleep',
		label: 'Sleep',
		unit: 'h',
		dir: '>=',
		target: 420,
		floor: 0,
		scope: 'day',
		fmt: (v) => `${(v / 60).toFixed(1)} h`
	},
	{
		key: 'deficit',
		label: 'Calorie deficit',
		unit: 'kcal',
		dir: '>=',
		target: 750,
		floor: 0,
		bonusTo: 1500,
		scope: 'day',
		fmt: (v) => `${Math.round(v)}`
	},
	{
		key: 'protein',
		label: 'Protein',
		unit: 'g',
		dir: '>=',
		target: 160,
		floor: 100,
		scope: 'day',
		fmt: (v) => `${Math.round(v)} g`
	},
	{
		key: 'water',
		label: 'Water',
		unit: 'oz',
		dir: '>=',
		target: 87,
		floor: 0,
		scope: 'day',
		fmt: (v) => `${Math.round(v)} oz`
	},
	{
		key: 'strength',
		label: 'Strength workouts',
		unit: '/wk',
		dir: '>=',
		target: 5,
		floor: 0,
		bonusTo: 8,
		scope: 'week',
		fmt: (v) => `${v}`
	},
	{
		key: 'running',
		label: 'Running miles',
		unit: 'mi/wk',
		dir: '>=',
		target: 8,
		floor: 0,
		bonusTo: 14,
		scope: 'week',
		fmt: (v) => `${v.toFixed(1)} mi`
	}
];

export const SPEC: Record<GoalKey, GoalSpec> = Object.fromEntries(
	GOAL_SPECS.map((s) => [s.key, s])
) as Record<GoalKey, GoalSpec>;

export const DAY_GOALS = GOAL_SPECS.filter((s) => s.scope === 'day').map((s) => s.key);
export const WEEK_GOALS = GOAL_SPECS.filter((s) => s.scope === 'week').map((s) => s.key);
const DAY_BONUS_GOALS: GoalKey[] = ['gmi', 'tir', 'deficit'];

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

// Attainment ∈ [0,1], or null when the datum is missing.
export function attainment(spec: GoalSpec, value: number | null): number | null {
	if (value == null || !Number.isFinite(value)) return null;
	const span = spec.target - spec.floor; // signed
	if (span === 0) return value === spec.target ? 1 : 0;
	return clamp01((value - spec.floor) / span);
}

// Whether a goal is "met" — i.e. the check + green bar show. Compares the value
// ROUNDED to the precision the UI displays (integer target → whole number, a
// fractional target like 6.5 → one decimal) against the target, so a row that
// reads "160 g" (from a 159.6 average) counts as met instead of looking 0.4 g
// short. Distinct from attainment, which stays exact and drives the score.
export function isMet(spec: GoalSpec, value: number | null): boolean {
	if (value == null || !Number.isFinite(value)) return false;
	const rounded = Number(value.toFixed(Number.isInteger(spec.target) ? 0 : 1));
	return spec.dir === '>=' ? rounded >= spec.target : rounded <= spec.target;
}

// Overshoot ∈ [0,1] beyond target, for bonus goals (0 when no bonus / no data).
export function overshoot(spec: GoalSpec, value: number | null): number {
	if (value == null || spec.bonusTo == null || !Number.isFinite(value)) return 0;
	const span = spec.bonusTo - spec.target; // signed
	if (span === 0) return 0;
	return clamp01((value - spec.target) / span);
}

// ── Inputs ──────────────────────────────────────────────────────────────────
export type DayMetrics = {
	date: string; // YYYY-MM-DD (APP_TZ)
	gmi: number | null;
	tir: number | null;
	over250: number | null; // % of readings > 250
	below70: number | null; // % of readings < 70
	steps: number | null;
	sleepMin: number | null;
	deficit: number | null;
	protein: number | null;
	waterOz: number | null;
};

const DAY_VALUE: Record<string, (m: DayMetrics) => number | null> = {
	gmi: (m) => m.gmi,
	no_over_250: (m) => m.over250,
	tir: (m) => m.tir,
	time_below: (m) => m.below70,
	steps: (m) => m.steps,
	sleep: (m) => m.sleepMin,
	deficit: (m) => m.deficit,
	protein: (m) => m.protein,
	water: (m) => m.waterOz
};

export type GoalResult = {
	key: GoalKey;
	label: string;
	value: number | null;
	attainment: number | null; // null = no data
	met: boolean; // rounded value reaches target (see isMet)
	display: string; // formatted value or '—'
};

export type BonusPart = { key: GoalKey; label: string; points: number };

export type DayScore = {
	date: string;
	goals: GoalResult[];
	base: number | null; // mean attainment ×100, or null if no data at all
	bonus: number;
	bonusParts: BonusPart[]; // where the bonus came from (gmi / tir / deficit overshoot)
	score: number | null;
	perfect: boolean; // every day-goal has data AND is met
	veryBad: boolean; // protein < VERY_BAD_PROTEIN_G
};

export function scoreDay(m: DayMetrics): DayScore {
	const goals: GoalResult[] = DAY_GOALS.map((key) => {
		const spec = SPEC[key];
		const value = DAY_VALUE[key](m);
		const att = attainment(spec, value);
		return {
			key,
			label: spec.label,
			value,
			attainment: att,
			met: isMet(spec, value),
			display: value == null ? '—' : (spec.fmt?.(value) ?? String(value))
		};
	});

	const withData = goals.filter((g) => g.attainment != null);
	const base = withData.length
		? (withData.reduce((s, g) => s + (g.attainment as number), 0) / withData.length) * 100
		: null;

	// Only the bonus goals that HAVE data count toward the divisor — a missing
	// sensor (e.g. no Dexcom → null GMI/TIR) must not dilute the bonus, same as it's
	// excluded from the base. Each contributes BONUS_CAP_DAY × overshoot ÷ that count.
	const bonusData = DAY_BONUS_GOALS.map((k) => ({ spec: SPEC[k], v: DAY_VALUE[k](m) })).filter(
		(x) => x.v != null
	);
	const per = base == null || bonusData.length === 0 ? 0 : BONUS_CAP_DAY / bonusData.length;
	const bonusParts = bonusData
		.map((x) => ({ key: x.spec.key, label: x.spec.label, points: per * overshoot(x.spec, x.v) }))
		.filter((p) => p.points >= 0.05);
	const bonus = bonusParts.reduce((s, p) => s + p.points, 0);

	const score = base == null ? null : Math.max(0, Math.min(100, base + bonus));
	const perfect = goals.every((g) => g.attainment != null) && goals.every((g) => g.met);
	const veryBad = m.protein != null && m.protein < VERY_BAD_PROTEIN_G;

	return { date: m.date, goals, base, bonus, bonusParts, score, perfect, veryBad };
}

// ── Period (week / month) ─────────────────────────────────────────────────────
export type PeriodExtras = {
	strengthCount: number | null;
	runningMiles: number | null;
	days: number; // length of the period, for prorating weekly targets
};

export type PeriodScore = {
	dayScores: DayScore[];
	dailyGoals: GoalResult[]; // each daily goal scored on its period-average value
	weeklyGoals: GoalResult[]; // strength + running (targets prorated for the period)
	base: number | null;
	bonus: number;
	bonusParts: BonusPart[]; // where the period bonus came from
	score: number | null;
	perfectDays: number;
	streak: number; // consecutive perfect days ending at the last day
};

// Weekly target scaled to the period length (5/wk over 30 days ≈ 21.4).
function proratedSpec(spec: GoalSpec, days: number): GoalSpec {
	const k = days / 7;
	return {
		...spec,
		target: spec.target * k,
		bonusTo: spec.bonusTo == null ? undefined : spec.bonusTo * k
	};
}

export function scorePeriod(days: DayMetrics[], extras: PeriodExtras): PeriodScore {
	const dayScores = days.map(scoreDay);

	// Daily goals scored on their period-AVERAGE value (a day under and a day over
	// cancel out), not the mean of daily scores. `days` should be COMPLETED days only.
	const dailyGoals = aggregateDailyGoals(dayScores);
	const dailyData = dailyGoals.filter((g) => g.attainment != null);
	const dailyMean = dailyData.length
		? (dailyData.reduce((s, g) => s + (g.attainment as number), 0) / dailyData.length) * 100
		: null;

	const strengthSpec = proratedSpec(SPEC.strength, extras.days);
	const runningSpec = proratedSpec(SPEC.running, extras.days);
	const weeklyGoals: GoalResult[] = [
		buildGoal(strengthSpec, extras.strengthCount),
		buildGoal(runningSpec, extras.runningMiles)
	];
	const weeklyWithData = weeklyGoals.filter((g) => g.attainment != null);
	const weeklyMean = weeklyWithData.length
		? (weeklyWithData.reduce((s, g) => s + (g.attainment as number), 0) / weeklyWithData.length) *
			100
		: null;

	// Blend daily score with the weekly goals; fall back gracefully if one side is missing.
	let base: number | null;
	if (dailyMean != null && weeklyMean != null)
		base = dailyMean * (1 - W_WEEKLY) + weeklyMean * W_WEEKLY;
	else base = dailyMean ?? weeklyMean;

	// Period bonus = BONUS_CAP_WEEK × mean([daily, strength, running] overshoot) — the
	// same three-way split as before, but daily overshoot now comes from the AVERAGED
	// bonus goals (not per-day). Attribute to named parts that sum to that total: the
	// daily third is shared among its bonus goals (each CAP×oᵢ/(3·n)); strength/running
	// take CAP×overshoot/3 each.
	const dailyBonusGoals = DAY_BONUS_GOALS.map((k) => dailyGoals.find((g) => g.key === k)).filter(
		(g): g is GoalResult => !!g && g.value != null
	);
	const n = dailyBonusGoals.length;
	const rawParts: BonusPart[] = [
		...dailyBonusGoals.map((g) => ({
			key: g.key,
			label: g.label,
			points: n ? (BONUS_CAP_WEEK * overshoot(SPEC[g.key], g.value)) / (3 * n) : 0
		})),
		{ key: 'strength', label: SPEC.strength.label, points: (BONUS_CAP_WEEK * overshoot(strengthSpec, extras.strengthCount)) / 3 },
		{ key: 'running', label: SPEC.running.label, points: (BONUS_CAP_WEEK * overshoot(runningSpec, extras.runningMiles)) / 3 }
	];
	const bonusParts = base == null ? [] : rawParts.filter((p) => p.points >= 0.05);
	const bonus = bonusParts.reduce((s, p) => s + p.points, 0);

	const score = base == null ? null : Math.max(0, Math.min(100, base + bonus));
	const perfectDays = dayScores.filter((d) => d.perfect).length;

	return {
		dayScores,
		dailyGoals,
		weeklyGoals,
		base,
		bonus,
		bonusParts,
		score,
		perfectDays,
		streak: currentStreak(dayScores)
	};
}

function buildGoal(spec: GoalSpec, value: number | null): GoalResult {
	const att = attainment(spec, value);
	return {
		key: spec.key,
		label: spec.label,
		value,
		attainment: att,
		met: isMet(spec, value),
		display: value == null ? '—' : (spec.fmt?.(value) ?? String(value))
	};
}

// Consecutive perfect days ending at the LAST element (the selected date).
export function currentStreak(dayScores: { perfect: boolean }[]): number {
	let n = 0;
	for (let i = dayScores.length - 1; i >= 0; i--) {
		if (dayScores[i].perfect) n++;
		else break;
	}
	return n;
}

// Per daily-goal AVERAGE across a period, for the week/month goal rows: average the
// value over the days that have data, then score that average. So a day 100 under
// and a day 100 over cancel to "hit exactly" — the period is judged on the mean, not
// the mean of daily pass/fail. A goal with no data on any day → null, display '—'.
// (Pass COMPLETED days only — exclude today/future, which would drag the average.)
export function aggregateDailyGoals(dayScores: DayScore[]): GoalResult[] {
	return DAY_GOALS.map((key) => {
		const spec = SPEC[key];
		const vals = dayScores
			.map((d) => d.goals.find((g) => g.key === key)?.value)
			.filter((v): v is number => v != null && Number.isFinite(v));
		if (!vals.length) {
			return { key, label: spec.label, value: null, attainment: null, met: false, display: '—' };
		}
		const value = vals.reduce((s, v) => s + v, 0) / vals.length;
		const att = attainment(spec, value);
		return {
			key,
			label: spec.label,
			value,
			attainment: att,
			met: isMet(spec, value),
			display: spec.fmt?.(value) ?? String(value)
		};
	});
}

// Letter grade for a 0–100 score (UI convenience).
export function grade(score: number | null): string {
	if (score == null) return '—';
	if (score >= 97) return 'A+';
	if (score >= 93) return 'A';
	if (score >= 90) return 'A−';
	if (score >= 87) return 'B+';
	if (score >= 83) return 'B';
	if (score >= 80) return 'B−';
	if (score >= 70) return 'C';
	if (score >= 60) return 'D';
	return 'F';
}
