import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { pendingItems } from '$lib/server/db/schema';
import { desc, eq } from 'drizzle-orm';
import { writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, extname } from 'node:path';
import { requireApiToken } from '$lib/server/auth';

const UPLOAD_DIR = join(process.cwd(), 'uploads');

// GET — list pending items (used by Claude Code).
export async function GET({ request }) {
	requireApiToken(request);
	const status = new URL(request.url).searchParams.get('status') ?? 'pending';
	const base = db.select().from(pendingItems);
	const rows =
		status === 'all'
			? await base.orderBy(desc(pendingItems.createdAt))
			: await base.where(eq(pendingItems.status, status)).orderBy(desc(pendingItems.createdAt));
	return json({ items: rows });
}

// POST — multipart form: kind, optional image, optional text, optional barcode
export async function POST({ request }) {
	const form = await request.formData();
	const kind = String(form.get('kind') || '');
	if (!kind) throw error(400, 'kind required');

	const text = (form.get('text') as string) || null;
	const barcode = (form.get('barcode') as string) || null;
	const caption = (form.get('caption') as string) || null;
	const image = form.get('image') as File | null;

	let imagePath: string | null = null;
	if (image && image.size > 0) {
		await mkdir(UPLOAD_DIR, { recursive: true });
		const ext = extname(image.name) || '.jpg';
		const filename = `${randomUUID()}${ext}`;
		const bytes = new Uint8Array(await image.arrayBuffer());
		await writeFile(join(UPLOAD_DIR, filename), bytes);
		imagePath = filename;
	}

	const [item] = await db
		.insert(pendingItems)
		.values({
			kind,
			barcode,
			imagePath,
			text: caption ?? text
		})
		.returning();

	return json({ item });
}
