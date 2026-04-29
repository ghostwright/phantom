import type { Channel, ChannelCapabilities, InboundMessage, OutboundMessage, SentMessage } from "./types.ts";

// The chat's hot path bypasses the router's onMessage; it invokes
// AgentRuntime.runForChat directly from http.ts. This channel registers
// with the router for health and discovery only.
export class WebChatChannel implements Channel {
	readonly id = "web";
	readonly name = "Web Chat";
	readonly capabilities: ChannelCapabilities = {
		threads: false,
		richText: true,
		attachments: true,
		buttons: false,
		reactions: false,
		progressUpdates: true,
		typing: false,
		messageEditing: false,
	};

	async connect(): Promise<void> {
		// HTTP-driven, no persistent connection
	}

	async disconnect(): Promise<void> {
		// No cleanup needed
	}

	async send(conversationId: string, _message: OutboundMessage): Promise<SentMessage> {
		// Stub: the chat path uses SSE streaming, not channel.send()
		return {
			id: crypto.randomUUID(),
			channelId: this.id,
			conversationId,
			timestamp: new Date(),
		};
	}

	onMessage(_handler: (message: InboundMessage) => Promise<void>): void {
		// No-op: chat bypasses the router for its hot path
	}
}
