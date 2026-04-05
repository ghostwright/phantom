/**
 * Email channel using ImapFlow (IMAP IDLE) and Nodemailer (SMTP).
 * Supports email threading via In-Reply-To/References headers,
 * HTML formatting, and attachment handling.
 */

import { randomUUID } from "node:crypto";
import type { Channel, ChannelCapabilities, InboundMessage, OutboundMessage, SentMessage } from "./types.ts";

export type EmailChannelConfig = {
	imap: {
		host: string;
		port: number;
		auth: { user: string; pass: string };
		tls?: boolean;
	};
	smtp: {
		host: string;
		port: number;
		auth: { user: string; pass: string };
		tls?: boolean;
	};
	fromAddress: string;
	fromName: string;
};

type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

// Track threads for In-Reply-To/References headers
type EmailThread = {
	messageId: string;
	references: string[];
	subject: string;
	from: string;
};

export class EmailChannel implements Channel {
	readonly id = "email";
	readonly name = "Email";
	readonly capabilities: ChannelCapabilities = {
		threads: true,
		richText: true,
		attachments: true,
		buttons: false,
	};

	private config: EmailChannelConfig;
	private messageHandler: ((message: InboundMessage) => Promise<void>) | null = null;
	private connectionState: ConnectionState = "disconnected";
	private imapClient: ImapFlowClient | null = null;
	private transporter: NodemailerTransport | null = null;
	private threads = new Map<string, EmailThread>();
	private idleAbort: AbortController | null = null;
	private idleLoopPromise: Promise<void> | null = null;

	constructor(config: EmailChannelConfig) {
		this.config = config;
	}

	async connect(): Promise<void> {
		if (this.connectionState === "connected") return;
		this.connectionState = "connecting";

		try {
			// Initialize IMAP
			const { ImapFlow } = await import("imapflow");
			this.imapClient = new ImapFlow({
				host: this.config.imap.host,
				port: this.config.imap.port,
				auth: this.config.imap.auth,
				secure: this.config.imap.tls ?? true,
				logger: false,
			}) as unknown as ImapFlowClient;

			await this.imapClient.connect();
			console.log("[email] IMAP connected");

			// Initialize SMTP
			const nodemailer = await import("nodemailer");
			this.transporter = nodemailer.createTransport({
				host: this.config.smtp.host,
				port: this.config.smtp.port,
				auth: this.config.smtp.auth,
				secure: this.config.smtp.tls ?? false,
			}) as unknown as NodemailerTransport;

			this.connectionState = "connected";
			console.log("[email] SMTP configured");

			// Start IDLE listening (tracked so disconnect can await it)
			this.idleLoopPromise = this.startIdleLoop();
		} catch (err: unknown) {
			this.connectionState = "error";
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[email] Failed to connect: ${msg}`);
			throw err;
		}
	}

	async disconnect(): Promise<void> {
		if (this.connectionState === "disconnected") return;

		this.connectionState = "disconnected";
		this.idleAbort?.abort();

		// Wait for the IDLE loop to finish and release the mailbox lock
		// before logging out, so a subsequent connect() won't race.
		if (this.idleLoopPromise) {
			await this.idleLoopPromise;
			this.idleLoopPromise = null;
		}

		try {
			await this.imapClient?.logout();
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[email] Error during IMAP disconnect: ${msg}`);
		}

