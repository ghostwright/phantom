export type InboundAttachment = {
	type: "image" | "document";
	path: string;
	filename: string;
	mimetype: string;
};

export type SkippedFileInfo = {
	filename: string;
	reason: "unsupported_type" | "too_large" | "download_failed";
	mimetype?: string;
};

export type InboundMessage = {
	id: string;
	channelId: string;
	conversationId: string;
	threadId?: string;
	senderId: string;
	senderName?: string;
	text: string;
	timestamp: Date;
	metadata?: Record<string, unknown>;
	attachments?: InboundAttachment[];
	skippedFiles?: SkippedFileInfo[];
};

export type OutboundMessage = {
	text: string;
	threadId?: string;
	replyToId?: string;
};

export type SentMessage = {
	id: string;
	channelId: string;
	conversationId: string;
	timestamp: Date;
};

export type ChannelCapabilities = {
	threads: boolean;
	richText: boolean;
	attachments: boolean;
	buttons: boolean;
	reactions?: boolean;
	progressUpdates?: boolean;
	inlineKeyboards?: boolean;
	typing?: boolean;
	messageEditing?: boolean;
};

export interface Channel {
	readonly id: string;
	readonly name: string;
	readonly capabilities: ChannelCapabilities;

	connect(): Promise<void>;
	disconnect(): Promise<void>;
	send(conversationId: string, message: OutboundMessage): Promise<SentMessage>;
	onMessage(handler: (message: InboundMessage) => Promise<void>): void;
}
