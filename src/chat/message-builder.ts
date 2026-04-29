// Builds SDK-native MessageParam from user text + attachments.
// Attachments are converted to ImageBlockParam, DocumentBlockParam, or
// TextBlockParam depending on type. Text block goes last.

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

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

export async function buildUserMessageParam(
	text: string,
	attachmentIds: string[],
	attachmentStore: ChatAttachmentStore,
): Promise<MessageParam> {
	if (attachmentIds.length === 0) {
		return { role: "user", content: text };
	}

	const attachments: ChatAttachment[] = [];

	for (const id of attachmentIds) {
		const att = attachmentStore.getById(id);
		if (att) attachments.push(att);
	}

	// All IDs were invalid - fall back to plain text
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
