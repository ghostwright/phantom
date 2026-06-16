/**
 * Shared helpers for identifying and normalising page-tool artifacts
 * (phantom_create_page / phantom_preview_page). Used by both
 * run-timeline.ts and continuity-context.ts.
 */

import { isRecord } from "../shared/strings.ts";

export const PAGE_TOOL_NAMES = ["phantom_create_page", "phantom_preview_page"] as const;
export type PageToolName = (typeof PAGE_TOOL_NAMES)[number];

export function normalizePageToolName(toolName: string | undefined): PageToolName | undefined {
	if (!toolName) return undefined;
	for (const pageToolName of PAGE_TOOL_NAMES) {
		if (toolName === pageToolName || toolName.endsWith(`__${pageToolName}`) || toolName.endsWith(`:${pageToolName}`)) {
			return pageToolName;
		}
	}
	return undefined;
}

export function normalizePageUrl(value: string | undefined): string | undefined {
	const trimmed = stripTrailingPunctuation(value?.trim() ?? "");
	if (!trimmed || !trimmed.includes("/ui/") || trimmed.includes("/ui/login") || trimmed.includes("magic=")) {
		return undefined;
	}
	if (hasSensitiveQuery(trimmed)) return undefined;
	return trimmed;
}

export function normalizePagePath(value: string | undefined): string | undefined {
	const cleaned = value?.trim().replace(/^\/+/, "").replace(/^ui\//, "");
	if (!cleaned || cleaned.includes("..") || cleaned.includes("\0") || cleaned.startsWith("login")) {
		return undefined;
	}
	return cleaned;
}

export function urlFromPath(path: string | undefined): string | undefined {
	return path ? `/ui/${path}` : undefined;
}

export function urlFromText(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const match = value.match(/(?:https?:\/\/[^\s"']*\/ui\/[^\s"']+|\/ui\/[^\s"']+)/);
	return normalizePageUrl(match?.[0]);
}

export function stripTrailingPunctuation(value: string): string {
	return value.replace(/[),.;]+$/g, "");
}

export function hasSensitiveQuery(value: string): boolean {
	return /[?&](?:api[_-]?key|token|secret|password|access_token|code|magic)=/i.test(value);
}

export function parseJsonRecord(value: string | undefined): Record<string, unknown> | undefined {
	if (!value) return undefined;
	try {
		const parsed: unknown = JSON.parse(value);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = record?.[key];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
	const value = record?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
