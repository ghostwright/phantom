import type { Database } from "bun:sqlite";
import type { SessionErrorSubtype, StopReason } from "./types.ts";
import type { ChatWireFrame } from "./types.ts";

export type RunTimelineStatus = "working" | "completed" | "error" | "aborted" | "recovered";
export type RunTimelineToolState = "running" | "result" | "error" | "aborted" | "blocked";

export type DurableRunTimelineToolSummary = {
	id: string;
	name: string;
	state: RunTimelineToolState;
	isMcp: boolean;
	mcpServer?: string;
	safeInputSummary?: string;
	safeOutputSummary?: string;
	outputTruncated?: boolean;
	durationMs?: number;
	elapsedSeconds?: number;
	blockReason?: string;
};

export type DurableRunTimelineSubagentSummary = {
	taskId: string;
	toolCallId?: string;
	description: string;
	status: "running" | "completed" | "failed" | "stopped";
	summary?: string;
	lastToolName?: string;
	outputFile?: string;
	durationMs?: number;
	totalTokens?: number;
	toolUses?: number;
};

export type DurableRunTimelineErrorSummary = {
	subtype: SessionErrorSubtype;
	recoverable: boolean;
	message: string;
};

export type DurableRunTimelineSummary = {
	schemaVersion: 1;
	status: RunTimelineStatus;
	startSeq: number;
	endSeq: number | null;
	startedAt: string;
	completedAt?: string;
	currentLabel?: string;
	stopReason?: StopReason;
	durationMs?: number;
	costUsd?: number;
	inputTokens?: number;
	outputTokens?: number;
	compact?: { trigger: "manual" | "auto"; preTokens: number };
	rateLimit?: {
		status: "allowed" | "allowed_warning" | "rejected";
		rateLimitType?: string;
		resetsAt?: string;
		utilization?: number;
	};
	mcpServers?: Array<{ name: string; status: string }>;
	truncatedBacklog?: { olderThanSeq: number; reason: string };
	tools: DurableRunTimelineToolSummary[];
	subagents: DurableRunTimelineSubagentSummary[];
	errors: DurableRunTimelineErrorSummary[];
};

export type ChatRunTimelineRow = {
	id: string;
	session_id: string;
	user_message_id: string;
	assistant_message_id: string | null;
	start_seq: number;
	end_seq: number | null;
	status: RunTimelineStatus;
	started_at: string;
	completed_at: string | null;
	current_label: string | null;
	stop_reason: string | null;
	duration_ms: number | null;
	cost_usd: number | null;
	input_tokens: number | null;
	output_tokens: number | null;
	summary_json: string;
	created_at: string;
	updated_at: string;
};

export type ChatRunTimelineUpsert = {
	id: string;
	sessionId: string;
	userMessageId: string;
	assistantMessageId?: string | null;
	startSeq: number;
	endSeq?: number | null;
	status: RunTimelineStatus;
	startedAt: string;
	completedAt?: string | null;
	currentLabel?: string | null;
	stopReason?: StopReason | null;
	durationMs?: number | null;
	costUsd?: number | null;
	inputTokens?: number | null;
	outputTokens?: number | null;
	summary: DurableRunTimelineSummary;
};

export type ChatRunTimelineDetail = {
	id: string;
	session_id: string;
	user_message_id: string;
	assistant_message_id: string | null;
	start_seq: number;
	end_seq: number | null;
	status: RunTimelineStatus;
	started_at: string;
	completed_at: string | null;
	current_label: string | null;
	stop_reason: string | null;
	duration_ms: number | null;
	cost_usd: number | null;
	input_tokens: number | null;
	output_tokens: number | null;
	summary: DurableRunTimelineSummary;
};

const MAX_SUMMARY_TEXT = 240;
const MAX_OUTPUT_SUMMARY_TEXT = 360;
const MAX_COLLECTION_ITEMS = 25;
const MAX_INPUT_PARTS = 3;

function isTerminalToolState(state: RunTimelineToolState): boolean {
	return state === "result" || state === "error" || state === "blocked" || state === "aborted";
}

export class ChatRunTimelineStore {
	private db: Database;

	constructor(db: Database) {
		this.db = db;
	}

