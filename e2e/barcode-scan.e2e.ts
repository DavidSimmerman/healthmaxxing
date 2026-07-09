import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Live-scanner e2e: feed the component a fake camera (canvas captureStream)
// showing an EAN-13 that is rotated 35° (diagonal — past the 1D reader's
// axis-aligned tolerance, so only the 45°-rotated second pass catches it) and
// fills only ~30% of the frame width — the exact conditions the old
// box-cropped decoder failed on. The test passes only if the full-frame zxing
// loop decodes it and the found-card renders.

const EAN13 = '4006381333931'; // valid check digit

function envVar(name: string): string {
	if (process.env[name]) return process.env[name];
	const line = readFileSync('.env', 'utf8')
		.split('\n')
		.find((l) => l.startsWith(`${name}=`));
	if (!line) throw new Error(`${name} not found in environment or .env`);
	return line
		.slice(name.length + 1)
		.trim()
		.replace(/^(['"])(.*)\1$/, '$2');
}

test('live scanner decodes a rotated, partial-frame barcode', async ({ page }) => {
	// Generate a real EAN-13 PNG with the zxing writer (runs in node). The
	// negative scale asks for ~400px — sharp bars, like a real camera frame.
	const { writeBarcode } = await import('zxing-wasm/writer');
	const written = await writeBarcode(EAN13, { format: 'EAN-13', scale: -400 });
	if (!written.image) throw new Error('writer produced no image');
	const pngB64 = Buffer.from(await written.image.arrayBuffer()).toString('base64');

	// Fake camera: a canvas stream drawing the barcode rotated and small.
	await page.addInitScript(
		({ pngB64 }) => {
			const img = new Image();
			img.src = `data:image/png;base64,${pngB64}`;
			const canvas = document.createElement('canvas');
			canvas.width = 1280;
			canvas.height = 720;
			const ctx = canvas.getContext('2d')!;
			const draw = () => {
				ctx.fillStyle = '#b9b1a6'; // non-white background, like a countertop
				ctx.fillRect(0, 0, canvas.width, canvas.height);
				ctx.save();
				ctx.translate(canvas.width / 2, canvas.height / 2);
				ctx.rotate((35 * Math.PI) / 180);
				const w = 380; // ~30% of frame width — nowhere near "filling the box"
				const h = (w * img.height) / (img.width || 1);
				ctx.drawImage(img, -w / 2, -h / 2, w, h);
				ctx.restore();
				requestAnimationFrame(draw);
			};
			img.onload = draw;
			const stream = canvas.captureStream(15);
			Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
				configurable: true,
				value: async () => stream
			});
		},
		{ pngB64 }
	);

	// Stub the lookup so the test never hits Open Food Facts / writes food rows.
	await page.route('**/api/barcode/*', (route) => {
		expect(route.request().url()).toContain(EAN13);
		return route.fulfill({
			json: {
				food: {
					id: 1,
					name: 'Test Bar',
					brand: 'ACME',
					servingSize: '1 bar',
					servingGrams: 50,
					calories: 200,
					proteinG: 10,
					carbsG: 20,
					fatG: 5
				}
			}
		});
	});

	// Log in (preview server enforces the session gate when a password is set).
	await page.goto('/login');
	await page.fill('input[type="password"]', envVar('MCP_AUTH_PASSWORD'));
	await page.click('button[type="submit"]');
	await page.waitForURL((u) => !u.pathname.startsWith('/login'));

	// The launcher moved into BottomNav as "Log food" (was a floating "Add food").
	await page.getByLabel('Log food').click();
	await page.getByLabel('Scan barcode').click();

	// Decode (wasm load + a few frames) → lookup stub → found card.
	await expect(page.getByText('Found')).toBeVisible({ timeout: 20_000 });
	await expect(page.getByText('Test Bar')).toBeVisible();
});
