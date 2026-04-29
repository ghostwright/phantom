// Tool call frame dispatchers for the chat store.
// Split from chat-store.ts to stay under 300 lines.

import type { ChatStore } from "./chat-store";

export function dispatchToolStart(
  store: ChatStore,
  data: Record<string, unknown>,
): void {
  store.update((s) => {
    const calls = new Map(s.activeToolCalls);
    calls.set(data.tool_call_id as string, {
      id: data.tool_call_id as string,
      messageId: data.message_id as string,
      toolName: data.tool_name as string,
      state: "input_streaming",
      inputJson: "",
      isMcp: data.is_mcp as boolean,
      mcpServer: data.mcp_server as string | undefined,
    });
    return { ...s, activeToolCalls: calls };
  });
}

export function dispatchToolInputDelta(
  store: ChatStore,
  data: Record<string, unknown>,
): void {
  store.update((s) => {
    const calls = new Map(s.activeToolCalls);
    const id = data.tool_call_id as string;
    const call = calls.get(id);
    if (call) {
      calls.set(id, {
        ...call,
        inputJson: call.inputJson + (data.json_delta as string),
      });
    }
    return { ...s, activeToolCalls: calls };
  });
}

export function dispatchToolInputEnd(
  store: ChatStore,
  data: Record<string, unknown>,
): void {
  store.update((s) => {
    const calls = new Map(s.activeToolCalls);
    const id = data.tool_call_id as string;
    const call = calls.get(id);
    if (call) {
      calls.set(id, { ...call, state: "input_complete", input: data.input });
    }
    return { ...s, activeToolCalls: calls };
  });
}

export function dispatchToolRunning(
  store: ChatStore,
  data: Record<string, unknown>,
): void {
  store.update((s) => {
    const calls = new Map(s.activeToolCalls);
    const id = data.tool_call_id as string;
    const call = calls.get(id);
    if (call) {
      calls.set(id, {
        ...call,
        state: "running",
        elapsedSeconds: data.elapsed_seconds as number,
      });
    }
    return { ...s, activeToolCalls: calls };
  });
}

export function dispatchToolResult(
  store: ChatStore,
  data: Record<string, unknown>,
): void {
  store.update((s) => {
    const calls = new Map(s.activeToolCalls);
    const id = data.tool_call_id as string;
    const call = calls.get(id);
    if (call) {
      calls.set(id, {
        ...call,
        state: (data.status as string) === "error" ? "error" : "result",
        output: data.output as string | undefined,
        error: data.error as string | undefined,
        durationMs: data.duration_ms as number | undefined,
        outputTruncated: data.output_truncated as boolean | undefined,
      });
    }
    return { ...s, activeToolCalls: calls };
  });
}

export function dispatchToolBlocked(
  store: ChatStore,
  data: Record<string, unknown>,
): void {
  store.update((s) => {
    const calls = new Map(s.activeToolCalls);
    const id = data.tool_call_id as string;
    const call = calls.get(id);
    if (call) {
      calls.set(id, {
        ...call,
        state: "blocked",
        blockReason: data.reason as string,
      });
    }
    return { ...s, activeToolCalls: calls };
  });
}

export function dispatchToolAborted(
  store: ChatStore,
  data: Record<string, unknown>,
): void {
  store.update((s) => {
    const calls = new Map(s.activeToolCalls);
    const id = data.tool_call_id as string;
    const call = calls.get(id);
    if (call) {
      calls.set(id, { ...call, state: "aborted" });
    }
    return { ...s, activeToolCalls: calls };
  });
}