	upsert(params: ChatRunTimelineUpsert): void {
		this.db.run(
			`INSERT INTO chat_run_timelines (
				id, session_id, user_message_id, assistant_message_id, start_seq, end_seq,
				status, started_at, completed_at, current_label, stop_reason, duration_ms,
				cost_usd, input_tokens, output_tokens, summary_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				assistant_message_id = excluded.assistant_message_id,
				end_seq = excluded.end_seq,
				status = excluded.status,
				completed_at = excluded.completed_at,
				current_label = excluded.current_label,
				stop_reason = excluded.stop_reason,
				duration_ms = excluded.duration_ms,
				cost_usd = excluded.cost_usd,
				input_tokens = excluded.input_tokens,
				output_tokens = excluded.output_tokens,
				summary_json = excluded.summary_json,
				updated_at = datetime('now')`,
			[
				params.id,
				params.sessionId,
				params.userMessageId,
				params.assistantMessageId ?? null,
				params.startSeq,
				params.endSeq ?? null,
				params.status,
				params.startedAt,
				params.completedAt ?? null,
				params.currentLabel ?? null,
				params.stopReason ?? null,
				params.durationMs ?? null,
				params.costUsd ?? null,
				params.inputTokens ?? null,
				params.outputTokens ?? null,
				JSON.stringify(params.summary),
			],
		);
	}

	getBySession(sessionId: string): ChatRunTimelineRow[] {
		return this.db
			.query(
				`SELECT * FROM chat_run_timelines
				 WHERE session_id = ?
				 ORDER BY start_seq ASC`,
			)
			.all(sessionId) as ChatRunTimelineRow[];
	}

	getDetailsBySession(sessionId: string): ChatRunTimelineDetail[] {
		return this.getBySession(sessionId).map(runTimelineRowToDetail);
	}

	deleteBySession(sessionId: string): number {
		const result = this.db.run("DELETE FROM chat_run_timelines WHERE session_id = ?", [sessionId]);
		return result.changes;
	}
}

export type RunTimelineStartParams = {
	sessionId: string;
	userMessageId: string;
	startSeq: number;
	startedAt: string;
};

export class DurableRunTimelineBuilder {
	private readonly id: string;
	private readonly sessionId: string;
	private readonly userMessageId: string;
	private assistantMessageId: string | null = null;
	private summary: DurableRunTimelineSummary;

	private constructor(params: RunTimelineStartParams) {
		this.id = params.userMessageId;
		this.sessionId = params.sessionId;
		this.userMessageId = params.userMessageId;
		this.summary = {
			schemaVersion: 1,
			status: "working",
			startSeq: params.startSeq,
			endSeq: null,
			startedAt: params.startedAt,
			currentLabel: "Working...",
			tools: [],
			subagents: [],
			errors: [],
		};
	}

	static start(params: RunTimelineStartParams): DurableRunTimelineBuilder {
		return new DurableRunTimelineBuilder(params);
	}

	setAssistantMessageId(messageId: string | null): void {
		this.assistantMessageId = messageId;
	}

