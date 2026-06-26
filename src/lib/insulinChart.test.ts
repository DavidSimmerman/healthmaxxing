import { describe, it, expect } from 'vitest';
import { basalAreaPath, niceMax, type BasalPt } from './insulinChart';

describe('niceMax', () => {
	it('never goes below the floor', () => {
		expect(niceMax([], 1)).toBe(1);
		expect(niceMax([0.3, 0.8], 1)).toBe(1);
	});
	it('rounds up to a tidy step', () => {
		expect(niceMax([1.2])).toBe(1.5); // ≤2 → 0.5 step
		expect(niceMax([3, 4])).toBe(4); // ≤5 → 1 step
		expect(niceMax([7])).toBe(10); // ≤20 → 5 step
		expect(niceMax([23])).toBe(30); // >20 → 10 step
	});
});

describe('basalAreaPath', () => {
	const x = (m: number) => m; // identity scales make the geometry checkable
	const y = (u: number) => 100 - u;

	it('is empty with no points', () => {
		expect(basalAreaPath([], x, y, 100)).toBe('');
	});

	it('steps each sample and closes to baseline', () => {
		const pts: BasalPt[] = [
			{ min: 0, units: 1 },
			{ min: 10, units: 2 }
		];
		// first sample holds 0→10; last extends +tail(5) to 15, then drops to baseline.
		expect(basalAreaPath(pts, x, y, 100, 1440, 5)).toBe(
			'M 0.0 100.0 L 0.0 99.0 L 10.0 99.0 L 10.0 98.0 L 15.0 98.0 L 15.0 100.0 Z'
		);
	});

	it('caps the final tail at the end of the day', () => {
		const path = basalAreaPath([{ min: 1438, units: 1 }], x, y, 100, 1440, 5);
		expect(path).toContain('L 1440.0 99.0'); // tail clamped to 1440, not 1443
		expect(path.endsWith('L 1440.0 100.0 Z')).toBe(true);
	});

	it('sorts unsorted input by time', () => {
		const path = basalAreaPath(
			[
				{ min: 20, units: 2 },
				{ min: 5, units: 1 }
			],
			x,
			y,
			100
		);
		expect(path.startsWith('M 5.0 100.0')).toBe(true);
	});
});
