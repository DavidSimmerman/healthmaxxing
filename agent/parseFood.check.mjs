// Run: node parseFood.check.mjs
import assert from 'node:assert';
import { parseFood } from './parseFood.mjs';

// fenced JSON, source defaults to estimate
const f = parseFood('```json\n{"name":"Oats","calories":150,"proteinG":5,"carbsG":27,"fatG":3}\n```');
assert.equal(f.name, 'Oats');
assert.equal(f.calories, 150);
assert.equal(f.source, 'estimate');

// label source + nutrients + confidence preserved
const l = parseFood(
	'{"name":"Bar","brand":"X","calories":200,"proteinG":10,"carbsG":20,"fatG":8,"source":"label_ocr","nutrients":{"fiberG":3},"confidence":"high"}'
);
assert.equal(l.source, 'label_ocr');
assert.equal(l.brand, 'X');
assert.deepEqual(l.nutrients, { fiberG: 3 });
assert.match(l.resolverNote, /confidence: high/);

// rejects: missing macro / negative / no name / non-JSON
assert.throws(() => parseFood('{"name":"Bad","calories":100,"proteinG":5,"carbsG":10}'), /fatG/);
assert.throws(() => parseFood('{"name":"Neg","calories":-1,"proteinG":0,"carbsG":0,"fatG":0}'), /negative/);
assert.throws(() => parseFood('{"calories":1,"proteinG":0,"carbsG":0,"fatG":0}'), /name/);
assert.throws(() => parseFood('I think this is oatmeal'), /did not return JSON/);

console.log('parseFood self-check: OK');