	apply(frame: ChatWireFrame, seq: number): boolean {
		switch (frame.event) {
			case "user.message":
				this.summary.currentLabel = "Working...";
				return true;
			case "message.assistant_start":
				this.summary.currentLabel = "Drafting a response...";
				return true;
			case "message.thinking_start":
				this.summary.currentLabel = "Thinking...";
				return true;
			case "message.thinking_end":
				this.summary.currentLabel = "Finished reasoning.";
				return true;
			case "message.tool_call_start": {
				const tool = this.tool(frame.tool_call_id, frame.tool_name);
				tool.name = safeLabel(frame.tool_name);
				if (!isTerminalToolState(tool.state)) {
					tool.state = "running";
				}
				tool.isMcp = frame.is_mcp;
				tool.mcpServer = safeText(frame.mcp_server);
				this.summary.currentLabel = `Using ${tool.name}...`;
				return true;
			}
			case "message.tool_call_input_end": {
				const tool = this.tool(frame.tool_call_id);
				if (!isTerminalToolState(tool.state)) {
					tool.state = "running";
				}
				tool.safeInputSummary = summarizeToolInput(frame.input);
				this.summary.currentLabel = `Prepared ${tool.name}.`;
				return true;
			}
			case "message.tool_call_running": {
				const tool = this.tool(frame.tool_call_id, frame.tool_name);
				tool.name = safeLabel(frame.tool_name ?? tool.name);
				if (!isTerminalToolState(tool.state)) {
					tool.state = "running";
				}
				tool.elapsedSeconds = safeNonNegativeNumber(frame.elapsed_seconds);
				const inputPreview = safeText(frame.input_preview);
				if (inputPreview) {
					tool.safeInputSummary = inputPreview;
				}
				const outputPreview = safeText(frame.output_preview, MAX_OUTPUT_SUMMARY_TEXT);
				if (outputPreview) {
					tool.safeOutputSummary = outputPreview;
					tool.outputTruncated =
						frame.output_truncated === true || isTruncated(frame.output_preview, MAX_OUTPUT_SUMMARY_TEXT);
				}
				this.summary.currentLabel = `Using ${tool.name}...`;
				return true;
			}
			case "message.tool_call_result": {
				const tool = this.tool(frame.tool_call_id, frame.tool_name);
				tool.name = safeLabel(frame.tool_name ?? tool.name);
				tool.state = frame.status === "error" ? "error" : "result";
				tool.durationMs = safeNonNegativeNumber(frame.duration_ms);
				tool.safeOutputSummary =
					safeText(frame.output_preview, MAX_OUTPUT_SUMMARY_TEXT) ?? summarizeToolOutput(frame.status, frame.output);
				tool.outputTruncated =
					frame.output_truncated === true || isTruncated(frame.output_preview ?? frame.output, MAX_OUTPUT_SUMMARY_TEXT);
				this.summary.currentLabel = frame.status === "error" ? `${tool.name} failed.` : `${tool.name} completed.`;
				return true;
			}
			case "message.tool_call_blocked": {
				const tool = this.tool(frame.tool_call_id, frame.tool_name);
				tool.name = safeLabel(frame.tool_name ?? tool.name);
				tool.state = "blocked";
				tool.blockReason = safeText(frame.reason);
				this.summary.currentLabel = "A tool call was blocked.";
				return true;
			}
			case "message.tool_call_aborted": {
				const tool = this.tool(frame.tool_call_id, frame.tool_name);
				tool.name = safeLabel(frame.tool_name ?? tool.name);
				tool.state = "aborted";
				this.summary.currentLabel = "A tool call was stopped.";
				return true;
			}
			case "session.status":
				this.summary.currentLabel = statusLabel(frame.status);
				return true;
			case "session.compact_boundary":
				this.summary.compact = {
					trigger: frame.trigger,
					preTokens: frame.pre_tokens,
				};
				this.summary.currentLabel = "Compacted context and kept working.";
				return true;
			case "session.rate_limit":
				this.summary.rateLimit = {
					status: frame.status,
					rateLimitType: safeText(frame.rate_limit_type),
					resetsAt: safeText(frame.resets_at),
					utilization: safeNonNegativeNumber(frame.utilization),
				};
				this.summary.currentLabel = frame.status === "rejected" ? "Rate limit reached." : "Working within rate limits.";
				return true;
			case "session.mcp_status":
				this.summary.mcpServers = frame.servers.slice(0, MAX_COLLECTION_ITEMS).map((server) => ({
					name: safeLabel(server.name),
					status: safeLabel(server.status),
				}));
				this.summary.currentLabel = "Tool servers are connected.";
				return true;
			case "session.truncated_backlog":
				this.summary.truncatedBacklog = {
					olderThanSeq: frame.older_than_seq,
					reason: safeLabel(frame.reason),
				};
				return true;
			case "message.subagent_start": {
				const subagent = this.subagent(frame.task_id);
				subagent.toolCallId = safeText(frame.tool_call_id);
				subagent.description = safeText(frame.description) ?? "Subagent";
				subagent.status = "running";
				this.summary.currentLabel = subagent.description;
				return true;
			}
			case "message.subagent_progress": {
				const subagent = this.subagent(frame.task_id);
				subagent.summary = safeText(frame.summary);
				subagent.lastToolName = safeText(frame.last_tool_name);
				subagent.durationMs = safeNonNegativeNumber(frame.duration_ms);
				subagent.totalTokens = safeNonNegativeNumber(frame.total_tokens);
				subagent.toolUses = safeNonNegativeNumber(frame.tool_uses);
				this.summary.currentLabel = subagent.summary ?? "Subagent is working...";
				return true;
			}
			case "message.subagent_end": {
				const subagent = this.subagent(frame.task_id);
				subagent.status = frame.status;
				subagent.outputFile = safeText(frame.output_file);
				subagent.summary = safeText(frame.summary);
				subagent.durationMs = safeNonNegativeNumber(frame.duration_ms);
				subagent.totalTokens = safeNonNegativeNumber(frame.total_tokens);
				subagent.toolUses = safeNonNegativeNumber(frame.tool_uses);
				this.summary.currentLabel = subagent.summary ?? "Subagent finished.";
				return true;
			}
			case "session.aborted":
				this.finish(seq, "aborted", {
					completedAt: frame.aborted_at,
					costUsd: frame.cost_usd,
					durationMs: frame.duration_ms,
					currentLabel: "Run stopped.",
				});
				return true;
			case "session.error": {
				const message = safeText(frame.errors.join("\n")) ?? "Run stopped with an error.";
				this.summary.errors.push({
					subtype: frame.subtype,
					recoverable: frame.recoverable,
					message,
				});
				if (this.summary.errors.length > MAX_COLLECTION_ITEMS) {
					this.summary.errors = this.summary.errors.slice(-MAX_COLLECTION_ITEMS);
				}
				this.finish(seq, frame.subtype === "server_restart" ? "recovered" : "error", {
					costUsd: frame.cost_usd,
					durationMs: frame.duration_ms,
					currentLabel: frame.subtype === "server_restart" ? "Run needs recovery." : "Run stopped with an error.",
				});
				return true;
			}
			case "session.done": {
				const terminalStatus =
					frame.stop_reason === "aborted" || this.summary.status === "aborted" ? "aborted" : "completed";
				this.finish(seq, terminalStatus, {
					stopReason: frame.stop_reason,
					costUsd: frame.cost_usd,
					durationMs: frame.duration_ms,
					inputTokens: frame.usage.input_tokens,
					outputTokens: frame.usage.output_tokens,
					currentLabel: terminalStatus === "aborted" ? "Run stopped." : "Completed.",
				});
				return true;
			}
			default:
				return false;
		}
	}

