// Client-side types for chat state management.
// Compatible with but not imported from the server-side wire format types.

export type ChatToolStateValue =
	| "pending"
	| "input_streaming"
	| "input_complete"
	| "running"
	| "result"
	| "error"
	| "aborted"
	| "blocked";

export type ContentBlock = {
	type: string;
	text?: string;
	blockId?: string;
	[key: string]: unknown;
};

export type ChatMessage = {
	id: string;
	role: "user" | "assistant";
	content: ContentBlock[];
	createdAt: string;
	status: "committed" | "streaming" | "error";
	stopReason?: string | null;
	costUsd?: number | null;
	inputTokens?: number | null;
	outputTokens?: number | null;
	runTimeline?: RunTimelineView;
};

export type ToolCallState = {
	id: string;
	messageId: string;
	toolName: string;
	state: ChatToolStateValue;
	inputJson: string;
	input?: unknown;
	output?: string;
	error?: string;
	durationMs?: number;
	elapsedSeconds?: number;
	outputTruncated?: boolean;
	isMcp: boolean;
	mcpServer?: string;
	blockReason?: string;
};

export type ThinkingBlockState = {
	messageId: string;
	text: string;
	redacted: boolean;
	isStreaming: boolean;
	durationMs?: number;
};

export type RunActivityStatus =
	| "starting"
	| "working"
	| "compacting"
	| "rate_limited"
	| "completed"
	| "error"
	| "aborted";

export type StreamConnectionState =
	| "idle"
	| "starting"
	| "reconnecting"
	| "replaying"
	| "attached"
	| "detached"
	| "interrupted";

export type CompactActivity = {
	trigger: "manual" | "auto";
	preTokens: number;
};

export type RateLimitActivity = {
	status: "allowed" | "allowed_warning" | "rejected";
	rateLimitType?: string;
	resetsAt?: string;
	utilization?: number;
};

export type SubagentActivity = {
	taskId: string;
	toolCallId?: string;
	description: string;
	status: "running" | "completed" | "failed" | "stopped";
	summary?: string;
	lastToolName?: string;
	durationMs?: number;
	totalTokens?: number;
	toolUses?: number;
	outputFile?: string;
	updatedAt: string;
};

export type RunActivityState = {
	status: RunActivityStatus;
	currentLabel: string;
	startedAt: string;
	updatedAt: string;
	isActive: boolean;
	compact?: CompactActivity;
	rateLimit?: RateLimitActivity;
	mcpServers?: Array<{ name: string; status: string }>;
	truncatedBacklog?: { olderThanSeq: number; reason: string };
	subagents: Map<string, SubagentActivity>;
};

export type TextBlockState = {
	messageId: string;
	text: string;
	isReplayShadow?: boolean;
};

export type DurableRunTimelineSummary = {
	schemaVersion: 1;
	status: "working" | "completed" | "error" | "aborted" | "recovered";
	startSeq: number;
	endSeq: number | null;
	startedAt: string;
	completedAt?: string;
	currentLabel?: string;
	stopReason?: string;
	durationMs?: number;
	costUsd?: number;
	inputTokens?: number;
	outputTokens?: number;
	compact?: CompactActivity;
	rateLimit?: RateLimitActivity;
	mcpServers?: Array<{ name: string; status: string }>;
	truncatedBacklog?: { olderThanSeq: number; reason: string };
	tools: Array<{
		id: string;
		name: string;
		state: "running" | "result" | "error" | "aborted" | "blocked";
		isMcp: boolean;
		mcpServer?: string;
		safeInputSummary?: string;
		safeOutputSummary?: string;
		outputTruncated?: boolean;
		durationMs?: number;
		elapsedSeconds?: number;
		blockReason?: string;
	}>;
	subagents: Array<Omit<SubagentActivity, "updatedAt">>;
	errors: Array<{
		subtype: string;
		recoverable: boolean;
		message: string;
	}>;
};

export type RunTimelineView = {
	activity: RunActivityState;
	toolCalls: ToolCallState[];
};

export type ChatState = {
	messages: ChatMessage[];
	activeToolCalls: Map<string, ToolCallState>;
	thinkingBlocks: Map<string, ThinkingBlockState>;
	textBlocks: Map<string, TextBlockState>;
	runActivity: RunActivityState | null;
	isStreaming: boolean;
	streamConnectionState: StreamConnectionState;
	lastSeq: number;
	sessionId: string | null;
};
