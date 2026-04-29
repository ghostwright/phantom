import { useCallback, useRef, useSyncExternalStore } from "react";
import { abortSession, getSession, type SessionDetail } from "@/lib/client";
import type { ChatMessage, ThinkingBlockState, ToolCallState } from "@/lib/chat-types";
import { createChatStore, dispatchFrame, type ChatStore } from "@/lib/chat-store";

export function useChat(sessionId: string | null): {
  messages: ChatMessage[];
  activeToolCalls: Map<string, ToolCallState>;
  thinkingBlocks: Map<string, ThinkingBlockState>;
  isStreaming: boolean;
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
    async (body: ReadableStream<Uint8Array>, gen: number) => {
      const decoder = new TextDecoder();
      const reader = body.getReader();
      readerRef.current = reader;
      let buffer = "";
      let currentEvent = "";
      let currentData = "";

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
            const seq = parseInt(line.slice(4), 10);
            if (!isNaN(seq)) {
              store.update((s) => ({
                ...s,
                lastSeq: Math.max(s.lastSeq, seq),
              }));
            }
          } else if (line === "" && currentEvent && currentData) {
            if (generationRef.current !== gen) return;
            dispatchFrame(store, currentEvent, currentData);
            currentEvent = "";
            currentData = "";
          }
        }
      }

      if (generationRef.current === gen) {
        store.update((s) => ({ ...s, isStreaming: false }));
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

      store.update((s) => ({ ...s, isStreaming: true }));

      const payload: Record<string, unknown> = {
        session_id: sessionId,
        text,
        tab_id: "web-" + Date.now(),
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
            store.update((s) => ({ ...s, isStreaming: false }));
            return;
          }
          return processSSEStream(res.body, gen);
        })
        .catch(() => {
          if (generationRef.current === gen) {
            store.update((s) => ({ ...s, isStreaming: false }));
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
    store.update((s) => ({ ...s, isStreaming: false }));
  }, [sessionId, store]);

  const loadSession = useCallback(
    (id: string) => {
      store.reset(id);
      getSession(id)
        .then((detail: SessionDetail) => {
          if (store.getState().sessionId !== id) return;
          const msgs = detail.messages.map(messageRowToChatMessage);
          store.update((s) => ({ ...s, messages: msgs, sessionId: id }));
        })
        .catch(() => {});
    },
    [store],
  );

  return {
    messages: state.messages,
    activeToolCalls: state.activeToolCalls,
    thinkingBlocks: state.thinkingBlocks,
    isStreaming: state.isStreaming,
    sendMessage,
    abort,
    loadSession,
  };
}

function messageRowToChatMessage(
  row: SessionDetail["messages"][number],
): ChatMessage {
  let contentBlocks: Array<{
    type: string;
    text?: string;
    [key: string]: unknown;
  }> = [];
  try {
    const parsed = JSON.parse(row.content_json);
    if (typeof parsed === "string") {
      contentBlocks = [{ type: "text", text: parsed }];
    } else if (Array.isArray(parsed)) {
      contentBlocks = parsed;
    } else {
      contentBlocks = [parsed];
    }
  } catch {
    contentBlocks = [{ type: "text", text: row.content_json }];
  }

  return {
    id: row.id,
    role: row.role as "user" | "assistant",
    content: contentBlocks,
    createdAt: row.created_at,
    status: row.status as "committed" | "streaming" | "error",
    stopReason: row.stop_reason,
    costUsd: row.cost_usd,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
  };
}