	toUpsertParams(): ChatRunTimelineUpsert {
		return {
			id: this.id,
			sessionId: this.sessionId,
			userMessageId: this.userMessageId,
			assistantMessageId: this.assistantMessageId,
			startSeq: this.summary.startSeq,
			endSeq: this.summary.endSeq,
			status: this.summary.status,
			startedAt: this.summary.startedAt,
			completedAt: this.summary.completedAt ?? null,
			currentLabel: this.summary.currentLabel ?? null,
			stopReason: this.summary.stopReason ?? null,
			durationMs: this.summary.durationMs ?? null,
			costUsd: this.summary.costUsd ?? null,
			inputTokens: this.summary.inputTokens ?? null,
			outputTokens: this.summary.outputTokens ?? null,
			summary: this.snapshot(),
		};
	}

	private snapshot(): DurableRunTimelineSummary {
		return {
			...this.summary,
			tools: this.summary.tools.map((tool) => ({ ...tool })),
			subagents: this.summary.subagents.map((subagent) => ({ ...subagent })),
			errors: this.summary.errors.map((error) => ({ ...error })),
			mcpServers: this.summary.mcpServers?.map((server) => ({ ...server })),
		};
	}

	private finish(
		seq: number,
		status: RunTimelineStatus,
		params: {
			completedAt?: string;
			currentLabel: string;
			stopReason?: StopReason;
			durationMs?: number;
			costUsd?: number;
			inputTokens?: number;
			outputTokens?: number;
		},
	): void {
		this.summary.status = status;
		this.summary.endSeq = seq;
		this.summary.completedAt = params.completedAt ?? this.summary.completedAt ?? new Date().toISOString();
		this.summary.currentLabel = params.currentLabel;
		this.summary.stopReason = params.stopReason ?? this.summary.stopReason;
		this.summary.durationMs = safeNonNegativeNumber(params.durationMs);
		this.summary.costUsd = safeNonNegativeNumber(params.costUsd);
		this.summary.inputTokens = safeNonNegativeNumber(params.inputTokens);
		this.summary.outputTokens = safeNonNegativeNumber(params.outputTokens);
	}

