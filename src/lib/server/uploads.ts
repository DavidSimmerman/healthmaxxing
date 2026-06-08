import { env } from '$env/dynamic/private';
import { join } from 'node:path';

// Where captured/label images live on disk.
// In production (Coolify) set UPLOAD_DIR to a mounted volume path so uploads
// survive redeploys, e.g. UPLOAD_DIR=/data/uploads. Falls back to ./uploads in dev.
export const UPLOAD_DIR = env.UPLOAD_DIR || join(process.cwd(), 'uploads');

export function uploadPath(filename: string): string {
	return join(UPLOAD_DIR, filename);
}
