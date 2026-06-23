// Self-check for the FDC→key mapper. Run: npx tsx src/lib/server/fdcMap.check.ts
import assert from 'node:assert/strict';
import { mapFdcNutrients, fdcValue } from './fdcMap';

// search-result shape: {nutrientId, value, unitName}
assert.deepEqual(mapFdcNutrients([{ nutrientId: 1178, value: 0.5, unitName: 'UG' }]), {
	vitB12Ug: 0.5
});
// food-detail shape: {nutrient:{id,unitName}, amount}
assert.deepEqual(mapFdcNutrients([{ nutrient: { id: 1162, unitName: 'MG' }, amount: 30 }]), {
	vitCMg: 30
});
// unit conversion: calcium reported in G → our mg
assert.deepEqual(mapFdcNutrients([{ nutrientId: 1087, value: 0.12, unitName: 'G' }]), {
	calciumMg: 120
});
// vitamin E alpha-tocopherol equivalents (MG_ATE) treated as mg
assert.deepEqual(mapFdcNutrients([{ nutrientId: 1109, value: 2, unitName: 'MG_ATE' }]), {
	vitEMg: 2
});
// IU can't be safely converted → skipped, never guessed
assert.deepEqual(mapFdcNutrients([{ nutrientId: 1106, value: 500, unitName: 'IU' }]), {});
// legacy nutrientNumber must NOT be mistaken for a modern id (203 protein ≠ map)
assert.deepEqual(mapFdcNutrients([{ nutrientId: 9999, value: 1, unitName: 'G' }]), {});

// fdcValue pulls macros by modern id, both shapes
assert.equal(fdcValue([{ nutrientId: 1003, value: 31 }], '1003'), 31);
assert.equal(fdcValue([{ nutrient: { id: 1008 }, amount: 165 }], '1008'), 165);
assert.equal(fdcValue([], '1003'), null);

console.log('fdcMap.check.ts OK');
