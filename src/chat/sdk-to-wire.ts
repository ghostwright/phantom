// Translates SDKMessage objects from the Agent SDK stream into ChatWireFrame
// arrays for the SSE wire protocol. Entry point that dispatches to per-type
// handlers. The assistant and stream_event handlers live in
// sdk-to-wire-handlers.ts to keep both files under 300 lines.

import { type TranslationContext, handleAssistant, handleStreamEvent } from "./sdk-to-wire-handlers.ts";
import type { ChatWireFrame, StopReason, ToolCallResultFrame, ToolCallRunningFrame } from "./types.ts";

export type { TranslationContext } from "./sdk-to-wire-handlers.ts";

export function createTranslationContext(sessionId: string, messageId: string): TranslationContext {
	return {
		sessionId,
		messageId,
		turnIndex: 0,
		seenBlockLengths: new Map(),
		startedToolIds: new Set(),
		completedToolInputIds: new Set(),
		assistantStartEmitted: false,
		assistantEndEmitted: false,
		awaitingStreamFinalAssistant: false,
		blockTypes: new Map(),
		blockToolIds: new Map(),
		blockToolInputJson: new Map(),
	};
}

export function translateSdkMessage(msg: Record<string, unknown>, ctx: TranslationContext): ChatWireFrame[] {
	const type = msg.type as string;

	switch (type) {
		case "system":
			return handleSystem(msg, ctx);
		case "assistant":
			return handleAssistant(msg, ctx);
		case "stream_event":
			return handleStreamEvent(msg, ctx);
		case "result":
			return handleResult(msg, ctx);
		case "user":
			return handleUser(msg, ctx);
		case "tool_progress":
			return handleToolProgress(msg, ctx);
		case "rate_limit_event":
			return handleRateLimit(msg);
		case "prompt_suggestion":
			return handlePromptSuggestion(msg, ctx);
		default:
			return [];
	}
}

function handleSystem(msg: Record<string, unknown>, ctx: TranslationContext): ChatWireFrame[] {
	const subtype = msg.subtype as string;
	const frames: ChatWireFrame[] = [];

	switch (subtype) {
		case "init": {
			const mcpServers = (msg.mcp_servers ?? []) as Array<{ name: string; status: string }>;
			frames.push({
				event: "session.created",
				session_id: ctx.sessionId,
				sdk_session_id: (msg.session_id as string) ?? "",
				created_at: new Date().toISOString(),
				title: null,
				seq: 0,
			});
			if (mcpServers.length > 0) {
				frames.push({ event: "session.mcp_status", servers: mcpServers });
			}
			break;
		}
		case "status":
			frames.push({
				event: "session.status",
				status: (msg.status as string | null) ?? null,
				permission_mode: (msg.permissionMode as string) ?? "bypassPermissions",
			});
			break;
		case "compact_boundary": {
			const meta = msg.compact_metadata as { trigger: "manual" | "auto"; pre_tokens: number };
			frames.push({ event: "session.compact_boundary", trigger: meta.trigger, pre_tokens: meta.pre_tokens });
			break;
		}
		case "task_started":
			frames.push({
				event: "message.subagent_start",
				tool_call_id: (msg.tool_use_id as string) ?? "",
				task_id: msg.task_id as string,
				description: (msg.description as string) ?? "",
				task_type: msg.task_type as string | undefined,
				workflow_name: msg.workflow_name as string | undefined,
			});
			break;
		case "task_progress": {
			const u = msg.usage as { total_tokens: number; tool_uses: number; duration_ms: number } | undefined;
			frames.push({
				event: "message.subagent_progress",
				task_id: msg.task_id as string,
				summary: msg.summary as string | undefined,
				last_tool_name: msg.last_tool_name as string | undefined,
				duration_ms: u?.duration_ms ?? 0,
				total_tokens: u?.total_tokens ?? 0,
				tool_uses: u?.tool_uses ?? 0,
			});
			break;
		}
		case "task_notification": {
			const u = msg.usage as { total_tokens: number; tool_uses: number; duration_ms: number } | undefined;
			frames.push({
				event: "message.subagent_end",
				task_id: msg.task_id as string,
				status: (msg.status as "completed" | "failed" | "stopped") ?? "completed",
				output_file: (msg.output_file as string) ?? "",
				summary: (msg.summary as string) ?? "",
				total_tokens: u?.total_tokens,
				tool_uses: u?.tool_uses,
				duration_ms: u?.duration_ms,
			});
			break;
		}
		case "hook_response": {
			if ((msg.outcome as string) === "cancelled") {
				frames.push({
					event: "message.tool_call_blocked",
					tool_call_id: (msg.hook_id as string) ?? "",
					hook_name: (msg.hook_name as string) ?? "",
					reason: (msg.output as string) ?? "Blocked by hook",
				});
			}
			break;
		}
	}

	return frames;
}

