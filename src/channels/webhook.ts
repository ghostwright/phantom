/**
 * Generic webhook channel with HMAC-SHA256 signature verification.
 * Supports synchronous (inline) and asynchronous (callback URL) response modes.
 * Compatible with Zapier, Make, n8n, and custom integrations.
 */

import { randomUUID, timingSafeEqual } from "node:crypto";
import { isSafeCallbackUrl } from "../utils/url-validator.ts";
import type { Channel, ChannelCapabilities, InboundMessage, OutboundMessage, SentMessage } from "./types.ts";

export type WebhookChannelConfig = {
	secret: string;
	/** Max time in ms to wait for agent response in sync mode. Default 25000 (25s). */
	syncTimeoutMs?: number;
};

export type WebhookPayload = {
	message: string;
	conversation_id: string;
	user_id?: string;
	thread_id?: string;
	metadata?: Record<string, unknown>;
	callback_url?: string;
	timestamp: number;
	signature: string;
};

export type WebhookResponse = {
	status: "ok" | "accepted" | "error";
	response?: string;
	task_id?: string;
	message?: string;
	metadata?: {
		session_id?: string;
		cost_usd?: number;
		duration_ms?: number;
	};
};

type PendingResponse = {
	resolve: (text: string) => void;
	timer: ReturnType<typeof setTimeout>;
};

type CompletedResponse = {
	response: string;
	completedAt: number;
};

type WaitResult = { type: "success"; text: string } | { type: "timeout"; taskId: string } | { type: "error" };

export class WebhookChannel implements Channel {
	readonly id = "webhook";
	readonly name = "Webhook";
	readonly capabilities: ChannelCapabilities = {
		threads: false,
		richText: false,
		attachments: false,
		buttons: false,
	};

	private config: WebhookChannelConfig;
	private messageHandler: ((message: InboundMessage) => Promise<void>) | null = null;
	private connected = false;
	// Track pending sync responses: taskId -> resolver
	private pendingResponses = new Map<string, PendingResponse>();
	// Track async callback URLs: conversationId -> callbackUrl
	private callbackUrls = new Map<string, string>();
	// Track completed responses for polling: taskId -> response
	private completedResponses = new Map<string, CompletedResponse>();
	// Track pending poll requests: taskId -> conversationId
	private pendingPolls = new Map<string, string>();
	// Reverse lookup: conversationId -> taskId
	private conversationToTaskId = new Map<string, string>();
	// Cleanup interval for expired responses
	private cleanupInterval: ReturnType<typeof setInterval> | null = null;

	constructor(config: WebhookChannelConfig) {
		this.config = config;
	}

	async connect(): Promise<void> {
		this.connected = true;
		// Start cleanup interval (every minute, remove responses older than 5 minutes)
		this.cleanupInterval = setInterval(() => this.cleanupExpiredResponses(), 60_000);
		console.log("[webhook] Channel ready");
	}

