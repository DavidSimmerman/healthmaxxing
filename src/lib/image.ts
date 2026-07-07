// Downscale an image File to a JPEG data URL at ~maxDim on the long edge — Claude's optimal
// vision size — with EXIF orientation baked in. Keeps uploads well under the server body
// limit and speeds up vision. Browser-only (uses canvas / createImageBitmap).
export async function downscaleToDataUrl(
	file: File,
	maxDim = 1568,
	quality = 0.82
): Promise<string> {
	const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
	const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
	const w = Math.round(bitmap.width * scale);
	const h = Math.round(bitmap.height * scale);
	const canvas = document.createElement('canvas');
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('canvas unavailable');
	ctx.drawImage(bitmap, 0, 0, w, h);
	bitmap.close();
	return canvas.toDataURL('image/jpeg', quality);
}
