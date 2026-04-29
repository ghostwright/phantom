// Tool call, subagent, and union types for the chat wire protocol.
// Split from types.ts to keep both files under 300 lines.

import type {
	AssistantEndFrame,
	AssistantStartFrame,
	SessionAbortedFrame,
	SessionCaughtUpFrame,
	SessionCompactBoundaryFrame,
	SessionCreatedFrame,
	SessionDoneFrame,
	SessionErrorFrame,
	SessionMcpStatusFrame,
	SessionRateLimitFrame,
	SessionResumedFrame,
	SessionStatusFrame,
	SessionSuggestionFrame,
	SessionTruncatedBacklogFrame,
	TextDeltaFrame,
	TextEndFrame,
	TextReconcileFrame,
	TextStartFrame,
	ThinkingDeltaFrame,
	ThinkingEndFrame,
	ThinkingStartFrame,
	UserMessageFrame,
} from "./types.ts";

export type ToolCallStartFrame = {
	event: "message.tool_call_start";
	message_id: string;
	tool_call_id: string;
	tool_name: string;
	parent_tool_use_id: string | null;
	is_mcp: boolean;
	mcp_server?: string;
};

export type ToolCallInputDeltaFrame = {
	event: "message.tool_call_input_delta";
	tool_call_id: string;
	json_delta: string;
};

export type ToolCallInputEndFrame = {
	event: "message.tool_call_input_end";
	tool_call_id: string;
	input: unknown;
};

export type ToolCallRunningFrame = {
	event: "message.tool_call_running";
	tool_call_id: string;
	elapsed_seconds: number;
};

export type ToolCallResultFrame = {
	event: "message.tool_call_result";
	tool_call_id: string;
	status: "success" | "error";
	duration_ms?: number;
	output?: string;
	output_truncated?: boolean;
	output_full_size?: number;
	full_ref?: string;
	error?: string;
};

export type ToolCallBlockedFrame = {
	event: "message.tool_call_blocked";
	tool_call_id: string;
	hook_name: string;
	reason: string;
};

export type ToolCallAbortedFrame = {
	event: "message.tool_call_aborted";
	tool_call_id: string;
};

export type SubagentStartFrame = {
	event: "message.subagent_start";
	tool_call_id: string;
	task_id: string;
	description: string;
	task_type?: string;
	workflow_name?: string;
};

export type SubagentProgressFrame = {
	event: "message.subagent_progress";
	task_id: string;
	summary?: string;
	last_tool_name?: string;
	duration_ms: number;
	total_tokens: number;
	tool_uses: number;
};

export type SubagentEndFrame = {
	event: "message.subagent_end";
	task_id: string;
	status: "completed" | "failed" | "stopped";
	output_file: string;
	summary: string;
	total_tokens?: number;
	tool_uses?: number;
	duration_ms?: number;
};

export type ChatWireFrame =
	| SessionCreatedFrame
	| SessionResumedFrame
	| SessionCaughtUpFrame
	| SessionDoneFrame
	| SessionErrorFrame
	| SessionAbortedFrame
	| SessionRateLimitFrame
	| SessionCompactBoundaryFrame
	| SessionStatusFrame
	| SessionMcpStatusFrame
	| SessionSuggestionFrame
	| SessionTruncatedBacklogFrame
	| UserMessageFrame
	| AssistantStartFrame
	| AssistantEndFrame
	| TextStartFrame
	| TextDeltaFrame
	| TextEndFrame
	| TextReconcileFrame
	| ThinkingStartFrame
	| ThinkingDeltaFrame
	| ThinkingEndFrame
	| ToolCallStartFrame
	| ToolCallInputDeltaFrame
	| ToolCallInputEndFrame
	| ToolCallRunningFrame
	| ToolCallResultFrame
	| ToolCallBlockedFrame
	| ToolCallAbortedFrame
	| SubagentStartFrame
	| SubagentProgressFrame
	| SubagentEndFrame;
