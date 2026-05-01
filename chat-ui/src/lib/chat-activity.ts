import type {
	ChatState,
	DurableRunTimelineSummary,
	RateLimitActivity,
	RunActivityState,
	RunActivityStatus,
	RunTimelineView,
	SubagentActivity,
	ToolCallState,
} from "./chat-types";

export const ACTIVE_RUN_MESSAGE_ID = "__phantom_active_run__";

function nowIso(): string {
	return new Date().toISOString();
}

function str(data: Record<string, unknown>, key: string): string | undefined {
	const value = data[key];
	return typeof value === "string" ? value : undefined;
}

function num(data: Record<string, unknown>, key: string): number | undefined {
	const value = data[key];
	return typeof value === "number" ? value : undefined;
}

function activityBase(label: string, at: string): RunActivityState {
	return {
		status: "starting",
		currentLabel: label,
		startedAt: at,
		updatedAt: at,
		isActive: true,
		subagents: new Map(),
	};
}

function patchActivity(s: ChatState, patch: (activity: RunActivityState, at: string) => RunActivityState): ChatState {
	const at = nowIso();
	const current = s.runActivity ?? activityBase("Working...", at);
	const next = patch({ ...current, subagents: new Map(current.subagents) }, at);
	return { ...s, runActivity: { ...next, updatedAt: at } };
}

export function beginRunActivityState(s: ChatState): ChatState {
	const at = nowIso();
	const activeToolCalls = new Map(
		Array.from(s.activeToolCalls).filter(([, call]) => call.messageId !== ACTIVE_RUN_MESSAGE_ID),
	);
	return { ...s, activeToolCalls, runActivity: activityBase("Starting...", at) };
}

export function latestAssistantMessageId(s: ChatState): string | null {
	for (let i = s.messages.length - 1; i >= 0; i--) {
		const message = s.messages[i];
		if (message?.role === "assistant") return message.id;
	}
	return null;
}

function latestStreamingAssistantMessageId(s: ChatState): string | null {
	for (let i = s.messages.length - 1; i >= 0; i--) {
		const message = s.messages[i];
		if (message?.role === "assistant" && message.status === "streaming") return message.id;
	}
	return null;
}

export function preferredToolMessageId(s: ChatState, data: Record<string, unknown>): string {
	const messageId = str(data, "message_id");
	if (messageId && s.messages.some((message) => message.id === messageId)) {
		return messageId;
	}
	if (s.runActivity?.isActive) {
		return latestStreamingAssistantMessageId(s) ?? ACTIVE_RUN_MESSAGE_ID;
	}
	return latestAssistantMessageId(s) ?? ACTIVE_RUN_MESSAGE_ID;
}

export function attachActivityToolsToAssistant(s: ChatState, messageId: string): ChatState {
	const calls = new Map(s.activeToolCalls);
	let changed = false;
	for (const [id, call] of calls) {
		if (call.messageId === ACTIVE_RUN_MESSAGE_ID) {
			calls.set(id, { ...call, messageId });
			changed = true;
		}
	}
	return changed ? { ...s, activeToolCalls: calls } : s;
}

export function runTimelineSummaryToView(summary: DurableRunTimelineSummary): RunTimelineView {
	const updatedAt = summary.completedAt ?? summary.startedAt;
	const activity: RunActivityState = {
		status: runTimelineStatusToActivityStatus(summary.status),
		currentLabel: summary.currentLabel ?? runTimelineFallbackLabel(summary.status),
		startedAt: summary.startedAt,
		updatedAt,
		isActive: summary.status === "working",
		compact: summary.compact,
		rateLimit: summary.rateLimit,
		mcpServers: summary.mcpServers,
		truncatedBacklog: summary.truncatedBacklog,
		subagents: new Map(
			summary.subagents.map((subagent) => [
				subagent.taskId,
				{
					...subagent,
					updatedAt,
				},
			]),
		),
	};
	const toolCalls: ToolCallState[] = summary.tools.map((tool) => ({
		id: tool.id,
		messageId: ACTIVE_RUN_MESSAGE_ID,
		toolName: tool.name,
		state: tool.state,
		inputJson: tool.safeInputSummary ?? "",
		output: tool.safeOutputSummary,
		durationMs: tool.durationMs,
		elapsedSeconds: tool.elapsedSeconds,
		outputTruncated: tool.outputTruncated,
		isMcp: tool.isMcp,
		mcpServer: tool.mcpServer,
		blockReason: tool.blockReason,
	}));
	return { activity, toolCalls };
}

