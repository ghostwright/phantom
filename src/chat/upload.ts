// Multipart upload handler for POST /chat/sessions/:id/attachments.
// Validates files, writes to disk, inserts DB records.

import type { ChatAttachmentStore } from "./attachment-store.ts";
import type { ChatSessionStore } from "./session-store.ts";
import { writeAttachmentFile } from "./storage.ts";
import {
	MAX_FILES_PER_REQUEST,
	guessMimeFromName,
	pickExtension,
	sanitizeFilename,
	validateFile,
	validateRequestSize,
} from "./validators.ts";

export type UploadDeps = {
	sessionStore: ChatSessionStore;
	attachmentStore: ChatAttachmentStore;
};

export type AcceptedAttachment = {
	id: string;
	filename: string;
	mime_type: string;
	size: number;
	preview_url: string;
};

export type RejectedAttachment = {
	filename: string;
	reason: string;
	message: string;
};

export type UploadResult = {
	attachments: AcceptedAttachment[];
	rejected: RejectedAttachment[];
	status: number;
};

export async function handleUploadAttachments(req: Request, sessionId: string, deps: UploadDeps): Promise<Response> {
	const session = deps.sessionStore.get(sessionId);
	if (!session) {
		return Response.json({ error: "session_not_found", message: "Chat session not found." }, { status: 404 });
	}

	const contentLength = Number(req.headers.get("content-length") ?? "0");
	const sizeCheck = validateRequestSize(contentLength || null);
	if (!sizeCheck.ok) {
		return Response.json({ error: sizeCheck.reason, message: sizeCheck.message }, { status: 413 });
	}

	let formData: FormData;
	try {
		formData = await req.formData();
	} catch {
		return Response.json(
			{ error: "invalid_form_data", message: "Could not parse multipart form data." },
			{ status: 400 },
		);
	}

	const files = formData.getAll("file").filter((v): v is File => v instanceof File);

	if (files.length === 0) {
		return Response.json({ error: "no_files", message: "No files attached." }, { status: 400 });
	}

	if (files.length > MAX_FILES_PER_REQUEST) {
		// Take the first MAX_FILES_PER_REQUEST, reject the rest
		const toProcess = files.slice(0, MAX_FILES_PER_REQUEST);
		const overflow = files.slice(MAX_FILES_PER_REQUEST);
		const overflowRejected = overflow.map((f) => ({
			filename: f.name,
			reason: "limit_exceeded",
			message: `Limit of ${MAX_FILES_PER_REQUEST} files per upload reached.`,
		}));
		const result = await processFiles(toProcess, sessionId, deps);
		result.rejected.push(...overflowRejected);
		const status = result.attachments.length > 0 ? 207 : 400;
		return Response.json({ attachments: result.attachments, rejected: result.rejected }, { status });
	}

	const result = await processFiles(files, sessionId, deps);
	const status = result.rejected.length === 0 ? 200 : result.attachments.length === 0 ? 400 : 207;
	return Response.json({ attachments: result.attachments, rejected: result.rejected }, { status });
}

async function processFiles(
	files: File[],
	sessionId: string,
	deps: UploadDeps,
): Promise<{ attachments: AcceptedAttachment[]; rejected: RejectedAttachment[] }> {
	const accepted: AcceptedAttachment[] = [];
	const rejected: RejectedAttachment[] = [];

	for (const file of files) {
		const mime = file.type || guessMimeFromName(file.name) || "";
		const validation = validateFile(mime, file.size, file.name);

		if (!validation.ok) {
			rejected.push({ filename: file.name, reason: validation.reason, message: validation.message });
			console.log(`[chat-upload] sessionId=${sessionId} file=${file.name} reason=${validation.reason}`);
			continue;
		}

		const id = crypto.randomUUID();
		const ext = pickExtension(mime, file.name);

		try {
			const buffer = Buffer.from(await file.arrayBuffer());
			const storagePath = await writeAttachmentFile(sessionId, id, ext, buffer);

			const kind = mime.startsWith("image/") ? "image" : mime === "application/pdf" ? "pdf" : "text";

			deps.attachmentStore.create({
				id,
				sessionId,
				kind,
				filename: sanitizeFilename(file.name),
				mimeType: mime,
				sizeBytes: file.size,
				storagePath,
			});

			accepted.push({
				id,
				filename: sanitizeFilename(file.name),
				mime_type: mime,
				size: file.size,
				preview_url: `/chat/attachments/${id}/preview`,
			});

			console.log(`[chat-upload] sessionId=${sessionId} file=${file.name} mime=${mime} size=${file.size} id=${id}`);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[chat-upload] write failed for ${file.name}: ${msg}`);
			rejected.push({ filename: file.name, reason: "storage_failed", message: "Could not save file. Please retry." });
		}
	}

	return { attachments: accepted, rejected };
}
