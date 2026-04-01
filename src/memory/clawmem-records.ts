import type { Episode, Procedure, SemanticFact } from "./types.ts";

type MemoryRecordKind = "episode" | "fact" | "procedure";

type MemoryRecordEnvelope =
	| { kind: "episode"; record: Episode }
	| { kind: "fact"; record: SemanticFact }
	| { kind: "procedure"; record: Procedure };

export type SerializedMemoryDocument = {
	path: string;
	title: string;
	body: string;
	embeddingText: string;
	contentType: "progress" | "decision" | "project";
	confidence: number;
	qualityScore: number;
	semanticPayload: string;
	topicKey: string;
};

const ENVELOPE_PREFIX = "PHANTOM_MEMORY:";

export function episodeDocumentPath(id: string): string {
	return `${id}.md`;
}

export function factDocumentPath(id: string): string {
	return `${id}.md`;
}

export function procedureDocumentPath(id: string): string {
	return `${id}.md`;
}

export function serializeEpisode(episode: Episode): SerializedMemoryDocument {
	const lines = [
		`Type: ${episode.type}`,
		`Summary: ${episode.summary}`,
		`Detail: ${episode.detail}`,
		`Outcome: ${episode.outcome}`,
		`Outcome Detail: ${episode.outcome_detail}`,
		`Session: ${episode.session_id}`,
		`User: ${episode.user_id}`,
		`Started: ${episode.started_at}`,
		`Ended: ${episode.ended_at}`,
		`Duration Seconds: ${episode.duration_seconds}`,
		episode.tools_used.length > 0 ? `Tools Used: ${episode.tools_used.join(", ")}` : "",
		episode.files_touched.length > 0 ? `Files Touched: ${episode.files_touched.join(", ")}` : "",
		episode.lessons.length > 0 ? `Lessons: ${episode.lessons.join(" | ")}` : "",
	]
		.filter(Boolean)
		.join("\n");

	return {
		path: episodeDocumentPath(episode.id),
		title: compactTitle(episode.summary, `${episode.type} episode`),
		body: buildBody("episode", episode, lines),
		embeddingText: lines,
		contentType: "progress",
		confidence: clampScore(episode.importance),
		qualityScore: clampScore((episode.importance + 0.5) / 1.5),
		semanticPayload: stableJson({
			id: episode.id,
			summary: episode.summary,
			detail: episode.detail,
			outcome: episode.outcome,
			session_id: episode.session_id,
			user_id: episode.user_id,
			started_at: episode.started_at,
			ended_at: episode.ended_at,
		}),
		topicKey: episode.session_id,
	};
}

export function serializeFact(fact: SemanticFact): SerializedMemoryDocument {
	const lines = [
		`Natural Language: ${fact.natural_language}`,
		`Subject: ${fact.subject}`,
		`Predicate: ${fact.predicate}`,
		`Object: ${fact.object}`,
		`Category: ${fact.category}`,
		`Confidence: ${fact.confidence}`,
		`Valid From: ${fact.valid_from}`,
		`Valid Until: ${fact.valid_until ?? "active"}`,
		fact.tags.length > 0 ? `Tags: ${fact.tags.join(", ")}` : "",
	]
		.filter(Boolean)
		.join("\n");

	return {
		path: factDocumentPath(fact.id),
		title: compactTitle(fact.natural_language, `${fact.subject} ${fact.predicate} ${fact.object}`),
		body: buildBody("fact", fact, lines),
		embeddingText: lines,
		contentType: "decision",
		confidence: clampScore(fact.confidence),
		qualityScore: clampScore(fact.confidence),
		semanticPayload: stableJson({
			subject: fact.subject,
			predicate: fact.predicate,
			object: fact.object,
			category: fact.category,
			confidence: fact.confidence,
			valid_from: fact.valid_from,
			valid_until: fact.valid_until,
			version: fact.version,
			tags: fact.tags,
		}),
		topicKey: `${fact.subject}:${fact.predicate}`,
	};
}

export function serializeProcedure(procedure: Procedure): SerializedMemoryDocument {
	const steps = procedure.steps
		.map((step) => `${step.order}. ${step.action} -> ${step.expected_outcome}`)
		.join("\n");
	const lines = [
		`Name: ${procedure.name}`,
		`Description: ${procedure.description}`,
		`Trigger: ${procedure.trigger}`,
		steps ? `Steps:\n${steps}` : "",
		procedure.preconditions.length > 0 ? `Preconditions: ${procedure.preconditions.join(" | ")}` : "",
		procedure.postconditions.length > 0 ? `Postconditions: ${procedure.postconditions.join(" | ")}` : "",
		`Success Count: ${procedure.success_count}`,
		`Failure Count: ${procedure.failure_count}`,
		`Last Used At: ${procedure.last_used_at}`,
		`Confidence: ${procedure.confidence}`,
	]
		.filter(Boolean)
		.join("\n");
	const totalRuns = procedure.success_count + procedure.failure_count;
	const successRate = totalRuns === 0 ? 0.5 : procedure.success_count / totalRuns;

	return {
		path: procedureDocumentPath(procedure.id),
		title: compactTitle(procedure.name, "procedure"),
		body: buildBody("procedure", procedure, lines),
		embeddingText: lines,
		contentType: "project",
		confidence: clampScore(procedure.confidence),
		qualityScore: clampScore((successRate + procedure.confidence) / 2),
		semanticPayload: stableJson({
			name: procedure.name,
			description: procedure.description,
			trigger: procedure.trigger,
			steps: procedure.steps,
			preconditions: procedure.preconditions,
			postconditions: procedure.postconditions,
			parameters: procedure.parameters,
			success_count: procedure.success_count,
			failure_count: procedure.failure_count,
			last_used_at: procedure.last_used_at,
			confidence: procedure.confidence,
			version: procedure.version,
		}),
		topicKey: procedure.name,
	};
}

export function parseEpisodeDocument(body: string): Episode | null {
	return parseEnvelope(body, "episode");
}

export function parseFactDocument(body: string): SemanticFact | null {
	return parseEnvelope(body, "fact");
}

export function parseProcedureDocument(body: string): Procedure | null {
	return parseEnvelope(body, "procedure");
}

function buildBody(kind: MemoryRecordKind, record: Episode | SemanticFact | Procedure, text: string): string {
	return `${ENVELOPE_PREFIX}${JSON.stringify({ kind, record })}\n\n${text}\n`;
}

function parseEnvelope<T extends Episode | SemanticFact | Procedure>(
	body: string,
	expectedKind: MemoryRecordKind,
): T | null {
	const firstLine = body.split("\n", 1)[0]?.trim();
	if (!firstLine?.startsWith(ENVELOPE_PREFIX)) return null;

	const payload = firstLine.slice(ENVELOPE_PREFIX.length);
	try {
		const parsed = JSON.parse(payload) as MemoryRecordEnvelope;
		return parsed.kind === expectedKind ? (parsed.record as T) : null;
	} catch {
		return null;
	}
}

function compactTitle(primary: string, fallback: string): string {
	const value = primary.trim() || fallback;
	return value.length <= 120 ? value : `${value.slice(0, 117)}...`;
}

function clampScore(value: number): number {
	if (!Number.isFinite(value)) return 0.5;
	return Math.min(Math.max(value, 0), 1);
}

function stableJson(value: unknown): string {
	return JSON.stringify(value);
}
