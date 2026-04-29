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
		// Check for contradictions before storing
		const contradictions = await this.findContradictions(fact);

		for (const existing of contradictions) {
			await this.resolveContradiction(fact, existing);
		}

		const factVec = await this.embedder.embed(fact.natural_language);
		const sparse = textToSparseVector(`${fact.subject} ${fact.predicate} ${fact.object} ${fact.natural_language}`);

		await this.qdrant.upsert(this.collectionName, [
			{
				id: fact.id,
				vector: {
					fact: factVec,
					text_bm25: sparse,
				},
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
					category: fact.category,
					tags: fact.tags,
				},
			},
		]);

		return fact.id;
	}

	async recall(query: string, options?: RecallOptions): Promise<SemanticFact[]> {
		const limit = options?.limit ?? 20;

		const queryVec = await this.embedder.embed(query);
		const sparse = textToSparseVector(query);

		// Default: only return currently-valid facts
		const filter = this.buildFilter(options);

		const results = await this.qdrant.search(this.collectionName, {
			denseVector: queryVec,
			denseVectorName: "fact",
			sparseVector: sparse,
			sparseVectorName: "text_bm25",
			filter,
			limit,
			withPayload: true,
		});

		const minScore = options?.minScore ?? 0;
		return results.filter((r) => r.score >= minScore).map((r) => this.payloadToFact(r));
	}

	async findContradictions(newFact: SemanticFact): Promise<SemanticFact[]> {
		// Search for facts with the same subject and predicate
		const queryText = `${newFact.subject} ${newFact.predicate}`;
		const queryVec = await this.embedder.embed(queryText);

		const results = await this.qdrant.search(this.collectionName, {
			denseVector: queryVec,
			denseVectorName: "fact",
			filter: {
				must: [{ key: "subject", match: { value: newFact.subject } }, { is_null: { key: "valid_until" } }],
			},
			limit: 10,
			withPayload: true,
		});

		return results
			.filter((r) => {
				if (r.id === newFact.id) return false;
				if (r.score < SIMILARITY_THRESHOLD) return false;
				const existingObject = r.payload.object as string;
				return existingObject !== newFact.object;
			})
			.map((r) => this.payloadToFact(r));
	}

	async resolveContradiction(newFact: SemanticFact, existingFact: SemanticFact): Promise<void> {
		// Newer fact with higher or equal confidence supersedes the old one
		if (newFact.confidence >= existingFact.confidence) {
			await this.qdrant.updatePayload(this.collectionName, existingFact.id, {
				valid_until: new Date(newFact.valid_from).getTime(),
			});
		}
	}

	private buildFilter(options?: RecallOptions): Record<string, unknown> | undefined {
		const must: Record<string, unknown>[] = [];

		// Default: only currently-valid facts
		if (!options?.timeRange) {
			must.push({ is_null: { key: "valid_until" } });
		}

		if (options?.timeRange) {
			must.push({
				key: "valid_from",
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

	async scroll(opts: {
		limit: number;
		offset?: string | number;
	}): Promise<{ items: SemanticFact[]; nextOffset: string | number | null }> {
		const { points, nextOffset } = await this.qdrant.scroll(this.collectionName, {
			limit: opts.limit,
			offset: opts.offset,
			orderBy: { key: "valid_from", direction: "desc" },
			withPayload: true,
		});
		return { items: points.map((p) => this.payloadToFact(p)), nextOffset };
	}

	async getById(id: string): Promise<SemanticFact | null> {
		const { points } = await this.qdrant.scroll(this.collectionName, {
			limit: 1,
			filter: { must: [{ has_id: [id] }] },
			withPayload: true,
		});
		if (points.length === 0) return null;
		return this.payloadToFact(points[0]);
	}

	async deleteById(id: string): Promise<void> {
		await this.qdrant.deletePoint(this.collectionName, id);
	}

	async count(): Promise<number> {
		return this.qdrant.countPoints(this.collectionName);
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
			category: (p.category as SemanticFact["category"]) ?? "domain_knowledge",
			tags: (p.tags as string[]) ?? [],
		};
	}
}
