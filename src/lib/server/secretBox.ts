import { env } from '$env/dynamic/private';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

// Shared at-rest encryption for stored secrets (Tandem password, Fitbit/Dexcom
// refresh tokens): aes-256-gcm, serialized as iv:tag:ciphertext hex. Extracted
// from tandem.ts — the key derivation (TANDEM_ENC_KEY + 'tandem-insulin' salt)
// is FROZEN so every pre-existing tandem_auth row still decrypts. One deployment
// key for all boxed secrets.

export function secretBoxEnabled(): boolean {
	return !!env.TANDEM_ENC_KEY;
}

// scrypt is deliberately slow — memoize per key material (env is effectively
// static, but re-derive if it ever changes at runtime).
let derived: { input: string; key: Buffer } | null = null;
function key(): Buffer {
	const input = env.TANDEM_ENC_KEY;
	if (!input) throw new Error('TANDEM_ENC_KEY is not set.');
	if (derived?.input !== input) derived = { input, key: scryptSync(input, 'tandem-insulin', 32) };
	return derived.key;
}

export function sealSecret(plain: string): string {
	const iv = randomBytes(12);
	const c = createCipheriv('aes-256-gcm', key(), iv);
	const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
	return [iv, c.getAuthTag(), ct].map((b) => b.toString('hex')).join(':');
}

export function openSecret(blob: string): string {
	const [iv, tag, ct] = blob.split(':').map((h) => Buffer.from(h, 'hex'));
	if (!iv || !tag || !ct) throw new Error('Malformed stored secret.');
	const d = createDecipheriv('aes-256-gcm', key(), iv);
	d.setAuthTag(tag);
	return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

// True when a stored value is a sealSecret blob rather than legacy plaintext.
// Strict on the iv (12 bytes) / tag (16 bytes) hex lengths so a real token can't
// false-positive its way into a decrypt attempt.
export function isSealed(value: string): boolean {
	return /^[0-9a-f]{24}:[0-9a-f]{32}:(?:[0-9a-f]{2})+$/.test(value);
}
