import type { MemoryConfig } from "../config/types.ts";
import { type EmbeddingClient, textToSparseVector } from "./embeddings.ts";
import type { QdrantClient } from "./qdrant-client.ts";
import type { QdrantSearchResult, RecallOptions, SemanticFact } from "./types.ts";

const COLLECTION_SCHEMA = {
	vectors: {
		fact: { size: 768, distance: "Cosine" },
	},
	sparse_vectors: {
		text_bm25: {},
	},
} as const;

const PAYLOAD_INDEXES: { field: string; type: "keyword" | "integer" | "float" }[] = [
	{ field: "subject", type: "keyword" },
	{ field: "predicate", type: "keyword" },
	{ field: "category", type: "keyword" },
	{ field: "confidence", type: "float" },
	{ field: "valid_from", type: "integer" },
	{ field: "valid_until", type: "integer" },
	{ field: "version", type: "integer" },
	{ field: "tags", type: "keyword" },
];

const SIMILARITY_THRESHOLD = 0.85;
const CONTRADICTION_NOTE_LIMIT = 3;

export class SemanticStore {
	private qdrant: QdrantClient;
	private embedder: EmbeddingClient;
	private collectionName: string;

	constructor(qdrant: QdrantClient, embedder: EmbeddingClient, config: MemoryConfig) {
		this.qdrant = qdrant;
		this.embedder = embedder;
		this.collectionName = config.collections.semantic_facts;
	}

	async initialize(): Promise<void> {
		await this.qdrant.createCollection(this.collectionName, {
			vectors: { ...COLLECTION_SCHEMA.vectors },
			sparse_vectors: { ...COLLECTION_SCHEMA.sparse_vectors },
		});

		for (const index of PAYLOAD_INDEXES) {
			await this.qdrant.createPayloadIndex(this.collectionName, index.field, index.type);
		}
	}

	async store(fact: SemanticFact): Promise<string> {
		const candidates = await this.findCurrentCandidates(fact);
		const reinforcementTarget = candidates.find((candidate) => isSameFact(candidate, fact));
		if (reinforcementTarget) {
			return this.reinforceFact(reinforcementTarget, fact);
		}

		const contradictions = candidates.filter((candidate) => !isSameFact(candidate, fact));
		const strongerContradiction = contradictions.find((candidate) => candidate.confidence > fact.confidence);

		if (strongerContradiction) {
			const rejectedFact: SemanticFact = {
				...fact,
				valid_until: fact.valid_from,
				previous_version_id: strongerContradiction.id,
				superseded_by_fact_id: strongerContradiction.id,
			};
			await this.upsertFact(rejectedFact);
			return rejectedFact.id;
		}

		for (const existing of contradictions) {
			await this.resolveContradiction(fact, existing);
		}

		await this.upsertFact({
			...fact,
			previous_version_id: fact.previous_version_id ?? contradictions[0]?.id ?? null,
		});
		return fact.id;
	}

	async recall(query: string, options?: RecallOptions): Promise<SemanticFact[]> {
		const facts = await this.searchFacts(query, options);
		if ((options?.validity ?? "current") !== "current" || facts.length === 0) return facts;

		const superseded = await this.searchFacts(query, {
			...options,
			validity: "superseded",
			limit: Math.min(Math.max(options?.limit ?? 20, CONTRADICTION_NOTE_LIMIT), 10),
		});

		return this.attachContradictionNotes(facts, superseded);
	}

	async findContradictions(newFact: SemanticFact): Promise<SemanticFact[]> {
		const candidates = await this.findCurrentCandidates(newFact);
		return candidates.filter((candidate) => !isSameFact(candidate, newFact));
	}

	async resolveContradiction(newFact: SemanticFact, existingFact: SemanticFact): Promise<void> {
		// Newer fact with higher or equal confidence supersedes the old one
		if (newFact.confidence >= existingFact.confidence) {
			await this.qdrant.updatePayload(this.collectionName, existingFact.id, {
				valid_until: new Date(newFact.valid_from).getTime(),
				superseded_by_fact_id: newFact.id,
			});
		}
	}

	private buildFilter(options?: RecallOptions): Record<string, unknown> | undefined {
		const must: Record<string, unknown>[] = [];
		const validity = options?.validity ?? "current";

		if (validity === "current") {
			must.push({ is_null: { key: "valid_until" } });
		} else if (validity === "superseded") {
			must.push({ key: "valid_until", range: { gte: 0 } });
		}

		if (options?.timeRange) {
			must.push({
				key: validity === "superseded" ? "valid_until" : "valid_from",
				range: {
					gte: options.timeRange.from.getTime(),
					lte: options.timeRange.to.getTime(),
				},
			});
		}

		if (options?.filters) {
			for (const [key, value] of Object.entries(options.filters)) {
				if (Array.isArray(value)) {
					must.push({ key, match: { any: value } });
				} else {
					must.push({ key, match: { value } });
				}
			}
		}

		if (must.length === 0) return undefined;
		return { must };
	}