	private tool(toolId: string, name?: string): DurableRunTimelineToolSummary {
		let existing = this.summary.tools.find((tool) => tool.id === toolId);
		if (existing) return existing;
		existing = {
			id: safeLabel(toolId),
			name: safeLabel(name ?? "Tool"),
			state: "running",
			isMcp: false,
		};
		this.summary.tools.push(existing);
		if (this.summary.tools.length > MAX_COLLECTION_ITEMS) {
			this.summary.tools = this.summary.tools.slice(-MAX_COLLECTION_ITEMS);
		}
		return existing;
	}

	private subagent(taskId: string): DurableRunTimelineSubagentSummary {
		let existing = this.summary.subagents.find((subagent) => subagent.taskId === taskId);
		if (existing) return existing;
		existing = {
			taskId: safeLabel(taskId),
			description: "Subagent",
			status: "running",
		};
		this.summary.subagents.push(existing);
		if (this.summary.subagents.length > MAX_COLLECTION_ITEMS) {
			this.summary.subagents = this.summary.subagents.slice(-MAX_COLLECTION_ITEMS);
		}
		return existing;
	}
}

export function runTimelineRowToDetail(row: ChatRunTimelineRow): ChatRunTimelineDetail {
	return {
		id: row.id,
		session_id: row.session_id,
		user_message_id: row.user_message_id,
		assistant_message_id: row.assistant_message_id,
		start_seq: row.start_seq,
		end_seq: row.end_seq,
		status: row.status,
		started_at: row.started_at,
		completed_at: row.completed_at,
		current_label: row.current_label,
		stop_reason: row.stop_reason,
		duration_ms: row.duration_ms,
		cost_usd: row.cost_usd,
		input_tokens: row.input_tokens,
		output_tokens: row.output_tokens,
		summary: parseRunTimelineSummary(row.summary_json, row),
	};
}

function parseRunTimelineSummary(summaryJson: string, row: ChatRunTimelineRow): DurableRunTimelineSummary {
	try {
		const parsed = JSON.parse(summaryJson) as unknown;
		if (isRunTimelineSummary(parsed)) return parsed;
	} catch {
		/* fall through to fallback */
	}
	return {
		schemaVersion: 1,
		status: row.status,
		startSeq: row.start_seq,
		endSeq: row.end_seq,
		startedAt: row.started_at,
		completedAt: row.completed_at ?? undefined,
		currentLabel: row.current_label ?? undefined,
		stopReason: (row.stop_reason as StopReason | null) ?? undefined,
		durationMs: row.duration_ms ?? undefined,
		costUsd: row.cost_usd ?? undefined,
		inputTokens: row.input_tokens ?? undefined,
		outputTokens: row.output_tokens ?? undefined,
		tools: [],
		subagents: [],
		errors: [],
	};
}

function isRunTimelineSummary(value: unknown): value is DurableRunTimelineSummary {
	if (!isObject(value)) return false;
	return (
		value.schemaVersion === 1 &&
		typeof value.status === "string" &&
		typeof value.startSeq === "number" &&
		(value.endSeq === null || typeof value.endSeq === "number") &&
		typeof value.startedAt === "string" &&
		Array.isArray(value.tools) &&
		Array.isArray(value.subagents) &&
		Array.isArray(value.errors)
	);
}

function statusLabel(status: string | null): string {
	if (status === "compacting") return "Compacting context...";
	if (status === "waiting_for_permission") return "Waiting for permission...";
	if (status && status.length > 0) return `Working: ${safeLabel(status)}`;
	return "Working...";
}

function summarizeToolInput(input: unknown): string | undefined {
	if (typeof input === "string") {
		const trimmed = input.trim();
		if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
			try {
				return summarizeToolInput(JSON.parse(trimmed) as unknown);
			} catch {
				return "Input captured.";
			}
		}
		return "Input captured.";
	}
	if (!isObject(input)) return undefined;

	const parts: string[] = [];
	for (const key of ["command", "cmd"]) {
		const value = input[key];
		if (typeof value === "string") {
			const commandSummary = summarizeCommand(value);
			if (commandSummary) parts.push(`command: ${commandSummary}`);
			break;
		}
	}
	for (const key of ["url", "uri"]) {
		if (parts.length >= MAX_INPUT_PARTS) break;
		const value = input[key];
		if (typeof value === "string") {
			const urlSummary = summarizeUrl(value);
			if (urlSummary) parts.push(`${key}: ${urlSummary}`);
			break;
		}
	}

	const safeKeys = ["file", "file_path", "path", "query", "pattern", "description", "task", "title"];
	for (const key of safeKeys) {
		if (parts.length >= MAX_INPUT_PARTS) break;
		if (isSensitiveKey(key)) continue;
		const value = input[key];
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
			const text = safeText(String(value), 96);
			if (text) parts.push(`${key}: ${text}`);
		}
	}
	return parts.length > 0 ? parts.join("; ") : undefined;
}

