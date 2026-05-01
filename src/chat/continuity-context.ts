import type { ChatEventLog, ChatStreamEvent } from "./event-log.ts";

const DEFAULT_EVENT_SCAN_LIMIT = 5000;
const MAX_ARTIFACTS = 8;
const MAX_COMPACTIONS = 3;
const MAX_LABEL_LENGTH = 90;
const PAGE_TOOLS = new Set(["phantom_create_page", "phantom_preview_page"]);

type BuildChatContinuityContextInput = {
	sessionId: string;
	eventLog: ChatEventLog;
	limit?: number;
};

type ToolAccumulator = {
	seq: number;
	toolName?: string;
	input?: unknown;
	output?: string;
	status?: string;
};

type PageArtifact = {
	seq: number;
	toolName: string;
	label: string;
	url?: string;
	path?: string;
	size?: number;
};

type CompactCheckpoint = {
	seq: number;
	trigger?: string;
	preTokens?: number;
};

export function buildChatContinuityContext(input: BuildChatContinuityContextInput): string | undefined {
	const events = input.eventLog.tail(input.sessionId, input.limit ?? DEFAULT_EVENT_SCAN_LIMIT);
	const tools = new Map<string, ToolAccumulator>();
	const compactions: CompactCheckpoint[] = [];

	for (const event of events) {
		const payload = parsePayload(event);
		if (!payload) continue;
		const eventType = stringField(payload, "event") ?? event.event_type;

		if (eventType === "session.compact_boundary") {
			compactions.push({
				seq: event.seq,
				trigger: stringField(payload, "trigger"),
				preTokens: numberField(payload, "pre_tokens"),
			});
			continue;
		}

		if (!eventType.startsWith("message.tool_call_")) continue;
		const toolCallId = stringField(payload, "tool_call_id");
		if (!toolCallId) continue;
		const tool = tools.get(toolCallId) ?? { seq: event.seq };
		tool.seq = event.seq;

		const toolName = stringField(payload, "tool_name");
		if (toolName) tool.toolName = toolName;

		if (eventType === "message.tool_call_input_end") {
			tool.input = payload.input;
		} else if (eventType === "message.tool_call_running") {
			const outputPreview = stringField(payload, "output_preview");
			if (outputPreview && !tool.output) tool.output = outputPreview;
		} else if (eventType === "message.tool_call_result") {
			tool.status = stringField(payload, "status");
			tool.output = stringField(payload, "output") ?? stringField(payload, "output_preview") ?? tool.output;
		}

		tools.set(toolCallId, tool);
	}

	const artifacts = dedupeArtifacts([...tools.values()].flatMap((tool) => artifactFromTool(tool) ?? []));
	const latestCompactions = compactions.slice(-MAX_COMPACTIONS);

	return renderContext({
		sessionId: input.sessionId,
		artifacts: artifacts.slice(-MAX_ARTIFACTS),
		compactions: latestCompactions,
	});
}

function renderContext(input: {
	sessionId: string;
	artifacts: PageArtifact[];
	compactions: CompactCheckpoint[];
}): string {
	const lines = [
		"Durable Phantom chat context:",
		`- Current Phantom chat session id: ${input.sessionId}.`,
		"- The transcript may have been compacted by Murph. Continue from the latest user message using these host facts when relevant.",
		"- If an older detail is missing after compaction, call phantom_chat_transcript_search with the current chat session id before asking the user to repeat it.",
		"- Authentication links from phantom_generate_login are not page artifacts.",
	];

	if (input.compactions.length > 0) {
		lines.push("", "Recent compaction checkpoints:");
		for (const checkpoint of input.compactions) {
			const trigger = checkpoint.trigger ?? "unknown";
			const tokens =
				checkpoint.preTokens === undefined
					? ""
					: ` before about ${checkpoint.preTokens.toLocaleString("en-US")} tokens`;
			lines.push(`- ${trigger} compaction at stream seq ${checkpoint.seq}${tokens}.`);
		}
	}

	if (input.artifacts.length > 0) {
		lines.push("", "User-visible page artifacts from earlier tool work:");
		for (const artifact of input.artifacts) {
			const parts = [`- ${artifact.label}`];
			if (artifact.url) parts.push(` URL: ${artifact.url}`);
			if (artifact.path) parts.push(` path: ${artifact.path}`);
			if (artifact.size !== undefined) parts.push(` size: ${artifact.size} bytes`);
			parts.push(` via ${artifact.toolName} at stream seq ${artifact.seq}.`);
			lines.push(parts.join(";"));
		}
	}

	return lines.join("\n");
}

