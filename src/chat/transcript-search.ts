import type { Database } from "bun:sqlite";
import { redactSensitiveText } from "./redaction.ts";

export type ChatTranscriptRole = "user" | "assistant" | "all";

export type ChatTranscriptSearchOptions = {
	sessionId: string;
	query?: string;
	role?: ChatTranscriptRole;
	afterSeq?: number;
	beforeSeq?: number;
	limit?: number;
};

export type ChatTranscriptEntry = {
	id: string;
	session_id: string;
	seq: number;
	role: "user" | "assistant";
	created_at: string;
	status: string;
	citation: string;
	snippet: string;
	attachments?: Array<{
		filename: string;
		mime_type: string;
		size_bytes: number | null;
	}>;
};

export type ChatTranscriptSearchResult = {
	session_id: string;
	query: string | null;
	role: ChatTranscriptRole;
	limit: number;
	count: number;
	results: ChatTranscriptEntry[];
};

type ChatMessageRow = {
	id: string;
	seq: number;
	role: string;
	content_json: string;
	created_at: string;
	status: string;
};

type ExtractedTranscriptContent = {
	text: string;
	attachments: ChatTranscriptEntry["attachments"];
};

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MAX_SCAN_ROWS = 2000;
const SNIPPET_RADIUS = 260;
const MAX_SNIPPET_LENGTH = 700;

export function searchChatTranscript(db: Database, options: ChatTranscriptSearchOptions): ChatTranscriptSearchResult {
	const limit = clampLimit(options.limit);
	const role = options.role ?? "all";
	const query = normalizeWhitespace(options.query ?? "");
	const rows = loadCandidateRows(db, { ...options, role }, query ? MAX_SCAN_ROWS : limit);
	const queryTokens = queryTokensFor(query);
	const results: ChatTranscriptEntry[] = [];

	for (const row of rows) {
		if (row.role !== "user" && row.role !== "assistant") continue;
		const extracted = extractTranscriptContent(row.content_json);
		const redactedText = redactSensitiveText(extracted.text);
		if (queryTokens.length > 0 && !matchesQuery(redactedText, query, queryTokens)) {
			continue;
		}
		const snippet = buildSnippet(redactedText, query, queryTokens);
		results.push({
			id: row.id,
			session_id: options.sessionId,
			seq: row.seq,
			role: row.role,
			created_at: row.created_at,
			status: row.status,
			citation: `chat:${options.sessionId}#msg:${row.seq}`,
			snippet,
			...(extracted.attachments && extracted.attachments.length > 0 ? { attachments: extracted.attachments } : {}),
		});
		if (results.length >= limit) break;
	}

	return {
		session_id: options.sessionId,
		query: query || null,
		role,
		limit,
		count: results.length,
		results,
	};
}

function loadCandidateRows(
	db: Database,
	options: ChatTranscriptSearchOptions & { role: ChatTranscriptRole },
	limit: number,
): ChatMessageRow[] {
	const clauses = ["session_id = ?"];
	const params: Array<string | number> = [options.sessionId];
	clauses.push(
		"EXISTS (SELECT 1 FROM chat_sessions WHERE chat_sessions.id = chat_messages.session_id AND chat_sessions.deleted_at IS NULL AND chat_sessions.status != 'deleted')",
	);

	if (options.role !== "all") {
		clauses.push("role = ?");
		params.push(options.role);
	} else {
		clauses.push("role IN ('user', 'assistant')");
	}
	if (options.afterSeq !== undefined) {
		clauses.push("seq > ?");
		params.push(options.afterSeq);
	}
	if (options.beforeSeq !== undefined) {
		clauses.push("seq < ?");
		params.push(options.beforeSeq);
	}

	params.push(limit);
	return db
		.query(
			`SELECT id, seq, role, content_json, created_at, status
			 FROM chat_messages
			 WHERE ${clauses.join(" AND ")}
			 ORDER BY seq DESC
			 LIMIT ?`,
		)
		.all(...params) as ChatMessageRow[];
}