function summarizeToolOutput(status: "success" | "error", output: string | undefined): string | undefined {
	if (status === "error") return "Tool returned an error.";
	if (typeof output !== "string" || output.length === 0) return undefined;
	return "Tool produced output.";
}

function summarizeCommand(command: string): string | undefined {
	const redacted = redact(command).trim();
	if (redacted.length === 0) return undefined;
	const withoutEnvAssignments = redacted.replace(/^\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+)*/g, "");
	const token = withoutEnvAssignments.split(/\s+/).find((part) => part.length > 0);
	if (!token) return "captured";
	return safeLabel(token.replace(/[^\w./:-]/g, ""));
}

function summarizeUrl(value: string): string | undefined {
	try {
		const parsed = new URL(redact(value));
		if (!["http:", "https:"].includes(parsed.protocol)) return "captured";
		return safeText(`${parsed.protocol}//${parsed.host}${parsed.pathname}`, 96);
	} catch {
		return "captured";
	}
}

function safeText(value: string | undefined, maxLength = MAX_SUMMARY_TEXT): string | undefined {
	if (value === undefined) return undefined;
	const redacted = redact(value).replace(/\s+/g, " ").trim();
	if (redacted.length === 0) return undefined;
	if (redacted.length <= maxLength) return redacted;
	return `${redacted.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function safeLabel(value: string | undefined): string {
	return safeText(value, 96) ?? "Unknown";
}

function safeNonNegativeNumber(value: number | undefined): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.max(0, value);
}

function isTruncated(value: string | undefined, maxLength: number): boolean {
	return typeof value === "string" && (value.length > maxLength || redact(value).length > maxLength);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSensitiveKey(key: string): boolean {
	return /(?:api[_-]?key|access[_-]?key|private[_-]?key|secret|token|password|auth|authorization|cookie|credential|session|oauth|^code$)/i.test(
		key,
	);
}

function redact(value: string): string {
	let output = value;
	output = output.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/g, "[REDACTED_PRIVATE_KEY]");
	output = output.replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED_AWS_KEY]");
	output = output.replace(
		/([?&](?:code|access_token|refresh_token|id_token|client_secret|token|secret|api_key|key)=)[^&\s]+/gi,
		"$1[REDACTED]",
	);
	output = output.replace(/bearer\s+[a-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
	output = output.replace(/(authorization\s*[:=]\s*)([^\s,;]+)/gi, "$1[REDACTED]");
	output = output.replace(/(\bcookie\s*[:=]\s*)([^\n]+)/gi, "$1[REDACTED]");
	output = output.replace(
		/(\b(?:x[-_])?[a-z0-9_-]*(?:api[-_]?key|access[-_]?key|private[-_]?key|csrf[-_]?token|xsrf[-_]?token|csrf|xsrf|token|secret|password|auth|credential|session)[a-z0-9_-]*\s*:\s*)([^\s,;]+)/gi,
		"$1[REDACTED]",
	);
	output = output.replace(
		/([a-z0-9_]*(?:api[_-]?key|access[_-]?key|private[_-]?key|token|secret|password|auth|credential|session|oauth|csrf|xsrf)[a-z0-9_]*\s*=\s*)([^\s&]+)/gi,
		"$1[REDACTED]",
	);
	output = output.replace(
		/(\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL|PRIVATE|SESSION|CODE|CSRF|XSRF)[A-Z0-9_]*\s*=\s*)([^\s&]+)/g,
		"$1[REDACTED]",
	);
	output = output.replace(/\b(sk-[a-z0-9_-]{12,})\b/gi, "[REDACTED_SECRET]");
	output = output.replace(/\b([a-z0-9+/]{80,}={0,2})\b/gi, "[REDACTED_BLOB]");
	return output;
}