function runTimelineStatusToActivityStatus(status: DurableRunTimelineSummary["status"]): RunActivityStatus {
	if (status === "completed") return "completed";
	if (status === "aborted") return "aborted";
	if (status === "error" || status === "recovered") return "error";
	return "working";
}

function runTimelineFallbackLabel(status: DurableRunTimelineSummary["status"]): string {
	if (status === "completed") return "Completed.";
	if (status === "aborted") return "Run stopped.";
	if (status === "error" || status === "recovered") return "Run stopped with an error.";
	return "Working...";
}

function statusLabel(status: string | undefined): {
	status: RunActivityStatus;
	label: string;
} {
	if (status === "compacting") {
		return { status: "compacting", label: "Compacting context..." };
	}
	if (status === "waiting_for_permission") {
		return { status: "working", label: "Waiting for permission..." };
	}
	if (status) {
		return { status: "working", label: `Working: ${status}` };
	}
	return { status: "working", label: "Working..." };
}

function updateSubagent(
	activity: RunActivityState,
	taskId: string,
	patch: Partial<SubagentActivity>,
	at: string,
): RunActivityState {
	const existing = activity.subagents.get(taskId);
	activity.subagents.set(taskId, {
		taskId,
		description: existing?.description ?? "",
		status: existing?.status ?? "running",
		...existing,
		...patch,
		updatedAt: at,
	});
	return activity;
}

function rateLimitActivity(data: Record<string, unknown>): RateLimitActivity {
	return {
		status: (str(data, "status") as RateLimitActivity["status"] | undefined) ?? "allowed",
		rateLimitType: str(data, "rate_limit_type"),
		resetsAt: str(data, "resets_at"),
		utilization: num(data, "utilization"),
	};
}

