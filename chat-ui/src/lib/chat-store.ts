// Chat state store and SSE frame dispatcher.
// Tool dispatchers live in chat-dispatch-tools.ts.

import { attachActivityToolsToAssistant, beginRunActivityState, updateRunActivityForFrame } from "./chat-activity";
import {
	dispatchToolAborted,
	dispatchToolBlocked,
	dispatchToolInputDelta,
	dispatchToolInputEnd,
	dispatchToolResult,
	dispatchToolRunning,
	dispatchToolStart,
} from "./chat-dispatch-tools";
import type { ChatAttachmentView, ChatMessage, ChatState } from "./chat-types";

type Listener = () => void;

function createInitialState(): ChatState {
	return {
		messages: [],
		activeToolCalls: new Map(),
		thinkingBlocks: new Map(),
		textBlocks: new Map(),
		runActivity: null,
		isStreaming: false,
		streamConnectionState: "idle",
		lastSeq: 0,
		sessionId: null,
	};
}

export type ChatStore = {
	getState: () => ChatState;
	subscribe: (listener: Listener) => () => void;
	update: (fn: (s: ChatState) => ChatState) => void;
	reset: (sessionId: string | null) => void;
};

export function createChatStore(): ChatStore {
	let state = createInitialState();
	const listeners = new Set<Listener>();

	function notify(): void {
		for (const fn of listeners) fn();
	}

	return {
		getState: () => state,
		subscribe: (listener: Listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		update: (fn: (s: ChatState) => ChatState) => {
			state = fn(state);
			notify();
		},
		reset: (sessionId: string | null) => {
			state = { ...createInitialState(), sessionId };
			notify();
		},
	};
}

export function beginRunActivity(store: ChatStore): void {
	store.update((s) => ({ ...beginRunActivityState(s), isStreaming: true, streamConnectionState: "starting" }));
}

export type ChatFrameSource = "live" | "replay";

export type DispatchFrameOptions = {
	source?: ChatFrameSource;
};

function findMessageIndex(messages: ChatMessage[], messageId: string): number {
	return messages.findIndex((message) => message.id === messageId);
}

function upsertMessage(messages: ChatMessage[], message: ChatMessage): ChatMessage[] {
	const existingIndex = findMessageIndex(messages, message.id);
	if (existingIndex === -1) return [...messages, message];
	const next = [...messages];
	const existing = next[existingIndex];
	if (!existing) return messages;
	const nextAttachments = mergeAttachments(existing.attachments, message.attachments);
	next[existingIndex] = {
		...existing,
		...message,
		content: existing.content.length > 0 ? existing.content : message.content,
		attachments: nextAttachments,
		status: existing.status === "committed" ? existing.status : message.status,
		runTimeline: existing.runTimeline ?? message.runTimeline,
	};
	return next;
}

function mergeAttachments(
	existing: ChatAttachmentView[] | undefined,
	incoming: ChatAttachmentView[] | undefined,
): ChatAttachmentView[] | undefined {
	if (!existing || existing.length === 0) return incoming;
	if (!incoming || incoming.length === 0) return existing;
	const seen = new Set(existing.map((attachment) => attachment.id));
	return [...existing, ...incoming.filter((attachment) => !seen.has(attachment.id))];
}

function normalizeAttachment(value: unknown): ChatAttachmentView | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (typeof record.id !== "string" || record.id.length === 0) return null;
	const filename = typeof record.filename === "string" && record.filename.length > 0 ? record.filename : "file";
	const mimeType =
		typeof record.mime_type === "string"
			? record.mime_type
			: typeof record.mimeType === "string"
				? record.mimeType
				: "application/octet-stream";
	const sizeValue = record.size_bytes ?? record.sizeBytes;
	const previewValue = record.preview_url ?? record.previewUrl;
	return {
		id: record.id,
		filename,
		mimeType,
		sizeBytes: typeof sizeValue === "number" ? sizeValue : null,
		previewUrl: typeof previewValue === "string" ? previewValue : `/chat/attachments/${record.id}/preview`,
	};
}

function normalizeAttachments(value: unknown): ChatAttachmentView[] {
	if (!Array.isArray(value)) return [];
	return value.map(normalizeAttachment).filter((attachment): attachment is ChatAttachmentView => attachment !== null);
}

