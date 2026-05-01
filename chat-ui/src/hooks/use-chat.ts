import { runTimelineSummaryToView } from "@/lib/chat-activity";
import { parseMessageContentJson } from "@/lib/chat-message-content";
import { type ChatStore, beginRunActivity, createChatStore, dispatchFrame } from "@/lib/chat-store";
import type {
	ChatMessage,
	RunActivityState,
	RunTimelineView,
	StreamConnectionState,
	ThinkingBlockState,
	ToolCallState,
} from "@/lib/chat-types";
import { type SessionDetail, abortSession, getSession, resumeSession } from "@/lib/client";
import { useCallback, useRef, useSyncExternalStore } from "react";

export function useChat(sessionId: string | null): {
	messages: ChatMessage[];
	activeToolCalls: Map<string, ToolCallState>;
	thinkingBlocks: Map<string, ThinkingBlockState>;
	runActivity: RunActivityState | null;
	isStreaming: boolean;
	streamConnectionState: StreamConnectionState;
	sendMessage: (text: string, attachmentIds?: string[]) => void;
	abort: () => void;
	loadSession: (id: string) => void;
} {
	const storeRef = useRef<ChatStore>(createChatStore());
	const abortRef = useRef<AbortController | null>(null);
	const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
	const generationRef = useRef(0);
	const store = storeRef.current;

	const state = useSyncExternalStore(store.subscribe, store.getState);

	const processSSEStream = useCallback(
		async (body: ReadableStream<Uint8Array>, gen: number, mode: "live" | "resume" = "live") => {
			const decoder = new TextDecoder();
			const reader = body.getReader();
			readerRef.current = reader;
			let buffer = "";
			let currentEvent = "";
			let currentData = "";
			let replaying = mode === "resume";

			while (true) {
				if (generationRef.current !== gen) return;
				const { done, value } = await reader.read();
				if (done) break;
				if (generationRef.current !== gen) return;
				buffer += decoder.decode(value, { stream: true });

				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";

				for (const line of lines) {
					if (line.startsWith(":")) continue;
					if (line.startsWith("event: ")) {
						currentEvent = line.slice(7).trim();
					} else if (line.startsWith("data:")) {
						const payload = line[5] === " " ? line.slice(6) : line.slice(5);
						currentData += (currentData ? "\n" : "") + payload;
					} else if (line.startsWith("id: ")) {
						const seq = Number.parseInt(line.slice(4), 10);
						if (!Number.isNaN(seq)) {
							store.update((s) => ({
								...s,
								lastSeq: Math.max(s.lastSeq, seq),
							}));
						}
					} else if (line === "" && currentEvent && currentData) {
						if (generationRef.current !== gen) return;
						dispatchFrame(store, currentEvent, currentData, { source: replaying ? "replay" : "live" });
						if (currentEvent === "session.caught_up") {
							replaying = false;
						}
						currentEvent = "";
						currentData = "";
					}
				}
			}

			if (generationRef.current === gen) {
				store.update((s) => {
					const interrupted = s.runActivity?.isActive === true && s.streamConnectionState !== "detached";
					return {
						...s,
						isStreaming: false,
						streamConnectionState: interrupted
							? "interrupted"
							: s.streamConnectionState === "attached"
								? "detached"
								: s.streamConnectionState,
						runActivity:
							interrupted && s.runActivity
								? {
										...s.runActivity,
										status: "error",
										currentLabel: "Connection interrupted.",
										updatedAt: new Date().toISOString(),
										isActive: false,
									}
								: s.runActivity,
					};
				});
			}
			readerRef.current = null;
		},
		[store],
	);

	const sendMessage = useCallback(
		(text: string, attachmentIds?: string[]) => {
			if (!sessionId) return;

			readerRef.current?.cancel();
			readerRef.current = null;
			abortRef.current?.abort();
			const gen = ++generationRef.current;
			const controller = new AbortController();
			abortRef.current = controller;

			beginRunActivity(store);

			const payload: Record<string, unknown> = {
				session_id: sessionId,
				text,
				tab_id: `web-${Date.now()}`,
			};
			if (attachmentIds && attachmentIds.length > 0) {
				payload.attachment_ids = attachmentIds;
			}

			fetch("/chat/stream", {
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
				signal: controller.signal,
			})
				.then((res) => {
					if (generationRef.current !== gen) return;
					if (!res.ok || !res.body) {
						store.update((s) => ({
							...s,
							isStreaming: false,
							streamConnectionState: "detached",
							runActivity: s.runActivity
								? {
										...s.runActivity,
										status: "error",
										currentLabel: "Run could not start.",
										updatedAt: new Date().toISOString(),
										isActive: false,
									}
								: null,
						}));
						return;
					}
					store.update((s) => ({ ...s, streamConnectionState: "attached" }));
					return processSSEStream(res.body, gen, "live");
				})
				.catch(() => {
					if (generationRef.current === gen) {
						store.update((s) => ({
							...s,
							isStreaming: false,
							streamConnectionState: "interrupted",
							runActivity: s.runActivity
								? {
										...s.runActivity,
										status: "error",
										currentLabel: "Connection interrupted.",
										updatedAt: new Date().toISOString(),
										isActive: false,
									}
								: null,
						}));
					}
				});
		},
		[sessionId, store, processSSEStream],
	);

	const abort = useCallback(() => {
		++generationRef.current;
		readerRef.current?.cancel();
		readerRef.current = null;
		abortRef.current?.abort();
		if (sessionId) {
			abortSession(sessionId).catch(() => {});
		}
		store.update((s) => ({
			...s,
			isStreaming: false,
			streamConnectionState: "detached",
			runActivity: s.runActivity
				? {
						...s.runActivity,
						status: "aborted",
						currentLabel: "Run stopped.",
						updatedAt: new Date().toISOString(),
						isActive: false,
					}
				: null,
		}));
	}, [sessionId, store]);

	const loadSession = useCallback(
		(id: string) => {
			readerRef.current?.cancel();
			readerRef.current = null;
			abortRef.current?.abort();
			const gen = ++generationRef.current;
			store.reset(id);
			getSession(id)
				.then((detail: SessionDetail) => {
					if (generationRef.current !== gen) return;
					if (store.getState().sessionId !== id) return;
					const timelineByMessageId = buildTimelineViewMap(detail);
					const msgs = detail.messages.map((row) => messageRowToChatMessage(row, timelineByMessageId.get(row.id)));
					const streamState = detail.stream_state;
					store.update((s) => ({
						...s,
						messages: msgs,
						sessionId: id,
						lastSeq: streamState?.latest_terminal_seq ?? s.lastSeq,
						streamConnectionState: "idle",
					}));
					if (streamState?.writer_active || streamState?.has_incomplete_tail) {
						store.update((s) => ({
							...s,
							isStreaming: streamState.writer_active,
							streamConnectionState: "reconnecting",
						}));
						void processSSEStream(resumeSession(id, streamState.latest_terminal_seq), gen, "resume");
					}
				})
				.catch(() => {
					if (generationRef.current === gen) {
						store.update((s) => ({ ...s, streamConnectionState: "interrupted" }));
					}
				});
		},
		[store, processSSEStream],
	);

	return {
		messages: state.messages,
		activeToolCalls: state.activeToolCalls,
		thinkingBlocks: state.thinkingBlocks,
		runActivity: state.runActivity,
		isStreaming: state.isStreaming,
		streamConnectionState: state.streamConnectionState,
		sendMessage,
		abort,
		loadSession,
	};
}

function buildTimelineViewMap(detail: SessionDetail): Map<string, RunTimelineView> {
	const map = new Map<string, RunTimelineView>();
	for (const timeline of detail.run_timelines ?? []) {
		const key = timeline.assistant_message_id ?? timeline.user_message_id;
		map.set(key, runTimelineSummaryToView(timeline.summary));
	}
	return map;
}

function messageRowToChatMessage(row: SessionDetail["messages"][number], runTimeline?: RunTimelineView): ChatMessage {
	const parsed = parseMessageContentJson(row.content_json, row.role);

	return {
		id: row.id,
		role: row.role as "user" | "assistant",
		content: parsed.contentBlocks,
		attachments: parsed.attachments,
		createdAt: row.created_at,
		status: row.status as "committed" | "streaming" | "error",
		stopReason: row.stop_reason,
		costUsd: row.cost_usd,
		inputTokens: row.input_tokens,
		outputTokens: row.output_tokens,
		runTimeline,
	};
}
