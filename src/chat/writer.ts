import type { SDKUserMessage } from "../agent/agent-sdk.ts";

type MessageParam = SDKUserMessage["message"];
import type { AgentRuntime } from "../agent/runtime.ts";
import type { ChatAttachmentStore } from "./attachment-store.ts";
import { autoRenameSession } from "./auto-rename.ts";
import { buildChatContinuityContext } from "./continuity-context.ts";
import type { ChatEventLog } from "./event-log.ts";
import type { UserAttachmentMetadata, UserTranscriptContentBlock } from "./message-builder.ts";
import type { ChatMessageStore } from "./message-store.ts";
import type { NotificationTriggerService } from "./notifications/triggers.ts";
import type { ChatRunTimelineStore } from "./run-timeline.ts";
import { DurableRunTimelineBuilder } from "./run-timeline.ts";
import { createTranslationContext, translateSdkMessage } from "./sdk-to-wire.ts";
import type { ChatSessionStore } from "./session-store.ts";
import type { StreamBus } from "./stream-bus.ts";
import type { ChatWireFrame } from "./types.ts";

export type ChatSessionWriterDeps = {
	sessionId: string;
	runtime: AgentRuntime;
	eventLog: ChatEventLog;
	messageStore: ChatMessageStore;
	attachmentStore?: ChatAttachmentStore;
	sessionStore: ChatSessionStore;
	timelineStore?: ChatRunTimelineStore;
	streamBus: StreamBus;
	notificationTriggers?: NotificationTriggerService;
};

export type ChatSessionWriterRunOptions = {
	attachments?: UserAttachmentMetadata[];
	transcriptContent?: string | UserTranscriptContentBlock[];
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

	async run(
		message: MessageParam,
		tabId: string,
		userText: string,
		options?: ChatSessionWriterRunOptions,
	): Promise<void> {
		if (!this.running) {
			throw new Error("Writer must be claimed before run()");
		}

		this.abortController = new AbortController();
		const attachments = options?.attachments ?? [];
		if (attachments.length > 0 && !this.deps.attachmentStore) {
			throw new Error("Attachment store is required to commit chat attachments");
		}

		const seqCounter = { current: this.deps.eventLog.getMaxSeq(this.deps.sessionId) };
		const msgSeq = this.deps.messageStore.getMaxSeq(this.deps.sessionId) + 1;
		const transcriptContent = options?.transcriptContent ?? userText;

		const userMessageId = this.deps.messageStore.commit({
			sessionId: this.deps.sessionId,
			seq: msgSeq,
			role: "user",
			contentJson: JSON.stringify(transcriptContent),
		});
		for (const attachment of attachments) {
			this.deps.attachmentStore?.commitToMessage(attachment.id, userMessageId);
		}
		this.deps.sessionStore.incrementMessageCount(this.deps.sessionId);
		this.deps.sessionStore.setFirstUserMessageAt(this.deps.sessionId);

		const userFrame: ChatWireFrame = {
			event: "user.message",
			message_id: userMessageId,
			text: userText,
			attachments,
			sent_at: new Date().toISOString(),
			source_tab_id: tabId,
		};
		const userSeq = this.emitFrame(userFrame, seqCounter);
		const timeline = DurableRunTimelineBuilder.start({
			sessionId: this.deps.sessionId,
			userMessageId,
			startSeq: userSeq,
			startedAt: userFrame.sent_at,
		});
		timeline.apply(userFrame, userSeq);
		this.persistTimeline(timeline);

		const assistantSeq = msgSeq + 1;
		const assistantMessageId = crypto.randomUUID();

		const ctx = createTranslationContext(this.deps.sessionId, assistantMessageId);
		const sessionKey = `web:${this.deps.sessionId}`;
		const startTime = Date.now();
		let resultText = "";
		let terminalErrorMessage: string | null = null;

		try {
			const sessionContextProvider = () =>
				buildChatContinuityContext({
					sessionId: this.deps.sessionId,
					eventLog: this.deps.eventLog,
					timelineStore: this.deps.timelineStore,
				});
			const sessionContext = sessionContextProvider();
			const response = await this.deps.runtime.runForChat(sessionKey, message, {
				signal: this.abortController.signal,
				sessionContext,
				sessionContextProvider,
				onSdkEvent: (sdkMsg: unknown) => {
					const frames = translateSdkMessage(sdkMsg as Record<string, unknown>, ctx);
					for (const frame of frames) {
						if (frame.event === "session.error") {
							terminalErrorMessage = frame.errors[0] ?? "Run failed.";
						}
						const seq = this.emitFrame(frame, seqCounter);
						if (timeline.apply(frame, seq)) {
							this.persistTimeline(timeline);
						}
					}
				},
			});

			resultText = response.text;

			if (terminalErrorMessage) {
				this.deps.sessionStore.updateCost(this.deps.sessionId, response.cost);
				if (this.deps.notificationTriggers) {
					this.deps.notificationTriggers
						.onHardError(this.deps.sessionId, terminalErrorMessage)
						.catch((triggerErr: unknown) => {
							const msg = triggerErr instanceof Error ? triggerErr.message : String(triggerErr);
							console.warn(`[push] trigger failed: ${msg}`);
						});
				}
				return;
			}

			this.deps.messageStore.commit({
				id: assistantMessageId,
				sessionId: this.deps.sessionId,
				seq: assistantSeq,
				role: "assistant",
				contentJson: JSON.stringify(response.text),
				inputTokens: response.cost.inputTokens,
				outputTokens: response.cost.outputTokens,
				costUsd: response.cost.totalUsd,
				stopReason: "end_turn",
			});
			timeline.setAssistantMessageId(assistantMessageId);
			this.persistTimeline(timeline);

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
				const abortedSeq = this.emitFrame(abortedFrame, seqCounter);
				if (timeline.apply(abortedFrame, abortedSeq)) {
					this.persistTimeline(timeline);
				}

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
				const doneSeq = this.emitFrame(doneFrame, seqCounter);
				if (timeline.apply(doneFrame, doneSeq)) {
					this.persistTimeline(timeline);
				}
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
				const errorSeq = this.emitFrame(errorFrame, seqCounter);
				if (timeline.apply(errorFrame, errorSeq)) {
					this.persistTimeline(timeline);
				}

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

	private emitFrame(frame: ChatWireFrame, seqCounter: { current: number }): number {
		const seq = ++seqCounter.current;
		// session.created carries a seq field - assign it here so payload matches persisted seq
		if (frame.event === "session.created") {
			(frame as { seq: number }).seq = seq;
		}
		this.deps.eventLog.append(this.deps.sessionId, null, seq, frame.event, frame);
		this.deps.streamBus.publish(this.deps.sessionId, frame, seq);
		return seq;
	}

	private persistTimeline(timeline: DurableRunTimelineBuilder): void {
		this.deps.timelineStore?.upsert(timeline.toUpsertParams());
	}
}