function clampLimit(limit: number | undefined): number {
	if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_LIMIT;
	return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

function queryTokensFor(query: string): string[] {
	if (!query) return [];
	return query
		.toLowerCase()
		.split(/\s+/)
		.map((token) => token.trim())
		.filter((token) => token.length > 0)
		.slice(0, 12);
}

function matchesQuery(text: string, query: string, tokens: string[]): boolean {
	const normalizedText = text.toLowerCase();
	if (query && normalizedText.includes(query.toLowerCase())) return true;
	return tokens.every((token) => normalizedText.includes(token));
}

function buildSnippet(text: string, query: string, tokens: string[]): string {
	const normalized = normalizeWhitespace(text);
	if (!normalized) return "";

	const lower = normalized.toLowerCase();
	const queryLower = query.toLowerCase();
	let index = queryLower ? lower.indexOf(queryLower) : -1;
	if (index < 0) {
		index =
			tokens
				.map((token) => lower.indexOf(token))
				.filter((candidate) => candidate >= 0)
				.sort((a, b) => a - b)[0] ?? 0;
	}

	const start = Math.max(0, index - SNIPPET_RADIUS);
	const end = Math.min(normalized.length, Math.max(index + SNIPPET_RADIUS, start + MAX_SNIPPET_LENGTH));
	const snippet = `${start > 0 ? "... " : ""}${normalized.slice(start, end)}${end < normalized.length ? " ..." : ""}`;
	return snippet.length > MAX_SNIPPET_LENGTH ? `${snippet.slice(0, MAX_SNIPPET_LENGTH - 4)} ...` : snippet;
}

function extractTranscriptContent(contentJson: string): ExtractedTranscriptContent {
	let parsed: unknown;
	try {
		parsed = JSON.parse(contentJson);
	} catch {
		return { text: contentJson, attachments: [] };
	}
	return extractUnknownContent(parsed);
}

function extractUnknownContent(value: unknown): ExtractedTranscriptContent {
	if (typeof value === "string") {
		return { text: value, attachments: [] };
	}
	if (Array.isArray(value)) {
		const texts: string[] = [];
		const attachments: NonNullable<ChatTranscriptEntry["attachments"]> = [];
		for (const item of value) {
			const extracted = extractUnknownContent(item);
			if (extracted.text) texts.push(extracted.text);
			if (extracted.attachments) attachments.push(...extracted.attachments);
		}
		return { text: texts.join("\n"), attachments };
	}
	if (!isRecord(value)) {
		return { text: value === null || value === undefined ? "" : String(value), attachments: [] };
	}

	if (value.type === "attachment") {
		const attachment = attachmentSummary(value);
		const text = attachment ? `[attachment: ${attachment.filename} ${attachment.mime_type}]` : "[attachment]";
		return { text, attachments: attachment ? [attachment] : [] };
	}
	if (value.type === "text" && typeof value.text === "string") {
		return { text: value.text, attachments: [] };
	}
	if (typeof value.text === "string") {
		return { text: value.text, attachments: [] };
	}
	if (typeof value.content === "string") {
		return { text: value.content, attachments: [] };
	}
	return { text: "[structured content omitted]", attachments: [] };
}

function attachmentSummary(
	record: Record<string, unknown>,
): NonNullable<ChatTranscriptEntry["attachments"]>[number] | null {
	const filename = stringField(record, "filename") ?? "file";
	const mimeType = stringField(record, "mime_type") ?? stringField(record, "mimeType") ?? "application/octet-stream";
	const sizeValue = record.size_bytes ?? record.sizeBytes;
	const sizeBytes = typeof sizeValue === "number" && Number.isFinite(sizeValue) ? sizeValue : null;
	return {
		filename: redactSensitiveText(filename),
		mime_type: redactSensitiveText(mimeType),
		size_bytes: sizeBytes,
	};
}

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
