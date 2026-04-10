import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import type { WebClient } from "@slack/web-api";
import { z } from "zod";
import type { InboundAttachment, SkippedFileInfo } from "./types.ts";

export const UPLOADS_DIR = join(process.cwd(), "data", "uploads");
export const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const SUPPORTED_TEXT_TYPES = new Set(["text/markdown", "text/plain"]);
export const TEXT_FILE_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);
export const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB
export const MAX_TEXT_FILE_SIZE_BYTES = 1 * 1024 * 1024; // 1 MB - text files read into memory
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

/** Check if a file is a supported text type by MIME or extension fallback. */
export function isTextFile(mimetype: string, filename: string): boolean {
	if (SUPPORTED_TEXT_TYPES.has(mimetype)) return true;
	const dot = filename.lastIndexOf(".");
	if (dot === -1) return false;
	return TEXT_FILE_EXTENSIONS.has(filename.slice(dot).toLowerCase());
}

/** Check if a buffer contains NUL bytes, indicating binary content. */
export function hasNulBytes(buffer: ArrayBuffer): boolean {
	const view = new Uint8Array(buffer);
	for (let i = 0; i < view.length; i++) {
		if (view[i] === 0x00) return true;
	}
	return false;
}

/** Upload text content as a Slack file in a thread. Returns true on success, false on failure (caller falls back to chunking). */
export async function uploadSlackFile(
	client: Pick<WebClient, "files">,
	channel: string,
	threadTs: string,
	content: string,
	filename: string,
): Promise<boolean> {
	try {
		await client.files.uploadV2({
			channel_id: channel,
			thread_ts: threadTs,
			content,
			filename,
			title: "Full Response",
		});
		return true;
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[slack] Failed to upload file: ${msg}`);
		return false;
	}
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

		const isText = isTextFile(file.mimetype, file.name);
		const isImage = SUPPORTED_IMAGE_TYPES.has(file.mimetype);

		if (!isText && !isImage) {
			skippedFiles.push({ filename: file.name, reason: "unsupported_type", mimetype: file.mimetype });
			continue;
		}

		const sizeLimit = isText ? MAX_TEXT_FILE_SIZE_BYTES : MAX_FILE_SIZE_BYTES;
		if (file.size > sizeLimit) {
			console.warn(`[slack] Skipping file ${file.name}: exceeds ${sizeLimit} byte limit`);
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

			const buffer = await response.arrayBuffer();

			if (isText) {
				if (hasNulBytes(buffer)) {
					console.warn(`[slack] Skipping binary file disguised as text: ${file.name}`);
					skippedFiles.push({ filename: file.name, reason: "unsupported_type", mimetype: file.mimetype });
					continue;
				}
				const textContent = new TextDecoder().decode(buffer);
				attachments.push({
					type: "text",
					path: "",
					filename: file.name,
					mimetype: file.mimetype,
					textContent,
				});
			} else {
				const sanitized = sanitizeFilename(file.name);
				const filename = `${randomUUID()}-${sanitized}`;
				const filepath = join(UPLOADS_DIR, filename);

				// Defense-in-depth: verify resolved path stays within uploads directory
				if (!resolve(filepath).startsWith(resolvedUploadsDir)) {
					console.warn(`[slack] Path traversal blocked for file: ${file.name}`);
					skippedFiles.push({ filename: file.name, reason: "download_failed" });
					continue;
				}

				await Bun.write(filepath, buffer);

				attachments.push({
					type: "image",
					path: filepath,
					filename: file.name,
					mimetype: file.mimetype,
				});
			}
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
