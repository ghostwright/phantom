/**
 * Generic webhook channel with HMAC-SHA256 signature verification.
 * Supports synchronous (inline) and asynchronous (callback URL or polling) response modes.
 * Compatible with Zapier, Make, n8n, and custom integrations.
 */

import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Database } from "bun:sqlite";
import { isSafeCallbackUrl } from "../utils/url-validator.ts";
import type { Channel, ChannelCapabilities, InboundMessage, OutboundMessage, SentMessage } from "./types.ts";

export type WebhookChannelConfig = {
	secret: string;
	/** Max time in ms to wait for agent response in sync mode. Default 25000 (25s). */
	syncTimeoutMs?: number;
	/** How long to retain completed webhook responses, in ms. Default 7 days. */
	responseRetentionMs?: number;
};

export type WebhookPayload = {
	message: string;
	conversation_id: string;
	user_id?: string;
	thread_id?: string;
	metadata?: Record<string, unknown>;
	callback_url?: string;
	/** Set to true (or omit callback_url) to use polling mode instead of sync. */
	async?: boolean;
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

export type WebhookPollResponse = {
	status: "pending" | "completed" | "failed" | "not_found";
	task_id: string;
	response?: string;
	error?: string;
	created_at?: string;
	completed_at?: string;
};

type PendingResponse = {
	resolve: (text: string) => void;
	timer: ReturnType<typeof setTimeout>;
};

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
	private db: Database | null;
	private messageHandler: ((message: InboundMessage) => Promise<void>) | null = null;
	private connected = false;
	// Track pending sync responses: conversationId -> resolver
	private pendingResponses = new Map<string, PendingResponse>();
	// Track async callback URLs: conversationId -> callbackUrl
	private callbackUrls = new Map<string, string>();
	// Track async polling tasks: conversationId -> taskId
	private pollingTasks = new Map<string, string>();

	constructor(config: WebhookChannelConfig, db?: Database) {
		this.config = config;
		this.db = db ?? null;
	}

	async connect(): Promise<void> {
		this.connected = true;
		if (this.db) {
			this.cleanupOldResponses();
		}
		console.log("[webhook] Channel ready");
	}

	async disconnect(): Promise<void> {
		// Clean up pending responses
		for (const [, pending] of this.pendingResponses) {
			clearTimeout(pending.timer);
			pending.resolve("");
		}
		this.pendingResponses.clear();
		this.callbackUrls.clear();
		this.pollingTasks.clear();
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

		// Check if there's an async callback URL
		const callbackUrl = this.callbackUrls.get(conversationId);
		if (callbackUrl) {
			await this.sendCallback(callbackUrl, conversationId, message.text);
			this.callbackUrls.delete(conversationId);
		}

		// Check if there's a polling task waiting for this response
		const taskId = this.pollingTasks.get(conversationId);
		if (taskId && this.db) {
			this.db.run(
				"UPDATE webhook_responses SET status = 'completed', response_text = ?, completed_at = datetime('now') WHERE id = ?",
				[message.text, taskId],
			);
			this.pollingTasks.delete(conversationId);
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
		const url = new URL(req.url);

		// GET /webhook/poll/:taskId - poll for async response
		if (req.method === "GET" && url.pathname.startsWith("/webhook/poll/")) {
			const taskId = url.pathname.slice("/webhook/poll/".length);
			return this.handlePoll(taskId);
		}

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

		// Polling mode: persist task in DB, return 202 with task_id
		if (payload.async && this.db) {
			const taskId = randomUUID();

			this.db.run("INSERT INTO webhook_responses (id, conversation_id, status, request_text) VALUES (?, ?, 'pending', ?)", [
				taskId,
				conversationId,
				payload.message,
			]);

			this.pollingTasks.set(conversationId, taskId);

			// Fire and forget
			void this.messageHandler(inbound).catch((err: unknown) => {
				const errMsg = err instanceof Error ? err.message : String(err);
				console.error(`[webhook] Error handling async message: ${errMsg}`);
				// Mark the task as failed in the DB
				if (this.db) {
					this.db.run(
						"UPDATE webhook_responses SET status = 'failed', error_message = ?, completed_at = datetime('now') WHERE id = ?",
						[errMsg, taskId],
					);
				}
				this.pollingTasks.delete(conversationId);
			});

			return Response.json({ status: "accepted", task_id: taskId } satisfies WebhookResponse, { status: 202 });
		}

		// Sync mode: wait for the response (original behavior)
		const timeoutMs = this.config.syncTimeoutMs ?? 25_000;
		const responseText = await this.waitForResponse(conversationId, inbound, timeoutMs);

		if (responseText === null) {
			return Response.json({ status: "error", message: "Response timeout" } satisfies WebhookResponse, { status: 504 });
		}

		return Response.json({
			status: "ok",
			response: responseText,
		} satisfies WebhookResponse);
	}

	private handlePoll(taskId: string): Response {
		if (!this.db) {
			return Response.json(
				{ status: "error", message: "Polling not available: no database configured" } as WebhookResponse,
				{ status: 503 },
			);
		}

		if (!taskId) {
			return Response.json({ status: "error", message: "Missing task_id" } as WebhookResponse, { status: 400 });
		}

		const row = this.db
			.query("SELECT id, status, response_text, error_message, created_at, completed_at FROM webhook_responses WHERE id = ?")
			.get(taskId) as {
			id: string;
			status: string;
			response_text: string | null;
			error_message: string | null;
			created_at: string;
			completed_at: string | null;
		} | null;

		if (!row) {
			return Response.json({ status: "not_found", task_id: taskId } satisfies WebhookPollResponse, { status: 404 });
		}

		const response: WebhookPollResponse = {
			status: row.status as WebhookPollResponse["status"],
			task_id: row.id,
			created_at: row.created_at,
			completed_at: row.completed_at ?? undefined,
		};

		if (row.status === "completed" && row.response_text) {
			response.response = row.response_text;
		}

		if (row.status === "failed" && row.error_message) {
			response.error = row.error_message;
		}

		return Response.json(response);
	}

	private async waitForResponse(
		conversationId: string,
		inbound: InboundMessage,
		timeoutMs: number,
	): Promise<string | null> {
		return new Promise<string | null>((resolve) => {
			const timer = setTimeout(() => {
				this.pendingResponses.delete(conversationId);
				resolve(null);
			}, timeoutMs);

			this.pendingResponses.set(conversationId, {
				resolve: (text: string) => resolve(text),
				timer,
			});

			// Process the message (will call send() which resolves the promise)
			void this.messageHandler?.(inbound).catch((err: unknown) => {
				clearTimeout(timer);
				this.pendingResponses.delete(conversationId);
				const msg = err instanceof Error ? err.message : String(err);
				console.error(`[webhook] Error handling sync message: ${msg}`);
				resolve(null);
			});
		});
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

	private verifySignature(body: string, timestamp: string, signature: string): boolean {
		const payload = `${timestamp}.${body}`;
		const hmac = new Bun.CryptoHasher("sha256", this.config.secret);
		hmac.update(payload);
		const expected = hmac.digest("hex");

		try {
			return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
		} catch {
			return false;
		}
	}

	private cleanupOldResponses(): void {
		if (!this.db) return;
		const retentionMs = this.config.responseRetentionMs ?? 7 * 24 * 60 * 60 * 1000;
		const cutoff = new Date(Date.now() - retentionMs).toISOString();
		const result = this.db.run("DELETE FROM webhook_responses WHERE completed_at IS NOT NULL AND completed_at < ?", [
			cutoff,
		]);
		if (result.changes > 0) {
			console.log(`[webhook] Cleaned up ${result.changes} old response(s)`);
		}
	}
}
