export type Macros = {
	calories: number;
	proteinG: number;
	carbsG: number;
	fatG: number;
};

export type Targets = {
	calorieTarget: number;
	proteinTargetG: number;
	carbsTargetG: number;
	fatTargetG: number;
};

export function sumMacros(rows: Macros[]): Macros {
	return rows.reduce(
		(acc, r) => ({
			calories: acc.calories + r.calories,
			proteinG: acc.proteinG + r.proteinG,
			carbsG: acc.carbsG + r.carbsG,
			fatG: acc.fatG + r.fatG
		}),
		{ calories: 0, proteinG: 0, carbsG: 0, fatG: 0 }
	);
}

export function pct(value: number, target: number): number {
	if (target <= 0) return 0;
	return Math.min(100, Math.round((value / target) * 100));
}

export function formatTime(d: Date): string {
	return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
