// Disk storage helpers for chat attachment files.
// Files are stored at data/chat-attachments/<sessionId>/<fileId>.<ext>.

import { mkdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

const ATTACHMENTS_ROOT = join(process.cwd(), "data", "chat-attachments");

export function getAttachmentDir(sessionId: string): string {
	return join(ATTACHMENTS_ROOT, sessionId);
}

export function getAttachmentPath(sessionId: string, fileId: string, ext: string): string {
	return join(ATTACHMENTS_ROOT, sessionId, `${fileId}.${ext}`);
}

export async function ensureAttachmentDir(sessionId: string): Promise<void> {
	await mkdir(getAttachmentDir(sessionId), { recursive: true });
}

export async function writeAttachmentFile(
	sessionId: string,
	fileId: string,
	ext: string,
	data: Buffer | Uint8Array,
): Promise<string> {
	const dir = getAttachmentDir(sessionId);
	await mkdir(dir, { recursive: true });
	const filePath = join(dir, `${fileId}.${ext}`);
	await Bun.write(filePath, data);
	return filePath;
}

export async function readAttachmentFile(storagePath: string): Promise<Buffer> {
	const file = Bun.file(storagePath);
	const ab = await file.arrayBuffer();
	return Buffer.from(ab);
}

export async function readAttachmentFileBase64(storagePath: string): Promise<string> {
	const buf = await readAttachmentFile(storagePath);
	return buf.toString("base64");
}

export async function readAttachmentFileText(storagePath: string): Promise<string> {
	const file = Bun.file(storagePath);
	return file.text();
}

export async function deleteAttachmentFile(storagePath: string): Promise<void> {
	try {
		await unlink(storagePath);
	} catch (err: unknown) {
		const e = err as { code?: string };
		if (e.code !== "ENOENT") throw err;
	}
}

export async function deleteAttachmentDir(sessionId: string): Promise<void> {
	const dir = getAttachmentDir(sessionId);
	try {
		const { rm } = await import("node:fs/promises");
		await rm(dir, { recursive: true, force: true });
	} catch {
		// Directory may not exist
	}
}

export function resolveStoragePath(sessionId: string, fileId: string, ext: string): string {
	return join(dirname(getAttachmentDir(sessionId)), sessionId, `${fileId}.${ext}`);
}
