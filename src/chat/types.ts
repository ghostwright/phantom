// Wire frame types for the 32-event chat streaming protocol.
// Discriminated union on `event` field. Matches ARCHITECTURE.md Section 2.

export type ChatToolState =
	| "pending"
	| "input_streaming"
	| "input_complete"
	| "running"
	| "result"
	| "error"
	| "aborted"
	| "blocked";

export type ChatSessionStatus = "active" | "archived" | "deleted";

export type StopReason =
	| "end_turn"
	| "max_tokens"
	| "stop_sequence"
	| "tool_use"
	| "pause_turn"
	| "compaction"
	| "refusal"
	| "model_context_window_exceeded"
	| "aborted";

export type SessionErrorSubtype =
	| "error_during_execution"
	| "error_max_turns"
	| "error_max_budget_usd"
	| "error_max_structured_output_retries"
	| "authentication_failed"
	| "billing_error"
	| "rate_limit"
	| "invalid_request"
	| "server_error"
	| "unknown"
	| "server_restart";

// Session lifecycle (12 events)

export type SessionCreatedFrame = {
	event: "session.created";
	session_id: string;
	sdk_session_id: string;
	created_at: string;
	title: string | null;
	seq: number;
};

export type SessionResumedFrame = {
	event: "session.resumed";
	session_id: string;
	resumed_from_seq: number;
	writer_active: boolean;
};

export type SessionCaughtUpFrame = {
	event: "session.caught_up";
	session_id: string;
	up_to_seq: number;
};

export type SessionDoneFrame = {
	event: "session.done";
	session_id: string;
	message_id: string;
	stop_reason: StopReason;
	usage: {
		input_tokens: number;
		output_tokens: number;
		cache_read_tokens?: number;
		cache_creation_tokens?: number;
	};
	cost_usd: number;
	duration_ms: number;
	num_turns: number;
};

export type SessionErrorFrame = {
	event: "session.error";
	session_id: string;
	message_id: string | null;
	subtype: SessionErrorSubtype;
	recoverable: boolean;
	errors: string[];
	cost_usd: number;
	duration_ms: number;
};

export type SessionAbortedFrame = {
	event: "session.aborted";
	session_id: string;
	message_id: string;
	aborted_at: string;
	cost_usd: number;
	duration_ms: number;
};

export type SessionRateLimitFrame = {
	event: "session.rate_limit";
	status: "allowed" | "allowed_warning" | "rejected";
	rate_limit_type?: string;
	resets_at?: string;
	utilization?: number;
};

export type SessionCompactBoundaryFrame = {
	event: "session.compact_boundary";
	trigger: "manual" | "auto";
	pre_tokens: number;
};

export type SessionStatusFrame = {
	event: "session.status";
	status: string | null;
	permission_mode: string;
};

export type SessionMcpStatusFrame = {
	event: "session.mcp_status";
	servers: Array<{ name: string; status: string }>;
};

export type SessionSuggestionFrame = {
	event: "session.suggestion";
	session_id: string;
	suggestion: string;
};

export type SessionTruncatedBacklogFrame = {
	event: "session.truncated_backlog";
	older_than_seq: number;
	reason: string;
};

// User messages (1 event)

export type UserMessageFrame = {
	event: "user.message";
	message_id: string;
	text: string;
	attachments: Array<{ id: string; filename: string; mime_type: string }>;
	sent_at: string;
	source_tab_id: string;
};

// Assistant messages (4+2 events)

export type AssistantStartFrame = {
	event: "message.assistant_start";
	message_id: string;
	parent_tool_use_id: string | null;
};

export type AssistantEndFrame = {
	event: "message.assistant_end";
	message_id: string;
	interrupted: boolean;
	usage_delta?: { input_tokens: number; output_tokens: number };
};

export type TextStartFrame = {
	event: "message.text_start";
	message_id: string;
	text_block_id: string;
	index: number;
};

export type TextDeltaFrame = {
	event: "message.text_delta";
	text_block_id: string;
	delta: string;
};

export type TextEndFrame = {
	event: "message.text_end";
	text_block_id: string;
};

export type TextReconcileFrame = {
	event: "message.text_reconcile";
	text_block_id: string;
	full_text: string;
};

// Thinking blocks (3 events)

export type ThinkingStartFrame = {
	event: "message.thinking_start";
	message_id: string;
	thinking_block_id: string;
	index: number;
	redacted: boolean;
};

export type ThinkingDeltaFrame = {
	event: "message.thinking_delta";
	thinking_block_id: string;
	delta: string;
};

export type ThinkingEndFrame = {
	event: "message.thinking_end";
	thinking_block_id: string;
	duration_ms?: number;
};

// Tool call, subagent, and union types are in types-tool.ts to stay under 300 lines
export type {
	ChatWireFrame,
	SubagentEndFrame,
	SubagentProgressFrame,
	SubagentStartFrame,
	ToolCallAbortedFrame,
	ToolCallBlockedFrame,
	ToolCallInputDeltaFrame,
	ToolCallInputEndFrame,
	ToolCallResultFrame,
	ToolCallRunningFrame,
	ToolCallStartFrame,
} from "./types-tool.ts";
