import type { ChatArtifactView, ToolCallState } from "./chat-types";

const PAGE_TOOL_NAMES = new Set(["phantom_create_page", "phantom_preview_page"]);
const MAX_TITLE_LENGTH = 90;

export function extractToolArtifacts(toolCalls: ToolCallState[]): ChatArtifactView[] {
	const artifacts = toolCalls
		.map(pageArtifactFromTool)
		.filter((artifact): artifact is ChatArtifactView => artifact !== null);
	const byKey = new Map<string, ChatArtifactView>();
	for (const artifact of artifacts) {
		const key = artifact.url || artifact.path || artifact.id;
		byKey.set(key, artifact);
	}
	return [...byKey.values()];
}

export function mergeArtifactViews(...groups: ChatArtifactView[][]): ChatArtifactView[] {
	const byKey = new Map<string, ChatArtifactView>();
	for (const group of groups) {
		for (const artifact of group) {
			const key = artifact.url || artifact.path || artifact.id;
			byKey.set(key, artifact);
		}
	}
	return [...byKey.values()];
}

export function formatArtifactSize(sizeBytes: number | undefined): string | null {
	if (sizeBytes === undefined) return null;
	if (sizeBytes < 1024) return `${sizeBytes} B`;
	const kib = sizeBytes / 1024;
	if (kib < 1024) return `${formatNumber(kib)} KB`;
	return `${formatNumber(kib / 1024)} MB`;
}

function pageArtifactFromTool(tool: ToolCallState): ChatArtifactView | null {
	const sourceToolName = normalizePageToolName(tool.toolName);
	if (!sourceToolName || tool.state !== "result") return null;

	const input = recordFromUnknown(tool.input) ?? parseJsonRecord(tool.inputJson);
	const output = parseJsonRecord(tool.output);
	const path = normalizePagePath(stringField(output, "path") ?? stringField(input, "path"));
	const url =
		normalizePageUrl(
			stringField(output, "url") ??
				stringField(output, "publicUrl") ??
				stringField(output, "pageUrl") ??
				urlFromText(tool.output),
		) ?? urlFromPath(path);
	if (!url) return null;

	const title = truncate(
		stringField(input, "title") ?? stringField(output, "title") ?? path ?? "Created page",
		MAX_TITLE_LENGTH,
	);
	const sizeBytes = numberField(output, "size");
	return {
		id: `page:${url}`,
		type: "page",
		title,
		url,
		sourceToolName,
		...(path ? { path } : {}),
		...(sizeBytes !== undefined ? { sizeBytes } : {}),
	};
}

function normalizePageToolName(toolName: string): string | null {
	for (const pageToolName of PAGE_TOOL_NAMES) {
		if (toolName === pageToolName || toolName.endsWith(`__${pageToolName}`) || toolName.endsWith(`:${pageToolName}`)) {
			return pageToolName;
		}
	}
	return null;
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function parseJsonRecord(value: string | undefined): Record<string, unknown> | null {
	if (!value) return null;
	try {
		return recordFromUnknown(JSON.parse(value));
	} catch {
		return null;
	}
}

function stringField(record: Record<string, unknown> | null, key: string): string | undefined {
	const value = record?.[key];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function numberField(record: Record<string, unknown> | null, key: string): number | undefined {
	const value = record?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizePageUrl(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const trimmed = stripTrailingPunctuation(value.trim());
	if (!trimmed.includes("/ui/")) return undefined;
	if (trimmed.includes("/ui/login") || trimmed.includes("magic=")) return undefined;
	return trimmed;
}

function normalizePagePath(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const cleaned = value.trim().replace(/^\/+/, "").replace(/^ui\//, "");
	if (!cleaned || cleaned.includes("..") || cleaned.includes("\0") || cleaned.startsWith("login")) return undefined;
	return cleaned;
}

function urlFromPath(path: string | undefined): string | undefined {
	return path ? `/ui/${path}` : undefined;
}

function urlFromText(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const match = value.match(/(?:https?:\/\/[^\s"']*\/ui\/[^\s"']+|\/ui\/[^\s"']+)/);
	return normalizePageUrl(match?.[0]);
}

function stripTrailingPunctuation(value: string): string {
	return value.replace(/[),.;]+$/g, "");
}

function truncate(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, maxLength - 3)}...`;
}

function formatNumber(value: number): string {
	return value < 10 ? value.toFixed(1) : Math.round(value).toString();
}