function artifactFromTool(tool: ToolAccumulator): PageArtifact | undefined {
	const toolName = normalizePageToolName(tool.toolName);
	if (!toolName) return undefined;

	const input = recordFromUnknown(tool.input);
	const output = parseJsonRecord(tool.output);
	const path = normalizePagePath(stringField(output, "path") ?? stringField(input, "path"));
	const url = normalizePageUrl(
		stringField(output, "url") ??
			stringField(output, "publicUrl") ??
			stringField(output, "pageUrl") ??
			urlFromText(tool.output),
	);
	if (!url && !path) return undefined;

	const title = stringField(input, "title") ?? stringField(output, "title") ?? path ?? url ?? "Created page";
	const size = numberField(output, "size");
	return {
		seq: tool.seq,
		toolName,
		label: truncate(title, MAX_LABEL_LENGTH),
		...(url ? { url } : {}),
		...(path ? { path } : {}),
		...(size !== undefined ? { size } : {}),
	};
}

function normalizePageToolName(toolName: string | undefined): string | undefined {
	if (!toolName) return undefined;
	for (const pageToolName of PAGE_TOOLS) {
		if (toolName === pageToolName || toolName.endsWith(`__${pageToolName}`) || toolName.endsWith(`:${pageToolName}`)) {
			return pageToolName;
		}
	}
	return undefined;
}

function dedupeArtifacts(artifacts: PageArtifact[]): PageArtifact[] {
	const byKey = new Map<string, PageArtifact>();
	for (const artifact of artifacts) {
		const key = artifact.url ?? artifact.path ?? `${artifact.toolName}:${artifact.seq}`;
		byKey.set(key, artifact);
	}
	return [...byKey.values()].sort((left, right) => left.seq - right.seq);
}

function parsePayload(event: ChatStreamEvent): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(event.payload_json);
		return recordFromUnknown(parsed);
	} catch {
		return undefined;
	}
}

function parseJsonRecord(value: string | undefined): Record<string, unknown> | undefined {
	if (!value) return undefined;
	try {
		return recordFromUnknown(JSON.parse(value));
	} catch {
		return undefined;
	}
}

function recordFromUnknown(value: unknown): Record<string, unknown> | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = record?.[key];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
	const value = record?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizePageUrl(url: string | undefined): string | undefined {
	const trimmed = stripTrailingPunctuation(url?.trim() ?? "");
	if (!trimmed || !trimmed.includes("/ui/") || trimmed.includes("/ui/login") || trimmed.includes("magic=")) {
		return undefined;
	}
	return trimmed;
}

function normalizePagePath(path: string | undefined): string | undefined {
	const cleaned = path?.trim().replace(/^\/+/, "").replace(/^ui\//, "");
	if (!cleaned || cleaned.includes("..") || cleaned.includes("\0") || cleaned.startsWith("login")) {
		return undefined;
	}
	return cleaned;
}

function urlFromText(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const match = text.match(/https?:\/\/[^\s"']+\/ui\/[^\s"']+|\/ui\/[^\s"']+/);
	return normalizePageUrl(match?.[0]);
}

function stripTrailingPunctuation(value: string): string {
	return value.replace(/[),.;]+$/g, "");
}

function truncate(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, maxLength - 3)}...`;
}
