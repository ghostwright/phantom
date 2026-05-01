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

function phase(data: Record<string, unknown>): ToolCallState["phase"] | undefined {
	const value = str(data, "phase");
	if (
		value === "started" ||
		value === "running" ||
		value === "partial_output" ||
		value === "completed" ||
		value === "failed"
	) {
		return value;
	}
	return undefined;
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

function isInputAssemblyState(state: ToolCallState["state"]): boolean {
	return state === "pending" || state === "input_streaming" || state === "input_complete";
}

function isTerminalToolState(state: ToolCallState["state"]): boolean {
	return state === "result" || state === "error" || state === "blocked" || state === "aborted";
}

function isCompleteJsonLike(value: string): boolean {
	const trimmed = value.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
	try {
		JSON.parse(trimmed);
		return true;
	} catch {
		return false;
	}
}

function shouldAppendInputDelta(call: ToolCallState): boolean {
	if (isInputAssemblyState(call.state)) return true;
	const trimmed = call.inputJson.trim();
	if (!trimmed) return true;
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
	return !isCompleteJsonLike(trimmed);
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
		const existing = calls.get(id);
		calls.set(id, {
			id,
			messageId: preferredToolMessageId(s, data),
			toolName,
			state: existing && !isInputAssemblyState(existing.state) ? existing.state : "input_streaming",
			inputJson: existing?.inputJson ?? "",
			input: existing?.input,
			output: existing?.output,
			error: existing?.error,
			durationMs: existing?.durationMs,
			phase: existing?.phase,
			outputTruncated: existing?.outputTruncated,
			fullRef: existing?.fullRef,
			elapsedSeconds: existing?.elapsedSeconds,
			blockReason: existing?.blockReason,
			isMcp: bool(data, "is_mcp") ?? existing?.isMcp ?? isMcpTool(toolName),
			mcpServer: str(data, "mcp_server") ?? existing?.mcpServer,
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
		const jsonDelta = str(data, "json_delta") ?? "";
		calls.set(id, {
			...call,
			state: isInputAssemblyState(call.state) ? "input_streaming" : call.state,
			inputJson: shouldAppendInputDelta(call) ? call.inputJson + jsonDelta : call.inputJson,
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
		calls.set(id, { ...call, state: isInputAssemblyState(call.state) ? "input_complete" : call.state, input: data.input });
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
			state: isTerminalToolState(call.state) ? call.state : "running",
			phase: isTerminalToolState(call.state) ? call.phase : (phase(data) ?? call.phase ?? "running"),
			inputJson: str(data, "input_preview") ?? call.inputJson,
			output: str(data, "output_preview") ?? call.output,
			outputTruncated: bool(data, "output_truncated") ?? call.outputTruncated,
			fullRef: str(data, "full_ref") ?? call.fullRef,
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
			phase: str(data, "status") === "error" ? "failed" : "completed",
			output: str(data, "output") ?? str(data, "output_preview"),
			error: str(data, "error"),
			durationMs: num(data, "duration_ms"),
			outputTruncated: bool(data, "output_truncated"),
			fullRef: str(data, "full_ref") ?? call.fullRef,
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