function updateTextBlockInContent(s: ChatState, blockId: string, updater: (text: string) => string): ChatState {
	const block = s.textBlocks.get(blockId);
	if (!block) return s;
	const blocks = new Map(s.textBlocks);
	const nextText = updater(block.text);
	blocks.set(blockId, { ...block, text: nextText });
	if (block.isReplayShadow) {
		return { ...s, textBlocks: blocks };
	}
	const msgs = [...s.messages];
	const index = findMessageIndex(msgs, block.messageId);
	const target = index >= 0 ? msgs[index] : undefined;
	if (target && target.role === "assistant") {
		const content = target.content.map((b) =>
			b.type === "text" && b.blockId === blockId ? { ...b, text: updater(b.text ?? "") } : b,
		);
		msgs[index] = { ...target, content };
	}
	return { ...s, messages: msgs, textBlocks: blocks };
}

export function dispatchFrame(
	store: ChatStore,
	event: string,
	dataStr: string,
	options: DispatchFrameOptions = {},
): void {
	let data: Record<string, unknown>;
	try {
		data = JSON.parse(dataStr) as Record<string, unknown>;
	} catch {
		return;
	}
	const source = options.source ?? "live";

	switch (event) {
		case "user.message":
			store.update((s) =>
				updateRunActivityForFrame(
					{
						...s,
						messages: upsertMessage(s.messages, {
							id: data.message_id as string,
							role: "user" as const,
							content: [{ type: "text", text: data.text as string }],
							attachments: normalizeAttachments(data.attachments),
							createdAt: data.sent_at as string,
							status: "committed" as const,
						}),
					},
					event,
					data,
				),
			);
			break;

		case "message.assistant_start":
			store.update((s) => {
				const messageId = data.message_id as string;
				const existingIndex = findMessageIndex(s.messages, messageId);
				const existing = existingIndex >= 0 ? s.messages[existingIndex] : undefined;
				const messages =
					existing?.role === "assistant"
						? s.messages
						: [
								...s.messages,
								{
									id: messageId,
									role: "assistant" as const,
									content: [],
									createdAt: new Date().toISOString(),
									status: "streaming" as const,
								},
							];
				return updateRunActivityForFrame(
					attachActivityToolsToAssistant(
						{
							...s,
							messages,
						},
						messageId,
					),
					event,
					data,
				);
			});
			break;

		case "message.text_start":
			store.update((s) => {
				const blockId = data.text_block_id as string;
				if (s.textBlocks.has(blockId)) return s;
				const messageId = data.message_id as string;
				const msgs = [...s.messages];
				const index = findMessageIndex(msgs, messageId);
				const target = index >= 0 ? msgs[index] : undefined;
				if (!target || target.role !== "assistant") return s;
				const blocks = new Map(s.textBlocks);
				const isReplayShadow = source === "replay" && target.status === "committed";
				blocks.set(blockId, { messageId, text: "", isReplayShadow });
				if (!isReplayShadow && !target.content.some((block) => block.type === "text" && block.blockId === blockId)) {
					msgs[index] = {
						...target,
						content: [...target.content, { type: "text", blockId, text: "" }],
					};
				}
				return { ...s, messages: msgs, textBlocks: blocks };
			});
			break;

		case "message.text_delta":
			store.update((s) => {
				const blockId = data.text_block_id as string;
				const delta = data.delta as string;
				return updateTextBlockInContent(s, blockId, (t) => t + delta);
			});
			break;

		case "message.text_end":
			break;

		case "message.text_reconcile":
			store.update((s) => {
				const blockId = data.text_block_id as string;
				const fullText = data.full_text as string;
				return updateTextBlockInContent(s, blockId, () => fullText);
			});
			break;

		case "message.thinking_start":
			store.update((s) => {
				const blocks = new Map(s.thinkingBlocks);
				blocks.set(data.thinking_block_id as string, {
					messageId: data.message_id as string,
					text: "",
					redacted: data.redacted as boolean,
					isStreaming: true,
				});
				return { ...s, thinkingBlocks: blocks };
			});
			break;

		case "message.thinking_delta":
			store.update((s) => {
				const blocks = new Map(s.thinkingBlocks);
				const blockId = data.thinking_block_id as string;
				const block = blocks.get(blockId);
				if (block) {
					blocks.set(blockId, {
						...block,
						text: block.text + (data.delta as string),
					});
				}
				return { ...s, thinkingBlocks: blocks };
			});
			break;

		case "message.thinking_end":
			store.update((s) => {
				const blocks = new Map(s.thinkingBlocks);
				const blockId = data.thinking_block_id as string;
				const block = blocks.get(blockId);
				if (block) {
					blocks.set(blockId, {
						...block,
						isStreaming: false,
						durationMs: data.duration_ms as number | undefined,
					});
				}
				return { ...s, thinkingBlocks: blocks };
			});
			break;

		case "message.tool_call_start":
			dispatchToolStart(store, data);
			break;
		case "message.tool_call_input_delta":
			dispatchToolInputDelta(store, data);
			break;
		case "message.tool_call_input_end":
			dispatchToolInputEnd(store, data);
			break;
		case "message.tool_call_running":
			dispatchToolRunning(store, data);
			store.update((s) => updateRunActivityForFrame(s, event, data));
			break;
		case "message.tool_call_result":
			dispatchToolResult(store, data);
			store.update((s) => updateRunActivityForFrame(s, event, data));
			break;
		case "message.tool_call_blocked":
			dispatchToolBlocked(store, data);
			store.update((s) => updateRunActivityForFrame(s, event, data));
			break;
		case "message.tool_call_aborted":
			dispatchToolAborted(store, data);
			store.update((s) => updateRunActivityForFrame(s, event, data));
			break;

		case "message.assistant_end":
			store.update((s) => {
				const msgs = [...s.messages];
				const thinkingBlocks = new Map(s.thinkingBlocks);
				const messageId = data.message_id as string;
				const index = findMessageIndex(msgs, messageId);
				const target = index >= 0 ? msgs[index] : undefined;
				if (target && target.role === "assistant" && target.status === "streaming") {
					msgs[index] = { ...target, status: "committed" };
				}
				for (const [blockId, block] of thinkingBlocks) {
					if (block.messageId === messageId && block.isStreaming) {
						thinkingBlocks.set(blockId, { ...block, isStreaming: false });
					}
				}
				return { ...s, messages: msgs, thinkingBlocks };
			});
			break;

		case "session.done":
		case "session.error":
		case "session.aborted":
			store.update((s) => {
				const msgs = [...s.messages];
				const isRecoveryError = event === "session.error" && data.subtype === "server_restart";
				const messageId = typeof data.message_id === "string" ? data.message_id : null;
				const index =
					messageId !== null
						? findMessageIndex(msgs, messageId)
						: [...msgs]
								.reverse()
								.findIndex((message) => message.role === "assistant" && message.status === "streaming");
				const normalizedIndex = messageId !== null ? index : index >= 0 ? msgs.length - 1 - index : -1;
				const target = normalizedIndex >= 0 ? msgs[normalizedIndex] : undefined;
				if (target && target.role === "assistant") {
					if (event === "session.error") {
						msgs[normalizedIndex] = { ...target, status: "error" };
					} else if (target.status === "streaming") {
						msgs[normalizedIndex] = { ...target, status: "committed" };
					}
				}
				return {
					...s,
					messages: msgs,
					isStreaming: false,
					streamConnectionState: isRecoveryError ? "interrupted" : "detached",
				};
			});
			store.update((s) => updateRunActivityForFrame(s, event, data));
			break;

		case "session.created":
			store.update((s) => ({
				...s,
				streamConnectionState: s.isStreaming ? "attached" : s.streamConnectionState,
			}));
			store.update((s) => updateRunActivityForFrame(s, event, data));
			break;
		case "session.resumed":
			store.update((s) => ({
				...s,
				isStreaming: data.writer_active === true,
				streamConnectionState: "replaying",
			}));
			store.update((s) => updateRunActivityForFrame(s, event, data));
			break;
		case "session.caught_up":
			store.update((s) => ({
				...s,
				streamConnectionState: s.runActivity?.isActive || s.isStreaming ? "attached" : "detached",
			}));
			store.update((s) => updateRunActivityForFrame(s, event, data));
			break;
		case "session.rate_limit":
		case "session.compact_boundary":
		case "session.status":
		case "session.mcp_status":
		case "session.truncated_backlog":
		case "message.subagent_start":
		case "message.subagent_progress":
		case "message.subagent_end":
			store.update((s) => updateRunActivityForFrame(s, event, data));
			break;

		case "session.suggestion":
			break;

		default:
			break;
	}
}
