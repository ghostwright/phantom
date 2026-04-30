// Tool call frame dispatchers for the chat store.
// Split from chat-store.ts to stay under 300 lines.

import { preferredToolMessageId } from "./chat-activity";
import type { ChatStore } from "./chat-store";
import type { ChatState, ToolCallState } from "./chat-types";

function str(data: Record<string, unknown>, key: string): string | undefined {
	const value = data[key];
	return typeof value === "string" ? value : undefined;
}

function bool(data: Record<string, unknown>, key: string): boolean | undefined {
	const value = data[key];
	return typeof value === "boolean" ? value : undefined;
}

function num(data: Record<string, unknown>, key: string): number | undefined {
	const value = data[key];
	return typeof value === "number" ? value : undefined;
}

function toolCallId(data: Record<string, unknown>): string | null {
	const id = str(data, "tool_call_id");
	return id && id.length > 0 ? id : null;
}

function fallbackToolName(data: Record<string, unknown>): string {
	return str(data, "tool_name") ?? "Tool";
}

function isMcpTool(toolName: string): boolean {
	return toolName.includes(":") || toolName.startsWith("mcp_");
}

function placeholderTool(s: ChatState, data: Record<string, unknown>, id: string): ToolCallState {
	const toolName = fallbackToolName(data);
	return {
		id,
		messageId: preferredToolMessageId(s, data),
		toolName,
		state: "pending",
		inputJson: "",
		isMcp: bool(data, "is_mcp") ?? isMcpTool(toolName),
		mcpServer: str(data, "mcp_server"),
	};
}

export function dispatchToolStart(store: ChatStore, data: Record<string, unknown>): void {
	store.update((s) => {
		const id = toolCallId(data);
		if (!id) return s;
		const toolName = fallbackToolName(data);
		const calls = new Map(s.activeToolCalls);
		calls.set(id, {
			id,
			messageId: preferredToolMessageId(s, data),
			toolName,
			state: "input_streaming",
			inputJson: "",
			isMcp: bool(data, "is_mcp") ?? isMcpTool(toolName),
			mcpServer: str(data, "mcp_server"),
		});
		return { ...s, activeToolCalls: calls };
	});
}

export function dispatchToolInputDelta(store: ChatStore, data: Record<string, unknown>): void {
	store.update((s) => {
		const id = toolCallId(data);
		if (!id) return s;
		const calls = new Map(s.activeToolCalls);
		const call = calls.get(id) ?? placeholderTool(s, data, id);
		calls.set(id, {
			...call,
			state: "input_streaming",
			inputJson: call.inputJson + (str(data, "json_delta") ?? ""),
		});
		return { ...s, activeToolCalls: calls };
	});
}

export function dispatchToolInputEnd(store: ChatStore, data: Record<string, unknown>): void {
	store.update((s) => {
		const id = toolCallId(data);
		if (!id) return s;
		const calls = new Map(s.activeToolCalls);
		const call = calls.get(id) ?? placeholderTool(s, data, id);
		calls.set(id, { ...call, state: "input_complete", input: data.input });
		return { ...s, activeToolCalls: calls };
	});
}

export function dispatchToolRunning(store: ChatStore, data: Record<string, unknown>): void {
	store.update((s) => {
		const id = toolCallId(data);
		if (!id) return s;
		const calls = new Map(s.activeToolCalls);
		const call = calls.get(id) ?? placeholderTool(s, data, id);
		calls.set(id, {
			...call,
			toolName: str(data, "tool_name") ?? call.toolName,
			state: "running",
			elapsedSeconds: num(data, "elapsed_seconds") ?? call.elapsedSeconds,
		});
		return { ...s, activeToolCalls: calls };
	});
}

export function dispatchToolResult(store: ChatStore, data: Record<string, unknown>): void {
	store.update((s) => {
		const id = toolCallId(data);
		if (!id) return s;
		const calls = new Map(s.activeToolCalls);
		const call = calls.get(id) ?? placeholderTool(s, data, id);
		calls.set(id, {
			...call,
			toolName: str(data, "tool_name") ?? call.toolName,
			state: str(data, "status") === "error" ? "error" : "result",
			output: str(data, "output"),
			error: str(data, "error"),
			durationMs: num(data, "duration_ms"),
			outputTruncated: bool(data, "output_truncated"),
		});
		return { ...s, activeToolCalls: calls };
	});
}

export function dispatchToolBlocked(store: ChatStore, data: Record<string, unknown>): void {
	store.update((s) => {
		const id = toolCallId(data);
		if (!id) return s;
		const calls = new Map(s.activeToolCalls);
		const call = calls.get(id) ?? placeholderTool(s, data, id);
		calls.set(id, {
			...call,
			toolName: str(data, "tool_name") ?? call.toolName,
			state: "blocked",
			blockReason: str(data, "reason") ?? "Blocked by hook",
		});
		return { ...s, activeToolCalls: calls };
	});
}

export function dispatchToolAborted(store: ChatStore, data: Record<string, unknown>): void {
	store.update((s) => {
		const id = toolCallId(data);
		if (!id) return s;
		const calls = new Map(s.activeToolCalls);
		const call = calls.get(id) ?? placeholderTool(s, data, id);
		calls.set(id, {
			...call,
			toolName: str(data, "tool_name") ?? call.toolName,
			state: "aborted",
		});
		return { ...s, activeToolCalls: calls };
	});
}
