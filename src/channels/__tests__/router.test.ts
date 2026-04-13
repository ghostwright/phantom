import { describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ChannelRouter } from "../router.ts";
import type { Channel, ChannelCapabilities, InboundMessage, OutboundMessage, SentMessage } from "../types.ts";

class MockChannel implements Channel {
	readonly id: string;
	readonly name: string;
	readonly capabilities: ChannelCapabilities = {
		threads: false,
		richText: false,
		attachments: false,
		buttons: false,
	};

	private handler: ((msg: InboundMessage) => Promise<void>) | null = null;
	connected = false;
	lastSent: OutboundMessage | null = null;

	constructor(id: string) {
		this.id = id;
		this.name = id;
	}

	async connect(): Promise<void> {
		this.connected = true;
	}

	async disconnect(): Promise<void> {
		this.connected = false;
	}

	async send(_conversationId: string, message: OutboundMessage): Promise<SentMessage> {
		this.lastSent = message;
		return {
			id: randomUUID(),
			channelId: this.id,
			conversationId: "test",
			timestamp: new Date(),
		};
	}

	onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
		this.handler = handler;
	}

	async simulateMessage(text: string): Promise<void> {
		if (!this.handler) throw new Error("No handler registered");
		await this.handler({
			id: randomUUID(),
			channelId: this.id,
			conversationId: "test-conv",
			senderId: "user",
			text,
			timestamp: new Date(),
		});
	}
}

class HangingChannel extends MockChannel {
	override async connect(): Promise<void> {
		await new Promise(() => {});
	}
}

describe("ChannelRouter", () => {
	test("registers a channel", () => {
		const router = new ChannelRouter();
		const ch = new MockChannel("test");
		router.register(ch);
		expect(router.getChannelIds()).toEqual(["test"]);
	});

	test("rejects duplicate channel IDs", () => {
		const router = new ChannelRouter();
		router.register(new MockChannel("test"));
		expect(() => router.register(new MockChannel("test"))).toThrow("already registered");
	});

	test("connects all channels", async () => {
		const router = new ChannelRouter();
		const ch1 = new MockChannel("a");
		const ch2 = new MockChannel("b");
		router.register(ch1);
		router.register(ch2);

		await router.connectAll();
		expect(ch1.connected).toBe(true);
		expect(ch2.connected).toBe(true);
	});

	test("disconnects all channels", async () => {
		const router = new ChannelRouter();
		const ch = new MockChannel("test");
		router.register(ch);
		await router.connectAll();
		await router.disconnectAll();
		expect(ch.connected).toBe(false);
	});

	test("connectAll times out slow channels and continues", async () => {
		const router = new ChannelRouter();
		const fast = new MockChannel("fast");
		const slow = new HangingChannel("slow");
		const errorSpy = spyOn(console, "error").mockImplementation(() => {});
		router.register(fast);
		router.register(slow);

		await router.connectAll(5);

		expect(fast.connected).toBe(true);
		expect(slow.connected).toBe(false);
		expect(errorSpy).toHaveBeenCalled();
		expect(errorSpy.mock.calls.some((call) => call.join(" ").includes("Timed out after 5ms"))).toBe(true);
		errorSpy.mockRestore();
	});

	test("routes inbound messages to handler", async () => {
		const router = new ChannelRouter();
		const ch = new MockChannel("test");
		router.register(ch);

		let receivedText = "";
		router.onMessage(async (msg) => {
			receivedText = msg.text;
		});

		await ch.simulateMessage("hello");
		expect(receivedText).toBe("hello");
	});

	test("sends outbound messages to correct channel", async () => {
		const router = new ChannelRouter();
		const ch = new MockChannel("test");
		router.register(ch);

		await router.send("test", "conv-1", { text: "response" });
		expect(ch.lastSent?.text).toBe("response");
	});

	test("throws on send to unknown channel", async () => {
		const router = new ChannelRouter();
		await expect(router.send("unknown", "conv", { text: "hi" })).rejects.toThrow("Unknown channel");
	});

	test("healthCheck returns channel status", () => {
		const router = new ChannelRouter();
		router.register(new MockChannel("a"));
		router.register(new MockChannel("b"));

		const health = router.healthCheck();
		expect(health).toEqual({ a: true, b: true });
	});
});
