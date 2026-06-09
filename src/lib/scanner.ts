// Barcode decoding via zxing-wasm — shared by the live camera loop and the
// "upload a photo" path in BarcodeScan.svelte.
//
// zxing-wasm with `tryHarder + tryRotate + tryInvert + tryDownscale` finds
// barcodes anywhere in the frame at any orientation, including rotated,
// partially crinkled, or small/zoomed-out codes — unlike box-cropped decoders
// that need the code flat, upright, and filling a target rectangle.

import type { ReaderOptions, ReadResult } from 'zxing-wasm/reader';

const READER_OPTIONS: ReaderOptions = {
	// Retail + common scanner formats only — narrowing the format list speeds up
	// each decode pass and avoids false hits from unrelated symbologies.
	formats: ['EAN-13', 'EAN-8', 'UPC-A', 'UPC-E', 'Code128', 'Code39', 'ITF'],
	tryHarder: true,
	tryRotate: true,
	tryInvert: true,
	tryDownscale: true,
	maxNumberOfSymbols: 1
};

type ReadBarcodes = typeof import('zxing-wasm/reader').readBarcodes;

let readerPromise: Promise<ReadBarcodes> | null = null;

/** Load + initialize the wasm module once; concurrent callers share the load. */
export function loadReader(): Promise<ReadBarcodes> {
	if (!readerPromise) {
		readerPromise = (async () => {
			const { readBarcodes, prepareZXingModule } = await import('zxing-wasm/reader');
			await prepareZXingModule({
				overrides: {
					locateFile: (path: string, prefix: string) => {
						if (path.endsWith('.wasm')) {
							return new URL('zxing-wasm/reader/zxing_reader.wasm', import.meta.url).href;
						}
						return prefix + path;
					}
				},
				fireImmediately: true
			});
			return readBarcodes;
		})();
		// A failed load (offline, blocked wasm) shouldn't poison every later scan.
		readerPromise.catch(() => (readerPromise = null));
	}
	return readerPromise;
}

/** Decode one image/frame. Returns the first valid hit, or null if none. */
export async function decodeBarcode(input: Blob | File | ImageData): Promise<ReadResult | null> {
	const readBarcodes = await loadReader();
	const results = await readBarcodes(input, READER_OPTIONS);
	return results.find((r) => r.isValid && r.text) ?? null;
}

/**
 * Formats without a mandatory checksum can produce single-frame misreads on a
 * live camera — require a second identical read before trusting them.
 * (EAN/UPC have check digits and Code128 a mandatory check character, so a
 * single valid read of those is already trustworthy.)
 */
export function needsConfirmation(format: string): boolean {
	return format === 'Code39' || format === 'ITF';
}
