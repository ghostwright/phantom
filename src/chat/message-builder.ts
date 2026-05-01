// Builds SDK-native MessageParam from user text + attachments.
// Attachments are converted to ImageBlockParam, DocumentBlockParam, or
// TextBlockParam depending on type. Text block goes last.

import type { SDKUserMessage } from "../agent/agent-sdk.ts";

type MessageParam = SDKUserMessage["message"];

import type { ChatAttachment, ChatAttachmentStore } from "./attachment-store.ts";
import { readAttachmentFileBase64, readAttachmentFileText } from "./storage.ts";
import { IMAGE_MIMES, PDF_MIME } from "./validators.ts";

type ContentBlock = {
	type: string;
	text?: string;
	source?: {
		type: string;
		media_type?: string;
		data: string;
	};
	title?: string;
};

export type UserAttachmentMetadata = {
	id: string;
	filename: string;
	mime_type: string;
	size_bytes: number | null;
	preview_url: string;
};

export type UserTranscriptContentBlock =
	| (UserAttachmentMetadata & { type: "attachment" })
	| { type: "text"; text: string };

export type BuiltUserMessage = {
	message: MessageParam;
	attachments: UserAttachmentMetadata[];
	transcriptContent: string | UserTranscriptContentBlock[];
};

export type AttachmentResolutionCode = "attachment_not_found" | "attachment_wrong_session" | "attachment_already_sent";

export class ChatAttachmentResolutionError extends Error {
	readonly code: AttachmentResolutionCode;

	constructor(code: AttachmentResolutionCode) {
		const message =
			code === "attachment_already_sent"
				? "Attachment has already been sent."
				: "Attachment is not available for this chat.";
		super(message);
		this.name = "ChatAttachmentResolutionError";
		this.code = code;
	}
}

export async function buildUserMessage(
	text: string,
	attachmentIds: string[],
	sessionId: string,
	attachmentStore: ChatAttachmentStore,
): Promise<BuiltUserMessage> {
	const attachments = resolveUserMessageAttachments(attachmentIds, attachmentStore, sessionId);
	const metadata = attachments.map(attachmentToMetadata);
	const message = await buildMessageParamFromAttachments(text, attachments);
	return {
		message,
		attachments: metadata,
		transcriptContent: buildUserTranscriptContent(text, metadata),
	};
}

export async function buildUserMessageParam(
	text: string,
	attachmentIds: string[],
	attachmentStore: ChatAttachmentStore,
): Promise<MessageParam> {
	const attachments = resolveUserMessageAttachments(attachmentIds, attachmentStore);
	return buildMessageParamFromAttachments(text, attachments);
}

export function buildUserTranscriptContent(
	text: string,
	attachments: UserAttachmentMetadata[],
): string | UserTranscriptContentBlock[] {
	if (attachments.length === 0) return text;
	return [...attachments.map((attachment) => ({ ...attachment, type: "attachment" as const })), { type: "text", text }];
}

function resolveUserMessageAttachments(
	attachmentIds: string[],
	attachmentStore: ChatAttachmentStore,
	sessionId?: string,
): ChatAttachment[] {
	if (attachmentIds.length === 0) return [];

	return attachmentIds.map((id) => {
		const att = attachmentStore.getById(id);
		if (!att) throw new ChatAttachmentResolutionError("attachment_not_found");
		if (sessionId && att.session_id !== sessionId) {
			throw new ChatAttachmentResolutionError("attachment_wrong_session");
		}
		if (att.message_id !== null) {
			throw new ChatAttachmentResolutionError("attachment_already_sent");
		}
		return att;
	});
}

function attachmentToMetadata(att: ChatAttachment): UserAttachmentMetadata {
	return {
		id: att.id,
		filename: att.filename ?? "file",
		mime_type: att.mime_type ?? "application/octet-stream",
		size_bytes: att.size_bytes,
		preview_url: `/chat/attachments/${att.id}/preview`,
	};
}

async function buildMessageParamFromAttachments(text: string, attachments: ChatAttachment[]): Promise<MessageParam> {
	if (attachments.length === 0) {
		return { role: "user", content: text };
	}

	const content: ContentBlock[] = [];

	// Images first, then documents, then text - matches Anthropic's recommended ordering
	const images = attachments.filter((a) => IMAGE_MIMES.has(a.mime_type ?? ""));
	const pdfs = attachments.filter((a) => a.mime_type === PDF_MIME);
	const textFiles = attachments.filter((a) => !IMAGE_MIMES.has(a.mime_type ?? "") && a.mime_type !== PDF_MIME);

	for (const att of images) {
		const data = await readAttachmentFileBase64(att.storage_path);
		content.push({
			type: "image",
			source: {
				type: "base64",
				media_type: att.mime_type ?? "image/png",
				data,
			},
		});
	}

	for (const att of pdfs) {
		const data = await readAttachmentFileBase64(att.storage_path);
		content.push({
			type: "document",
			source: {
				type: "base64",
				media_type: "application/pdf",
				data,
			},
			title: att.filename ?? "document.pdf",
		});
	}

	for (const att of textFiles) {
		const data = await readAttachmentFileText(att.storage_path);
		content.push({
			type: "document",
			source: {
				type: "text",
				media_type: "text/plain",
				data,
			},
			title: att.filename ?? "file.txt",
		});
	}

	// User text always goes last
	content.push({ type: "text", text });

	return { role: "user", content: content as MessageParam["content"] };
}