	private async findCurrentCandidates(fact: SemanticFact): Promise<SemanticFact[]> {
		const queryText = `${fact.subject} ${fact.predicate} ${fact.object}`;
		const queryVec = await this.embedder.embed(queryText);
		const results = await this.qdrant.search(this.collectionName, {
			denseVector: queryVec,
			denseVectorName: "fact",
			filter: {
				must: [
					{ key: "subject", match: { value: fact.subject } },
					{ key: "predicate", match: { value: fact.predicate } },
					{ is_null: { key: "valid_until" } },
				],
			},
			limit: 10,
			withPayload: true,
		});

		return results
			.filter((result) => result.id !== fact.id && result.score >= SIMILARITY_THRESHOLD)
			.map((result) => this.payloadToFact(result));
	}

	private async reinforceFact(existingFact: SemanticFact, newFact: SemanticFact): Promise<string> {
		const mergedFact: SemanticFact = {
			...existingFact,
			natural_language:
				newFact.natural_language.length >= existingFact.natural_language.length
					? newFact.natural_language
					: existingFact.natural_language,
			source_episode_ids: uniqueStrings([...existingFact.source_episode_ids, ...newFact.source_episode_ids]),
			confidence: Math.min(1, Math.max(existingFact.confidence, newFact.confidence) + 0.05),
			version: existingFact.version + 1,
			reinforcement_count: (existingFact.reinforcement_count ?? 0) + 1,
			last_reinforced_at: newFact.valid_from,
			tags: uniqueStrings([...existingFact.tags, ...newFact.tags]),
		};

		await this.upsertFact(mergedFact);
		return mergedFact.id;
	}

	private async searchFacts(query: string, options?: RecallOptions): Promise<SemanticFact[]> {
		const queryVec = await this.embedder.embed(query);
		const sparse = textToSparseVector(query);
		const results = await this.qdrant.search(this.collectionName, {
			denseVector: queryVec,
			denseVectorName: "fact",
			sparseVector: sparse,
			sparseVectorName: "text_bm25",
			filter: this.buildFilter(options),
			limit: options?.limit ?? 20,
			withPayload: true,
		});

		const minScore = options?.minScore ?? 0;
		return results.filter((result) => result.score >= minScore).map((result) => this.payloadToFact(result));
	}

	private attachContradictionNotes(currentFacts: SemanticFact[], supersededFacts: SemanticFact[]): SemanticFact[] {
		const notesByFactId = new Map<string, string[]>();

		for (const fact of supersededFacts) {
			if (!fact.superseded_by_fact_id) continue;
			const existing = notesByFactId.get(fact.superseded_by_fact_id) ?? [];
			if (existing.length < CONTRADICTION_NOTE_LIMIT) {
				existing.push(fact.natural_language);
				notesByFactId.set(fact.superseded_by_fact_id, existing);
			}
		}

		return currentFacts.map((fact) => ({
			...fact,
			contradiction_note: notesByFactId.get(fact.id)?.join(" | ") ?? null,
		}));
	}

	private async upsertFact(fact: SemanticFact): Promise<void> {
		const factVec = await this.embedder.embed(fact.natural_language);
		const sparse = textToSparseVector(`${fact.subject} ${fact.predicate} ${fact.object} ${fact.natural_language}`);

		await this.qdrant.upsert(this.collectionName, [
			{
				id: fact.id,
				vector: { fact: factVec, text_bm25: sparse },
				payload: {
					subject: fact.subject,
					predicate: fact.predicate,
					object: fact.object,
					natural_language: fact.natural_language,
					source_episode_ids: fact.source_episode_ids,
					confidence: fact.confidence,
					valid_from: new Date(fact.valid_from).getTime(),
					valid_until: fact.valid_until ? new Date(fact.valid_until).getTime() : null,
					version: fact.version,
					previous_version_id: fact.previous_version_id,
					reinforcement_count: fact.reinforcement_count ?? 0,
					last_reinforced_at: fact.last_reinforced_at ? new Date(fact.last_reinforced_at).getTime() : null,
					superseded_by_fact_id: fact.superseded_by_fact_id ?? null,
					category: fact.category,
					tags: fact.tags,
				},
			},
		]);
	}

	private payloadToFact(result: QdrantSearchResult): SemanticFact {
		const p = result.payload;
		return {
			id: result.id,
			subject: (p.subject as string) ?? "",
			predicate: (p.predicate as string) ?? "",
			object: (p.object as string) ?? "",
			natural_language: (p.natural_language as string) ?? "",
			source_episode_ids: (p.source_episode_ids as string[]) ?? [],
			confidence: (p.confidence as number) ?? 0.5,
			valid_from: p.valid_from ? new Date(p.valid_from as number).toISOString() : "",
			valid_until: p.valid_until ? new Date(p.valid_until as number).toISOString() : null,
			version: (p.version as number) ?? 1,
			previous_version_id: (p.previous_version_id as string | null) ?? null,
			reinforcement_count: (p.reinforcement_count as number) ?? 0,
			last_reinforced_at: p.last_reinforced_at ? new Date(p.last_reinforced_at as number).toISOString() : null,
			superseded_by_fact_id: (p.superseded_by_fact_id as string | null) ?? null,
			category: (p.category as SemanticFact["category"]) ?? "domain_knowledge",
			tags: (p.tags as string[]) ?? [],
		};
	}
}

function isSameFact(existingFact: SemanticFact, newFact: SemanticFact): boolean {
	return normalizeFactValue(existingFact.object) === normalizeFactValue(newFact.object);
}

function normalizeFactValue(value: string): string {
	return value.trim().toLowerCase();
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values)];
}