		console.log("[email] Disconnected");
	}

	async send(conversationId: string, message: OutboundMessage): Promise<SentMessage> {
		if (!this.transporter) throw new Error("Email transport not initialized");

		const thread = this.threads.get(conversationId);
		const messageId = `<phantom-${randomUUID()}@${this.config.fromAddress.split("@")[1] ?? "phantom.local"}>`;

		const htmlBody = textToHtml(message.text);
		const subject = thread ? `Re: ${thread.subject}` : "Response from Phantom";

		const mailOptions: Record<string, unknown> = {
			from: `"${this.config.fromName}" <${this.config.fromAddress}>`,
			to: thread?.from ?? conversationId.replace("email:", ""),
			subject,
			html: htmlBody,
			text: message.text,
			messageId,
		};

		// Threading headers
		if (thread) {
			mailOptions.inReplyTo = thread.messageId;
			mailOptions.references = [...thread.references, thread.messageId].join(" ");
		}

		await this.transporter.sendMail(mailOptions);

		return {
			id: messageId,
			channelId: this.id,
			conversationId,
			timestamp: new Date(),
		};
	}

	onMessage(handler: (message: InboundMessage) => Promise<void>): void {
		this.messageHandler = handler;
	}

	isConnected(): boolean {
		return this.connectionState === "connected";
	}

	getConnectionState(): ConnectionState {
		return this.connectionState;
	}

	private async startIdleLoop(): Promise<void> {
		if (!this.imapClient) return;

		try {
			const lock = await this.imapClient.getMailboxLock("INBOX");

			try {
				// Process any unread messages first
				await this.processUnread();

				// Start IDLE loop
				while (this.connectionState === "connected") {
					this.idleAbort = new AbortController();
					try {
						await this.imapClient.idle({ abort: this.idleAbort.signal });
					} catch (err: unknown) {
						const msg = err instanceof Error ? err.message : String(err);
						if (msg.includes("abort")) break;
						console.warn(`[email] IDLE error: ${msg}`);
						break;
					}

					// IDLE was interrupted by new mail
					await this.processUnread();
				}
			} finally {
				lock.release();
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[email] IDLE loop error: ${msg}`);
		}
	}

	private async processUnread(): Promise<void> {
		if (!this.imapClient || !this.messageHandler) return;

		try {
			const messages = this.imapClient.fetch("1:*", {
				uid: true,
				flags: true,
				envelope: true,
				source: true,
			});

			for await (const msg of messages) {
				if (!msg.flags || msg.flags.has("\\Seen")) continue;

				const envelope = msg.envelope;
				if (!envelope) continue;

				const from = envelope.from?.[0];
				const fromAddress = from?.address ?? "unknown";
				const subject = envelope.subject ?? "(no subject)";
				const messageIdHeader = envelope.messageId ?? "";

				// Extract body text from source
				const bodyText = extractBodyText(msg.source?.toString() ?? "");
				if (!bodyText.trim()) continue;

				// Skip auto-replies
				if (isAutoReply(subject, bodyText)) continue;

				const conversationId = `email:${fromAddress}:${subject.replace(/^Re:\s*/i, "")}`;

				// Track the thread
				const references = envelope.inReplyTo ? [envelope.inReplyTo] : [];
				this.threads.set(conversationId, {
					messageId: messageIdHeader,
					references,
					subject: subject.replace(/^Re:\s*/i, ""),
					from: fromAddress,
				});

				const inbound: InboundMessage = {
					id: String(msg.uid),
					channelId: this.id,
					conversationId,
					senderId: fromAddress,
					senderName: from?.name,
					text: bodyText.trim(),
					timestamp: envelope.date ?? new Date(),
					metadata: {
						emailSubject: subject,
						emailFrom: fromAddress,
						emailMessageId: messageIdHeader,
					},
				};

				// Mark as seen
				try {
					await this.imapClient?.messageFlagsAdd(String(msg.uid), ["\\Seen"], { uid: true });
				} catch {
					// Non-critical
				}

				try {
					await this.messageHandler(inbound);
				} catch (err: unknown) {
					const errMsg = err instanceof Error ? err.message : String(err);
					console.error(`[email] Error handling email from ${fromAddress}: ${errMsg}`);
				}
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[email] Error processing unread: ${msg}`);
		}
	}
}

function textToHtml(text: string): string {
	const html = text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\n/g, "<br>")
		.replace(
			/```([\s\S]*?)```/g,
			'<pre style="background:#f4f4f4;padding:12px;border-radius:4px;font-family:monospace;font-size:13px">$1</pre>',
		)
		.replace(
			/`([^`]+)`/g,
			'<code style="background:#f0f0f0;padding:2px 4px;border-radius:3px;font-size:13px">$1</code>',
		);

	return `
<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;font-size:14px;line-height:1.6;color:#333">
${html}
<br><br>
<div style="color:#999;font-size:12px;border-top:1px solid #eee;padding-top:8px;margin-top:16px">
${"\u2014"} Phantom, your AI co-worker
</div>
</div>`.trim();
}

function extractBodyText(source: string): string {
	// Simple extraction: get text after headers (double newline)
	const headerEnd = source.indexOf("\r\n\r\n");
	if (headerEnd === -1) return source;
	const body = source.slice(headerEnd + 4);

	// Strip HTML tags if present
	return body
		.replace(/<[^>]*>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.trim();
}

function isAutoReply(subject: string, body: string): boolean {
	const autoReplyIndicators = [
		"out of office",
		"automatic reply",
		"auto-reply",
		"autoreply",
		"vacation reply",
		"delivery status notification",
		"undeliverable",
		"mailer-daemon",
	];
	const combined = `${subject} ${body}`.toLowerCase();
	return autoReplyIndicators.some((indicator) => combined.includes(indicator));
}

// Minimal type interfaces for ImapFlow and Nodemailer
type ImapFlowClient = {
	connect: () => Promise<void>;
	logout: () => Promise<void>;
	getMailboxLock: (mailbox: string) => Promise<{ release: () => void }>;
	idle: (options: { abort: AbortSignal }) => Promise<void>;
	fetch: (range: string, options: Record<string, unknown>) => AsyncIterable<ImapMessage>;
	messageFlagsAdd: (uid: string, flags: string[], options: Record<string, unknown>) => Promise<void>;
};

type ImapMessage = {
	uid: number;
	flags: Set<string>;
	envelope: {
		from?: Array<{ address?: string; name?: string }>;
		subject?: string;
		messageId?: string;
		date?: Date;
		inReplyTo?: string;
	};
	source?: Buffer;
};

type NodemailerTransport = {
	sendMail: (options: Record<string, unknown>) => Promise<unknown>;
};
