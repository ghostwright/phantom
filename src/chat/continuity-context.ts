import { isRecord } from "../shared/strings.ts";
import { truncate } from "../shared/strings.ts";
import type { ChatEventLog, ChatStreamEvent } from "./event-log.ts";
import {
	normalizePagePath,
	normalizePageToolName,
	normalizePageUrl,
	numberField,
	parseJsonRecord,
	stringField,
	urlFromText,
} from "./page-tools.ts";
import type { ChatRunTimelineStore, DurableRunTimelineArtifactSummary } from "./run-timeline.ts";

const DEFAULT_EVENT_SCAN_LIMIT = 5000;
const MAX_ARTIFACTS = 8;
const MAX_COMPACTIONS = 3;
const MAX_LABEL_LENGTH = 90;

type BuildChatContinuityContextInput = {
	sessionId: string;
	eventLog: ChatEventLog;
	timelineStore?: ChatRunTimelineStore;
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
	seq?: number;
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

	const timelineArtifacts = artifactsFromTimeline(input.timelineStore, input.sessionId);
	const eventArtifacts = [...tools.values()].flatMap((tool) => artifactFromTool(tool) ?? []);
	const artifacts = dedupeArtifacts([...timelineArtifacts, ...eventArtifacts]);
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
			parts.push(` via ${artifact.toolName}${artifact.seq === undefined ? "" : ` at stream seq ${artifact.seq}`}.`);
			lines.push(parts.join(";"));
		}
	}

	return lines.join("\n");
}

function artifactFromTool(tool: ToolAccumulator): PageArtifact | undefined {
	const toolName = normalizePageToolName(tool.toolName);
	if (!toolName) return undefined;

	const input = isRecord(tool.input) ? tool.input : undefined;
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

function artifactsFromTimeline(timelineStore: ChatRunTimelineStore | undefined, sessionId: string): PageArtifact[] {
	if (!timelineStore) return [];
	return timelineStore
		.getDetailsBySession(sessionId)
		.flatMap((timeline) => timeline.summary.artifacts ?? [])
		.map(timelineArtifactFromSummary)
		.filter((artifact): artifact is PageArtifact => artifact !== undefined);
}

function timelineArtifactFromSummary(artifact: DurableRunTimelineArtifactSummary): PageArtifact | undefined {
	if (artifact.type !== "page") return undefined;
	const toolName = normalizePageToolName(artifact.sourceToolName);
	if (!toolName) return undefined;
	const path = normalizePagePath(artifact.path);
	const url = normalizePageUrl(artifact.url);
	if (!url && !path) return undefined;
	return {
		toolName,
		label: truncate(artifact.title, MAX_LABEL_LENGTH),
		...(url ? { url } : {}),
		...(path ? { path } : {}),
		...(artifact.sizeBytes !== undefined ? { size: artifact.sizeBytes } : {}),
	};
}

function dedupeArtifacts(artifacts: PageArtifact[]): PageArtifact[] {
	const byKey = new Map<string, PageArtifact>();
	for (const artifact of artifacts) {
		const key = artifact.url ?? artifact.path ?? `${artifact.toolName}:${artifact.seq}`;
		byKey.set(key, artifact);
	}
	return [...byKey.values()].sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0));
}

function parsePayload(event: ChatStreamEvent): Record<string, unknown> | undefined {
	return parseJsonRecord(event.payload_json);
}