export function updateRunActivityForFrame(s: ChatState, event: string, data: Record<string, unknown>): ChatState {
	switch (event) {
		case "user.message":
			return s.runActivity?.isActive
				? patchActivity(s, (activity) => ({ ...activity, status: "working", currentLabel: "Working..." }))
				: beginRunActivityState(s);
		case "message.assistant_start":
			return patchActivity(s, (activity) => ({
				...activity,
				status: "working",
				currentLabel: "Drafting a response...",
			}));
		case "session.resumed":
			return patchActivity(s, (activity) => ({
				...activity,
				status: "working",
				currentLabel: "Replaying recent activity...",
				isActive: data.writer_active === true || activity.isActive,
			}));
		case "session.caught_up":
			return s.runActivity?.isActive
				? patchActivity(s, (activity) => ({
						...activity,
						status: "working",
						currentLabel: "Reconnected.",
						isActive: true,
					}))
				: s;
		case "session.status":
			return patchActivity(s, (activity) => {
				const next = statusLabel(str(data, "status"));
				return { ...activity, status: next.status, currentLabel: next.label, isActive: true };
			});
		case "session.compact_boundary":
			return patchActivity(s, (activity) => ({
				...activity,
				status: "compacting",
				currentLabel: "Compacted context and kept working.",
				compact: {
					trigger: (str(data, "trigger") as "manual" | "auto" | undefined) ?? "auto",
					preTokens: num(data, "pre_tokens") ?? 0,
				},
			}));
		case "session.rate_limit":
			return patchActivity(s, (activity) => {
				const rateLimit = rateLimitActivity(data);
				return {
					...activity,
					status: rateLimit.status === "rejected" ? "rate_limited" : "working",
					currentLabel: rateLimit.status === "rejected" ? "Rate limit reached." : "Working within rate limits.",
					rateLimit,
				};
			});
		case "session.mcp_status":
			return patchActivity(s, (activity) => ({
				...activity,
				status: "working",
				currentLabel: "Tool servers are connected.",
				mcpServers: Array.isArray(data.servers) ? (data.servers as Array<{ name: string; status: string }>) : [],
			}));
		case "session.truncated_backlog":
			return patchActivity(s, (activity) => ({
				...activity,
				currentLabel: "Loaded recent stream history.",
				truncatedBacklog: {
					olderThanSeq: num(data, "older_than_seq") ?? 0,
					reason: str(data, "reason") ?? "truncated",
				},
			}));
		case "message.subagent_start":
			return patchActivity(s, (activity, at) =>
				updateSubagent(
					{ ...activity, currentLabel: str(data, "description") ?? "Subagent started." },
					str(data, "task_id") ?? "subagent",
					{
						toolCallId: str(data, "tool_call_id"),
						description: str(data, "description") ?? "Subagent",
						status: "running",
					},
					at,
				),
			);
		case "message.subagent_progress":
			return patchActivity(s, (activity, at) =>
				updateSubagent(
					{ ...activity, currentLabel: str(data, "summary") ?? "Subagent is working..." },
					str(data, "task_id") ?? "subagent",
					{
						summary: str(data, "summary"),
						lastToolName: str(data, "last_tool_name"),
						durationMs: num(data, "duration_ms"),
						totalTokens: num(data, "total_tokens"),
						toolUses: num(data, "tool_uses"),
					},
					at,
				),
			);
		case "message.subagent_end":
			return patchActivity(s, (activity, at) =>
				updateSubagent(
					{ ...activity, currentLabel: str(data, "summary") ?? "Subagent finished." },
					str(data, "task_id") ?? "subagent",
					{
						status: (str(data, "status") as SubagentActivity["status"] | undefined) ?? "completed",
						summary: str(data, "summary"),
						outputFile: str(data, "output_file"),
						durationMs: num(data, "duration_ms"),
						totalTokens: num(data, "total_tokens"),
						toolUses: num(data, "tool_uses"),
					},
					at,
				),
			);
		case "message.tool_call_running":
			return patchActivity(s, (activity) => ({
				...activity,
				status: "working",
				currentLabel: `Using ${str(data, "tool_name") ?? "a tool"}...`,
			}));
		case "message.tool_call_blocked":
			return patchActivity(s, (activity) => ({
				...activity,
				status: "working",
				currentLabel: "A tool call was blocked.",
			}));
		case "message.tool_call_aborted":
			return patchActivity(s, (activity) => ({
				...activity,
				status: "aborted",
				currentLabel: "A tool call was stopped.",
			}));
		case "message.tool_call_result":
			return patchActivity(s, (activity) => ({
				...activity,
				status: "working",
				currentLabel: "Tool activity completed.",
			}));
		case "session.done":
			return patchActivity(s, (activity) => ({
				...activity,
				status: str(data, "stop_reason") === "aborted" ? "aborted" : "completed",
				currentLabel: str(data, "stop_reason") === "aborted" ? "Run stopped." : "Completed.",
				isActive: false,
			}));
		case "session.error":
			return patchActivity(s, (activity) => ({
				...activity,
				status: "error",
				currentLabel:
					str(data, "subtype") === "server_restart" ? "Connection interrupted." : "Run stopped with an error.",
				isActive: false,
			}));
		case "session.aborted":
			return patchActivity(s, (activity) => ({
				...activity,
				status: "aborted",
				currentLabel: "Run stopped.",
				isActive: false,
			}));
		default:
			return s;
	}
}
