import type { Channel, InboundMessage, OutboundMessage, SentMessage } from "./types.ts";

type MessageHandler = (message: InboundMessage) => Promise<void>;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

export class ChannelRouter {
	private channels = new Map<string, Channel>();
	private handler: MessageHandler | null = null;

	register(channel: Channel): void {
		if (this.channels.has(channel.id)) {
			throw new Error(`Channel already registered: ${channel.id}`);
		}
		this.channels.set(channel.id, channel);
		channel.onMessage((msg) => this.routeInbound(msg));
	}

	onMessage(handler: MessageHandler): void {
		this.handler = handler;
	}

	async connectAll(connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS): Promise<void> {
		const channels = [...this.channels.values()];
		const results = await Promise.allSettled(channels.map((ch) => connectWithTimeout(ch, connectTimeoutMs)));

		for (const [i, result] of results.entries()) {
			if (result.status === "rejected") {
				const ch = channels[i];
				console.error(`[router] Failed to connect channel ${ch.id}: ${result.reason}`);
			}
		}
	}

	async disconnectAll(): Promise<void> {
		const results = await Promise.allSettled([...this.channels.values()].map((ch) => ch.disconnect()));

		for (const [i, result] of results.entries()) {
			if (result.status === "rejected") {
				const ch = [...this.channels.values()][i];
				console.error(`[router] Failed to disconnect channel ${ch.id}: ${result.reason}`);
			}
		}
	}

	async send(channelId: string, conversationId: string, message: OutboundMessage): Promise<SentMessage> {
		const channel = this.channels.get(channelId);
		if (!channel) {
			throw new Error(`Unknown channel: ${channelId}`);
		}
		return channel.send(conversationId, message);
	}

	getChannelIds(): string[] {
		return [...this.channels.keys()];
	}

	healthCheck(): Record<string, boolean> {
		const result: Record<string, boolean> = {};
		for (const [id] of this.channels) {
			result[id] = true;
		}
		return result;
	}

	private async routeInbound(message: InboundMessage): Promise<void> {
		if (!this.handler) {
			console.error("[router] No message handler registered, dropping message");
			return;
		}

		try {
			await this.handler(message);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[router] Error handling message from ${message.channelId}: ${msg}`);
		}
	}
}

async function connectWithTimeout(channel: Channel, timeoutMs: number): Promise<void> {
	if (timeoutMs <= 0) {
		await channel.connect();
		return;
	}

	let timeoutId: ReturnType<typeof setTimeout> | null = null;
	try {
		const connectPromise = channel.connect();
		await Promise.race([
			connectPromise,
			new Promise<never>((_, reject) => {
				timeoutId = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
			}),
		]);
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
	}
}
