import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { InboundAttachment, SkippedFileInfo } from "./types.ts";

export const UPLOADS_DIR = join(process.cwd(), "data", "uploads");
export const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB
export const UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
// file_share is the only subtype we process - all others (message_changed, etc.) are noise
export const ALLOWED_SUBTYPES = new Set(["file_share"]);
// Only fetch from Slack's file hosting - prevents SSRF via crafted file records
const ALLOWED_FILE_HOSTS = new Set(["files.slack.com", "files-pri.slack.com"]);

export const SlackFileSchema = z.object({
	url_private: z.string().url(),
	mimetype: z.string().min(1),
	name: z.string().min(1),
	size: z.number().int().nonnegative(),
});

export type SlackFileRecord = z.infer<typeof SlackFileSchema>;

export type FileDownloadResult = {
	attachments: InboundAttachment[];
	skippedFiles: SkippedFileInfo[];
};

/** Strip directory components and null bytes to prevent path traversal. */
export function sanitizeFilename(rawName: string): string {
	const basename = rawName.split(/[/\\]/).pop() ?? "file";
	const cleaned = basename.replace(/\0/g, "");
	return cleaned || "file";
}

export async function downloadSlackFiles(files: unknown[], token: string): Promise<FileDownloadResult> {
	const attachments: InboundAttachment[] = [];
	const skippedFiles: SkippedFileInfo[] = [];
	const resolvedUploadsDir = resolve(UPLOADS_DIR);

	for (const rawFile of files) {
		const parsed = SlackFileSchema.safeParse(rawFile);
		if (!parsed.success) {
			console.warn(`[slack] Invalid file record: ${parsed.error.message}`);
			continue;
		}

		const file = parsed.data;

		try {
			const fileUrl = new URL(file.url_private);
			if (!ALLOWED_FILE_HOSTS.has(fileUrl.hostname)) {
				console.warn(`[slack] Blocked file download from untrusted host: ${fileUrl.hostname}`);
				skippedFiles.push({ filename: file.name, reason: "download_failed" });
				continue;
			}
		} catch {
			console.warn(`[slack] Invalid file URL for ${file.name}`);
			skippedFiles.push({ filename: file.name, reason: "download_failed" });
			continue;
		}

		if (!SUPPORTED_IMAGE_TYPES.has(file.mimetype)) {
			skippedFiles.push({ filename: file.name, reason: "unsupported_type", mimetype: file.mimetype });
			continue;
		}

		if (file.size > MAX_FILE_SIZE_BYTES) {
			console.warn(`[slack] Skipping file ${file.name}: exceeds ${MAX_FILE_SIZE_BYTES} byte limit`);
			skippedFiles.push({ filename: file.name, reason: "too_large" });
			continue;
		}

		try {
			const response = await fetch(file.url_private, {
				headers: { Authorization: `Bearer ${token}` },
			});
			if (!response.ok) {
				console.warn(`[slack] Failed to download ${file.name}: HTTP ${response.status}`);
				skippedFiles.push({ filename: file.name, reason: "download_failed" });
				continue;
			}

			const sanitized = sanitizeFilename(file.name);
			const filename = `${randomUUID()}-${sanitized}`;
			const filepath = join(UPLOADS_DIR, filename);

			// Defense-in-depth: verify resolved path stays within uploads directory
			if (!resolve(filepath).startsWith(resolvedUploadsDir)) {
				console.warn(`[slack] Path traversal blocked for file: ${file.name}`);
				skippedFiles.push({ filename: file.name, reason: "download_failed" });
				continue;
			}

			const buffer = await response.arrayBuffer();
			await Bun.write(filepath, buffer);

			attachments.push({
				type: "image",
				path: filepath,
				filename: file.name,
				mimetype: file.mimetype,
			});
		} catch (err: unknown) {
			const errMsg = err instanceof Error ? err.message : String(err);
			console.warn(`[slack] Failed to download file ${file.name}: ${errMsg}`);
			skippedFiles.push({ filename: file.name, reason: "download_failed" });
		}
	}

	return { attachments, skippedFiles };
}

export function ensureUploadsDir(): void {
	mkdirSync(UPLOADS_DIR, { recursive: true });
}

export function cleanupOldUploads(): void {
	try {
		const now = Date.now();
		for (const entry of readdirSync(UPLOADS_DIR)) {
			const filepath = join(UPLOADS_DIR, entry);
			const stat = statSync(filepath);
			if (now - stat.mtimeMs > UPLOAD_MAX_AGE_MS) {
				unlinkSync(filepath);
			}
		}
	} catch {
		// Best effort - don't block connect on cleanup failure
	}
}