	async disconnect(): Promise<void> {
		// Stop cleanup interval
		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval);
			this.cleanupInterval = null;
		}
		// Clean up pending responses
		for (const [, pending] of this.pendingResponses) {
			clearTimeout(pending.timer);
			pending.resolve("");
		}
		this.pendingResponses.clear();
		this.callbackUrls.clear();
		this.completedResponses.clear();
		this.pendingPolls.clear();
		this.conversationToTaskId.clear();
		this.connected = false;
		console.log("[webhook] Disconnected");
	}

	async send(conversationId: string, message: OutboundMessage): Promise<SentMessage> {
		// Check if there's a pending sync response for this conversation
		const pending = this.pendingResponses.get(conversationId);
		if (pending) {
			clearTimeout(pending.timer);
			pending.resolve(message.text);
			this.pendingResponses.delete(conversationId);
		}

		// Check if this conversation is waiting for polling
		const taskId = this.conversationToTaskId.get(conversationId);
		if (taskId) {
			this.completedResponses.set(taskId, {
				response: message.text,
				completedAt: Date.now(),
			});
			this.pendingPolls.delete(taskId);
			this.conversationToTaskId.delete(conversationId);
		}

		// Check if there's an async callback URL
		const callbackUrl = this.callbackUrls.get(conversationId);
		if (callbackUrl) {
			await this.sendCallback(callbackUrl, conversationId, message.text);
			this.callbackUrls.delete(conversationId);
		}

		return {
			id: randomUUID(),
			channelId: this.id,
			conversationId,
			timestamp: new Date(),
		};
	}

	onMessage(handler: (message: InboundMessage) => Promise<void>): void {
		this.messageHandler = handler;
	}

	isConnected(): boolean {
		return this.connected;
	}

	/**
	 * Handle an incoming webhook request.
	 * Called from the HTTP server's /webhook route.
	 */
	async handleRequest(req: Request): Promise<Response> {
		if (req.method !== "POST") {
			return Response.json({ status: "error", message: "Method not allowed" }, { status: 405 });
		}

		let body: string;
		let payload: WebhookPayload;

		try {
			body = await req.text();
			payload = JSON.parse(body) as WebhookPayload;
		} catch {
			return Response.json({ status: "error", message: "Invalid JSON" }, { status: 400 });
		}

		// Validate required fields
		if (!payload.message || !payload.conversation_id || !payload.timestamp || !payload.signature) {
			return Response.json(
				{ status: "error", message: "Missing required fields: message, conversation_id, timestamp, signature" },
				{ status: 400 },
			);
		}

		// Verify signature
		if (!this.verifySignature(body, String(payload.timestamp), payload.signature)) {
			return Response.json({ status: "error", message: "Invalid signature" }, { status: 401 });
		}

		// Verify timestamp freshness (5 minute window)
		const now = Date.now();
		const age = Math.abs(now - payload.timestamp);
		if (age > 5 * 60 * 1000) {
			return Response.json({ status: "error", message: "Timestamp too old" }, { status: 401 });
		}

		if (!this.messageHandler) {
			return Response.json({ status: "error", message: "No message handler configured" }, { status: 503 });
		}

		const conversationId = `webhook:${payload.conversation_id}`;

		const inbound: InboundMessage = {
			id: randomUUID(),
			channelId: this.id,
			conversationId,
			senderId: payload.user_id ?? "webhook",
			text: payload.message,
			timestamp: new Date(payload.timestamp),
			metadata: payload.metadata,
		};

		// Async mode: return immediately, send response to callback URL
		if (payload.callback_url) {
			const validation = isSafeCallbackUrl(payload.callback_url);
			if (!validation.safe) {
				return Response.json(
					{ status: "error", message: `Invalid callback URL: ${validation.reason}` },
					{ status: 400 },
				);
			}
			const taskId = randomUUID();
			this.callbackUrls.set(conversationId, payload.callback_url);

			// Fire and forget
			void this.messageHandler(inbound).catch((err: unknown) => {
				const msg = err instanceof Error ? err.message : String(err);
				console.error(`[webhook] Error handling async message: ${msg}`);
			});

			return Response.json({ status: "accepted", task_id: taskId } satisfies WebhookResponse);
		}

		// Sync mode: wait for the response
		const timeoutMs = this.config.syncTimeoutMs ?? 25_000;
		const result = await this.waitForResponse(conversationId, inbound, timeoutMs);

		if (result.type === "timeout") {
			return Response.json(
				{
					status: "accepted",
					task_id: result.taskId,
				} satisfies WebhookResponse,
				{ status: 202 },
			);
		}

		if (result.type === "error") {
			return Response.json({ status: "error", message: "Response timeout" } satisfies WebhookResponse, { status: 504 });
		}

		return Response.json({
			status: "ok",
			response: result.text,
		} satisfies WebhookResponse);
	}

	private async waitForResponse(
		conversationId: string,
		inbound: InboundMessage,
		timeoutMs: number,
	): Promise<WaitResult> {
		return new Promise<WaitResult>((resolve) => {
			const timer = setTimeout(() => {
				// Generate task ID for polling
				const taskId = randomUUID();
				this.pendingPolls.set(taskId, conversationId);
				this.conversationToTaskId.set(conversationId, taskId);
				this.pendingResponses.delete(conversationId);
				resolve({ type: "timeout", taskId });
			}, timeoutMs);

			this.pendingResponses.set(conversationId, {
				resolve: (text: string) => resolve({ type: "success", text }),
				timer,
			});

			// Process the message (will call send() which resolves the promise)
			void this.messageHandler?.(inbound).catch((err: unknown) => {
				clearTimeout(timer);
				this.pendingResponses.delete(conversationId);
				const msg = err instanceof Error ? err.message : String(err);
				console.error(`[webhook] Error handling sync message: ${msg}`);
				resolve({ type: "error" });
			});
		});
	}

	/**
	 * Handle a polling request for async task results.
	 * Called from the HTTP server's GET /webhook/poll route.
	 */
	async handlePollRequest(req: Request): Promise<Response> {
		const url = new URL(req.url);
		const taskId = url.searchParams.get("task_id");

		if (!taskId) {
			return Response.json({ status: "error", message: "Missing task_id parameter" }, { status: 400 });
		}

		// Check completed responses first
		const completed = this.completedResponses.get(taskId);
		if (completed) {
			this.completedResponses.delete(taskId);
			return Response.json({
				status: "ok",
				response: completed.response,
				metadata: { duration_ms: completed.completedAt - (completed.completedAt - 1) },
			} satisfies WebhookResponse);
		}

		// Check if still processing
		if (this.pendingPolls.has(taskId)) {
			return Response.json({ status: "accepted", task_id: taskId } satisfies WebhookResponse, { status: 202 });
		}

		// Unknown task
		return Response.json({ status: "error", message: "Unknown task_id" }, { status: 404 });
	}

	private async sendCallback(url: string, conversationId: string, text: string): Promise<void> {
		try {
			await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					conversation_id: conversationId.replace("webhook:", ""),
					status: "complete",
					response: text,
				}),
			});
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[webhook] Failed to send callback to ${url}: ${msg}`);
		}
	}

	/**
	 * Remove completed responses older than 5 minutes.
	 */
	private cleanupExpiredResponses(): void {
		const now = Date.now();
		const expiryMs = 5 * 60 * 1000; // 5 minutes

		for (const [taskId, completed] of this.completedResponses) {
			if (now - completed.completedAt > expiryMs) {
				this.completedResponses.delete(taskId);
			}
		}
	}

	private verifySignature(body: string, timestamp: string, signature: string): boolean {
		try {
			// Parse and remove signature field to compute HMAC over body without signature
			const parsed = JSON.parse(body);
			const { signature: _sig, ...rest } = parsed;
			const bodyWithoutSig = JSON.stringify(rest);
			const payload = `${timestamp}.${bodyWithoutSig}`;
			const hmac = new Bun.CryptoHasher("sha256", this.config.secret);
			hmac.update(payload);
			const expected = hmac.digest("hex");

			return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
		} catch {
			return false;
		}
	}
}