const TOOL_RESULT_OUTPUT_LIMIT = 12_000;
const SAFE_TOOL_ERROR_MESSAGE = "Tool returned an error. Details are hidden for safety.";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeToolResultText(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const parts = content
			.map((item) => {
				if (typeof item === "string") return item;
				if (isRecord(item) && typeof item.text === "string") return item.text;
				return "";
			})
			.filter((part) => part.length > 0);
		return parts.length > 0 ? parts.join("\n") : undefined;
	}
	if (isRecord(content) && typeof content.text === "string") return content.text;
	return undefined;
}

function truncateToolResultOutput(
	text: string,
): Pick<ToolCallResultFrame, "output" | "output_truncated" | "output_full_size"> {
	if (text.length <= TOOL_RESULT_OUTPUT_LIMIT) return { output: text };
	return {
		output: text.slice(0, TOOL_RESULT_OUTPUT_LIMIT),
		output_truncated: true,
		output_full_size: text.length,
	};
}

function handleUser(msg: Record<string, unknown>, ctx: TranslationContext): ChatWireFrame[] {
	const message = msg.message;
	if (!isRecord(message)) return [];
	const content = message.content;
	const blocks = Array.isArray(content) ? content : [content];
	const frames: ChatWireFrame[] = [];

	for (const block of blocks) {
		if (!isRecord(block) || block.type !== "tool_result") continue;
		const toolCallId = block.tool_use_id;
		if (typeof toolCallId !== "string" || toolCallId.length === 0) continue;

		const resultText = safeToolResultText(block.content);
		const output = resultText ? truncateToolResultOutput(resultText) : {};
		const isError = block.is_error === true || block.status === "error";
		const frame: ToolCallResultFrame = {
			event: "message.tool_call_result",
			message_id: typeof msg.message_id === "string" ? msg.message_id : ctx.messageId,
			tool_call_id: toolCallId,
			status: isError ? "error" : "success",
			...output,
		};
		if (isError) {
			frame.error = SAFE_TOOL_ERROR_MESSAGE;
			frame.output = undefined;
			frame.output_truncated = undefined;
			frame.output_full_size = undefined;
		}
		frames.push(frame);
	}

	return frames;
}

function handleResult(msg: Record<string, unknown>, ctx: TranslationContext): ChatWireFrame[] {
	const frames: ChatWireFrame[] = [];
	const subtype = msg.subtype as string;
	const usage = msg.usage as Record<string, number> | undefined;
	const costUsd = (msg.total_cost_usd as number) ?? 0;
	const durationMs = (msg.duration_ms as number) ?? 0;
	const numTurns = (msg.num_turns as number) ?? 1;

	if (ctx.assistantStartEmitted && !ctx.assistantEndEmitted) {
		frames.push({
			event: "message.assistant_end",
			message_id: ctx.messageId,
			interrupted: false,
			usage_delta: usage
				? { input_tokens: usage.input_tokens ?? 0, output_tokens: usage.output_tokens ?? 0 }
				: undefined,
		});
	}
	ctx.assistantStartEmitted = false;
	ctx.assistantEndEmitted = false;
	ctx.awaitingStreamFinalAssistant = false;

	if (subtype === "success") {
		const stopReason = ((msg.stop_reason as string) ?? "end_turn") as StopReason;
		frames.push({
			event: "session.done",
			session_id: ctx.sessionId,
			message_id: ctx.messageId,
			stop_reason: stopReason,
			usage: { input_tokens: usage?.input_tokens ?? 0, output_tokens: usage?.output_tokens ?? 0 },
			cost_usd: costUsd,
			duration_ms: durationMs,
			num_turns: numTurns,
		});
	} else {
		frames.push({
			event: "session.error",
			session_id: ctx.sessionId,
			message_id: ctx.messageId,
			subtype: (subtype ?? "unknown") as "error_during_execution",
			recoverable: false,
			errors: (msg.errors as string[]) ?? [],
			cost_usd: costUsd,
			duration_ms: durationMs,
		});
	}

	return frames;
}

