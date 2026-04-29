import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

type MessageParam = SDKUserMessage["message"];
import type { AgentRuntime } from "../agent/runtime.ts";
import { autoRenameSession } from "./auto-rename.ts";
import type { ChatEventLog } from "./event-log.ts";
import type { ChatMessageStore } from "./message-store.ts";
import type { NotificationTriggerService } from "./notifications/triggers.ts";
import { createTranslationContext, translateSdkMessage } from "./sdk-to-wire.ts";
import type { ChatSessionStore } from "./session-store.ts";
import type { StreamBus } from "./stream-bus.ts";
import type { ChatWireFrame } from "./types.ts";

export type ChatSessionWriterDeps = {
	sessionId: string;
	runtime: AgentRuntime;
	eventLog: ChatEventLog;
	messageStore: ChatMessageStore;
	sessionStore: ChatSessionStore;
	streamBus: StreamBus;
	notificationTriggers?: NotificationTriggerService;
};

// Active writers keyed by sessionId for abort and busy-check lookups
const activeWriters = new Map<string, ChatSessionWriter>();

export function getActiveWriter(sessionId: string): ChatSessionWriter | undefined {
	return activeWriters.get(sessionId);
}

export class ChatSessionWriter {
	private deps: ChatSessionWriterDeps;
	private abortController: AbortController | null = null;
	private running = false;

	constructor(deps: ChatSessionWriterDeps) {
		this.deps = deps;
	}

	get isActive(): boolean {
		return this.running;
	}

	get sessionId(): string {
		return this.deps.sessionId;
	}

	claim(): void {
		this.running = true;
		activeWriters.set(this.deps.sessionId, this);
	}

	async run(message: MessageParam, tabId: string, userText: string): Promise<void> {
		if (!this.running) {
			throw new Error("Writer must be claimed before run()");
		}

		this.abortController = new AbortController();

		const seqCounter = { current: this.deps.eventLog.getMaxSeq(this.deps.sessionId) };
		const msgSeq = this.deps.messageStore.getMaxSeq(this.deps.sessionId) + 1;

		const userMessageId = this.deps.messageStore.commit({
			sessionId: this.deps.sessionId,
			seq: msgSeq,
			role: "user",
			contentJson: JSON.stringify(typeof message === "string" ? message : message.content),
		});
		this.deps.sessionStore.incrementMessageCount(this.deps.sessionId);
		this.deps.sessionStore.setFirstUserMessageAt(this.deps.sessionId);

		const userFrame: ChatWireFrame = {
			event: "user.message",
			message_id: userMessageId,
			text: userText,
			attachments: [],
			sent_at: new Date().toISOString(),
			source_tab_id: tabId,
		};
		this.emitFrame(userFrame, seqCounter);

		const assistantSeq = msgSeq + 1;
		const assistantMessageId = crypto.randomUUID();

		const ctx = createTranslationContext(this.deps.sessionId, assistantMessageId);
		const sessionKey = `web:${this.deps.sessionId}`;
		const startTime = Date.now();
		let resultText = "";

		try {
			const response = await this.deps.runtime.runForChat(sessionKey, message, {
				signal: this.abortController.signal,
				onSdkEvent: (sdkMsg: unknown) => {
					const frames = translateSdkMessage(sdkMsg as Record<string, unknown>, ctx);
					for (const frame of frames) {
						this.emitFrame(frame, seqCounter);
					}
				},
			});

			resultText = response.text;

			this.deps.messageStore.commit({
				sessionId: this.deps.sessionId,
				seq: assistantSeq,
				role: "assistant",
				contentJson: JSON.stringify(response.text),
				inputTokens: response.cost.inputTokens,
				outputTokens: response.cost.outputTokens,
				costUsd: response.cost.totalUsd,
				stopReason: "end_turn",
			});

			this.deps.sessionStore.incrementMessageCount(this.deps.sessionId);
			this.deps.sessionStore.updateCost(this.deps.sessionId, response.cost);

			// Fire auto-rename after first turn (non-blocking)
			autoRenameSession(this.deps.runtime, this.deps.sessionStore, this.deps.sessionId, userText, resultText).catch(
				(err: unknown) => {
					const msg = err instanceof Error ? err.message : String(err);
					console.warn(`[chat-writer] Auto-rename failed: ${msg}`);
				},
			);

			// Fire push notification trigger (non-blocking)
			if (this.deps.notificationTriggers) {
				const title = this.deps.sessionStore.get(this.deps.sessionId)?.title ?? "";
				this.deps.notificationTriggers
					.onSessionDone(this.deps.sessionId, response.durationMs, title)
					.catch((triggerErr: unknown) => {
						const msg = triggerErr instanceof Error ? triggerErr.message : String(triggerErr);
						console.warn(`[push] trigger failed: ${msg}`);
					});
			}
		} catch (err: unknown) {
			const isAbort = err instanceof Error && err.name === "AbortError";
			const errorMsg = err instanceof Error ? err.message : String(err);

			if (isAbort) {
				const abortedFrame: ChatWireFrame = {
					event: "session.aborted",
					session_id: this.deps.sessionId,
					message_id: assistantMessageId,
					aborted_at: new Date().toISOString(),
					cost_usd: 0,
					duration_ms: Date.now() - startTime,
				};
				this.emitFrame(abortedFrame, seqCounter);

				const doneFrame: ChatWireFrame = {
					event: "session.done",
					session_id: this.deps.sessionId,
					message_id: assistantMessageId,
					stop_reason: "aborted",
					usage: { input_tokens: 0, output_tokens: 0 },
					cost_usd: 0,
					duration_ms: Date.now() - startTime,
					num_turns: 0,
				};
				this.emitFrame(doneFrame, seqCounter);
			} else {
				const errorFrame: ChatWireFrame = {
					event: "session.error",
					session_id: this.deps.sessionId,
					message_id: assistantMessageId,
					subtype: "error_during_execution",
					recoverable: true,
					errors: [errorMsg],
					cost_usd: 0,
					duration_ms: Date.now() - startTime,
				};
				this.emitFrame(errorFrame, seqCounter);

				if (this.deps.notificationTriggers) {
					this.deps.notificationTriggers.onHardError(this.deps.sessionId, errorMsg).catch((triggerErr: unknown) => {
						const msg = triggerErr instanceof Error ? triggerErr.message : String(triggerErr);
						console.warn(`[push] trigger failed: ${msg}`);
					});
				}
			}
		} finally {
			this.running = false;
			this.abortController = null;
			activeWriters.delete(this.deps.sessionId);
		}
	}

	abort(): void {
		if (this.abortController) {
			this.abortController.abort();
		}
	}

	private emitFrame(frame: ChatWireFrame, seqCounter: { current: number }): void {
		const seq = ++seqCounter.current;
		// session.created carries a seq field - assign it here so payload matches persisted seq
		if (frame.event === "session.created") {
			(frame as { seq: number }).seq = seq;
		}
		this.deps.eventLog.append(this.deps.sessionId, null, seq, frame.event, frame);
		this.deps.streamBus.publish(this.deps.sessionId, frame, seq);
	}
}
