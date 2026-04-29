// Translates SDKMessage objects from the Agent SDK stream into ChatWireFrame
// arrays for the SSE wire protocol. Entry point that dispatches to per-type
// handlers. The assistant and stream_event handlers live in
// sdk-to-wire-handlers.ts to keep both files under 300 lines.

import { type TranslationContext, handleAssistant, handleStreamEvent } from "./sdk-to-wire-handlers.ts";
import type { ChatWireFrame, StopReason } from "./types.ts";

export type { TranslationContext } from "./sdk-to-wire-handlers.ts";

export function createTranslationContext(sessionId: string, messageId: string): TranslationContext {
	return {
		sessionId,
		messageId,
		turnIndex: 0,
		seenBlockLengths: new Map(),
		startedToolIds: new Set(),
		assistantStartEmitted: false,
		blockTypes: new Map(),
		blockToolIds: new Map(),
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
			return [];
		case "tool_progress":
			return handleToolProgress(msg);
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

function handleResult(msg: Record<string, unknown>, ctx: TranslationContext): ChatWireFrame[] {
	const frames: ChatWireFrame[] = [];
	const subtype = msg.subtype as string;
	const usage = msg.usage as Record<string, number> | undefined;
	const costUsd = (msg.total_cost_usd as number) ?? 0;
	const durationMs = (msg.duration_ms as number) ?? 0;
	const numTurns = (msg.num_turns as number) ?? 1;

	if (ctx.assistantStartEmitted) {
		frames.push({
			event: "message.assistant_end",
			message_id: ctx.messageId,
			interrupted: false,
			usage_delta: usage
				? { input_tokens: usage.input_tokens ?? 0, output_tokens: usage.output_tokens ?? 0 }
				: undefined,
		});
		ctx.assistantStartEmitted = false;
	}

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

function handleToolProgress(msg: Record<string, unknown>): ChatWireFrame[] {
	return [
		{
			event: "message.tool_call_running",
			tool_call_id: (msg.tool_use_id as string) ?? "",
			elapsed_seconds: (msg.elapsed_time_seconds as number) ?? 0,
		},
	];
}

function handleRateLimit(msg: Record<string, unknown>): ChatWireFrame[] {
	const info = msg.rate_limit_info as Record<string, unknown> | undefined;
	if (!info) return [];
	return [
		{
			event: "session.rate_limit",
			status: (info.status as "allowed" | "allowed_warning" | "rejected") ?? "allowed",
			rate_limit_type: info.rateLimitType as string | undefined,
			resets_at: info.resetsAt ? new Date(info.resetsAt as number).toISOString() : undefined,
			utilization: info.utilization as number | undefined,
		},
	];
}

function handlePromptSuggestion(msg: Record<string, unknown>, ctx: TranslationContext): ChatWireFrame[] {
	return [
		{
			event: "session.suggestion",
			session_id: ctx.sessionId,
			suggestion: (msg.suggestion as string) ?? "",
		},
	];
}
