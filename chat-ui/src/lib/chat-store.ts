// Chat state store and SSE frame dispatcher.
// Tool dispatchers live in chat-dispatch-tools.ts.

import type { ChatState } from "./chat-types";
import {
  dispatchToolAborted,
  dispatchToolBlocked,
  dispatchToolInputDelta,
  dispatchToolInputEnd,
  dispatchToolResult,
  dispatchToolRunning,
  dispatchToolStart,
} from "./chat-dispatch-tools";

type Listener = () => void;

function createInitialState(): ChatState {
  return {
    messages: [],
    activeToolCalls: new Map(),
    thinkingBlocks: new Map(),
    textBlocks: new Map(),
    isStreaming: false,
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

function updateTextBlockInContent(
  s: ChatState,
  blockId: string,
  updater: (text: string) => string,
): ChatState {
  const msgs = [...s.messages];
  const last = msgs[msgs.length - 1];
  if (last && last.role === "assistant") {
    const content = last.content.map((b) =>
      b.type === "text" && b.blockId === blockId
        ? { ...b, text: updater(b.text ?? "") }
        : b,
    );
    msgs[msgs.length - 1] = { ...last, content };
  }
  return { ...s, messages: msgs };
}

export function dispatchFrame(
  store: ChatStore,
  event: string,
  dataStr: string,
): void {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(dataStr) as Record<string, unknown>;
  } catch {
    return;
  }

  switch (event) {
    case "user.message":
      store.update((s) => ({
        ...s,
        messages: [
          ...s.messages,
          {
            id: data.message_id as string,
            role: "user" as const,
            content: [{ type: "text", text: data.text as string }],
            createdAt: data.sent_at as string,
            status: "committed" as const,
          },
        ],
      }));
      break;

    case "message.assistant_start":
      store.update((s) => ({
        ...s,
        messages: [
          ...s.messages,
          {
            id: data.message_id as string,
            role: "assistant" as const,
            content: [],
            createdAt: new Date().toISOString(),
            status: "streaming" as const,
          },
        ],
      }));
      break;

    case "message.text_start":
      store.update((s) => {
        const msgs = [...s.messages];
        const last = msgs[msgs.length - 1];
        if (last && last.role === "assistant") {
          const blockId = data.text_block_id as string;
          msgs[msgs.length - 1] = {
            ...last,
            content: [...last.content, { type: "text", blockId, text: "" }],
          };
        }
        return { ...s, messages: msgs };
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
      break;
    case "message.tool_call_result":
      dispatchToolResult(store, data);
      break;
    case "message.tool_call_blocked":
      dispatchToolBlocked(store, data);
      break;
    case "message.tool_call_aborted":
      dispatchToolAborted(store, data);
      break;

    case "message.assistant_end":
      store.update((s) => {
        const msgs = [...s.messages];
        const last = msgs[msgs.length - 1];
        if (last && last.role === "assistant") {
          msgs[msgs.length - 1] = { ...last, status: "committed" };
        }
        return { ...s, messages: msgs };
      });
      break;

    case "session.done":
    case "session.error":
    case "session.aborted":
      store.update((s) => {
        const msgs = [...s.messages];
        const last = msgs[msgs.length - 1];
        if (last && last.role === "assistant" && last.status === "streaming") {
          const newStatus = event === "session.error" ? "error" : "committed";
          msgs[msgs.length - 1] = { ...last, status: newStatus };
        }
        return {
          ...s,
          messages: msgs,
          isStreaming: false,
          activeToolCalls: new Map(),
          thinkingBlocks: new Map(),
        };
      });
      break;

    case "session.created":
    case "session.resumed":
    case "session.caught_up":
    case "session.rate_limit":
    case "session.compact_boundary":
    case "session.status":
    case "session.mcp_status":
    case "session.suggestion":
    case "session.truncated_backlog":
    case "message.subagent_start":
    case "message.subagent_progress":
    case "message.subagent_end":
      break;

    default:
      break;
  }
}
