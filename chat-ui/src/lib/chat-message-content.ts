import type { ChatAttachmentView, ChatMessage, ContentBlock } from "./chat-types";

export type ParsedMessageContent = {
	contentBlocks: ContentBlock[];
	attachments?: ChatAttachmentView[];
};

export function parseMessageContentJson(contentJson: string, role: string): ParsedMessageContent {
	try {
		const parsed = JSON.parse(contentJson);
		if (typeof parsed === "string") {
			return { contentBlocks: [{ type: "text", text: parsed }] };
		}
		if (Array.isArray(parsed)) {
			return normalizeDurableContent(parsed, role);
		}
		return normalizeDurableContent([parsed], role);
	} catch {
		return { contentBlocks: [{ type: "text", text: contentJson }] };
	}
}

export function getAssistantTextBlocks(message: Pick<ChatMessage, "content">): string[] {
	return message.content
		.filter((block) => block.type === "text" && typeof block.text === "string" && block.text.length > 0)
		.map((block) => block.text as string);
}

function normalizeDurableContent(blocks: unknown[], role: string): ParsedMessageContent {
	if (role !== "user") {
		return { contentBlocks: blocks.filter(isRecord).map(recordToContentBlock) };
	}
	const contentBlocks: ContentBlock[] = [];
	const attachments: ChatAttachmentView[] = [];
	for (const block of blocks) {
		if (!isRecord(block)) continue;
		if (block.type === "attachment") {
			const attachment = normalizeDurableAttachment(block);
			if (attachment) attachments.push(attachment);
			continue;
		}
		if (block.type === "text") {
			contentBlocks.push({ type: "text", text: typeof block.text === "string" ? block.text : "" });
		}
	}
	return { contentBlocks, attachments: attachments.length > 0 ? attachments : undefined };
}

function recordToContentBlock(block: Record<string, unknown>): ContentBlock {
	return { ...block, type: typeof block.type === "string" ? block.type : "text" };
}

function normalizeDurableAttachment(block: Record<string, unknown>): ChatAttachmentView | null {
	if (typeof block.id !== "string" || block.id.length === 0) return null;
	const filename = typeof block.filename === "string" && block.filename.length > 0 ? block.filename : "file";
	const mimeType =
		typeof block.mime_type === "string"
			? block.mime_type
			: typeof block.mimeType === "string"
				? block.mimeType
				: "application/octet-stream";
	const sizeValue = block.size_bytes ?? block.sizeBytes;
	const previewValue = block.preview_url ?? block.previewUrl;
	return {
		id: block.id,
		filename,
		mimeType,
		sizeBytes: typeof sizeValue === "number" ? sizeValue : null,
		previewUrl: typeof previewValue === "string" ? previewValue : `/chat/attachments/${block.id}/preview`,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