function handleToolProgress(msg: Record<string, unknown>, ctx: TranslationContext): ChatWireFrame[] {
	const elapsedSeconds =
		typeof msg.elapsed_time_seconds === "number"
			? msg.elapsed_time_seconds
			: typeof msg.elapsed_ms === "number"
				? msg.elapsed_ms / 1000
				: 0;
	const phase = typeof msg.phase === "string" ? msg.phase : undefined;
	const toolCallId = (msg.tool_use_id as string) ?? "";
	const toolName = typeof msg.tool_name === "string" ? msg.tool_name : undefined;
	const messageId =
		typeof msg.message_id === "string" ? msg.message_id : ctx.assistantStartEmitted ? ctx.messageId : undefined;
	if (phase === "completed" || phase === "failed") {
		const outputPreview = typeof msg.output_preview === "string" ? msg.output_preview : undefined;
		const output = outputPreview ? truncateToolResultOutput(outputPreview) : {};
		const outputTruncated = typeof msg.output_truncated === "boolean" ? msg.output_truncated : output.output_truncated;
		const frame: ToolCallResultFrame = {
			event: "message.tool_call_result",
			...(messageId ? { message_id: messageId } : {}),
			tool_call_id: toolCallId,
			...(toolName ? { tool_name: toolName } : {}),
			status: phase === "failed" ? "error" : "success",
			duration_ms: typeof msg.duration_ms === "number" ? msg.duration_ms : undefined,
			output_preview: outputPreview,
			...output,
			output_truncated: outputTruncated,
			full_ref: typeof msg.full_ref === "string" ? msg.full_ref : undefined,
		};
		if (phase === "failed") {
			frame.error =
				typeof msg.error === "string" ? msg.error : "Tool returned an error. Details are hidden for safety.";
		}
		return [frame];
	}
	const frame: ToolCallRunningFrame = {
		event: "message.tool_call_running",
		...(messageId ? { message_id: messageId } : {}),
		tool_call_id: toolCallId,
		...(toolName ? { tool_name: toolName } : {}),
		elapsed_seconds: elapsedSeconds,
		phase: phase === "started" || phase === "partial_output" || phase === "running" ? phase : undefined,
		input_preview: typeof msg.input_preview === "string" ? msg.input_preview : undefined,
		output_preview: typeof msg.output_preview === "string" ? msg.output_preview : undefined,
		output_truncated: typeof msg.output_truncated === "boolean" ? msg.output_truncated : undefined,
		full_ref: typeof msg.full_ref === "string" ? msg.full_ref : undefined,
	};
	return [frame];
}

function handleRateLimit(msg: Record<string, unknown>): ChatWireFrame[] {
	const info = (msg.rate_limit_info ?? msg.rate_limit) as Record<string, unknown> | undefined;
	if (!info) return [];
	const resetsAt = info.resetsAt;
	return [
		{
			event: "session.rate_limit",
			status: (info.status as "allowed" | "allowed_warning" | "rejected") ?? "allowed",
			rate_limit_type: info.rateLimitType as string | undefined,
			resets_at: resetsAt ? new Date(resetsAt as string | number).toISOString() : undefined,
			utilization: info.utilization as number | undefined,
		},
	];
}

function handlePromptSuggestion(msg: Record<string, unknown>, ctx: TranslationContext): ChatWireFrame[] {
	return [
		{
			event: "session.suggestion",
			session_id: ctx.sessionId,
			suggestion: ((msg.suggestion ?? msg.prompt) as string) ?? "",
		},
	];
}
