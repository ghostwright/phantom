import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { MemoryConfig } from "../config/types.ts";
import { calculateEpisodeRecallScore } from "./ranking.ts";
import {
	episodeDocumentPath,
	factDocumentPath,
	parseEpisodeDocument,
	parseFactDocument,
	parseProcedureDocument,
	procedureDocumentPath,
	serializeEpisode,
	serializeFact,
	serializeProcedure,
	type SerializedMemoryDocument,
} from "./clawmem-records.ts";
import {
	createClawMemStore,
	loadClawMemLlmModule,
	loadClawMemMemoryModule,
	loadClawMemSearchUtilsModule,
	type ClawMemScoredResult as ScoredResult,
	type ClawMemSearchResult as SearchResult,
	type ClawMemStore as Store,
} from "./clawmem-runtime.ts";
import type { ConsolidationResult, Episode, MemoryHealth, Procedure, RecallOptions, SemanticFact } from "./types.ts";

export class MemorySystem {
	private readonly configured = true;
	private readonly storePath: string;
	private store: Store | null = null;
	private initialized = false;

	constructor(private readonly config: MemoryConfig) {
		this.storePath = resolve(process.cwd(), config.clawmem.store_path);
	}

	async initialize(): Promise<void> {
		try {
			mkdirSync(dirname(this.storePath), { recursive: true });
			if (!process.env.CLAWMEM_EMBED_MODEL) {
				process.env.CLAWMEM_EMBED_MODEL = this.config.clawmem.embed_model;
			}
			this.store = await createClawMemStore(this.storePath, {
				busyTimeout: this.config.clawmem.busy_timeout_ms,
			});
			this.initialized = true;
			console.log(`[memory] ClawMem initialized at ${this.store.dbPath}.`);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			this.store = null;
			this.initialized = false;
			console.error(`[memory] Failed to initialize ClawMem: ${msg}`);
		}
	}

	async close(): Promise<void> {
		this.store?.close();
		this.store = null;
		this.initialized = false;
	}

	isReady(): boolean {
		return this.initialized && this.store !== null;
	}

	async healthCheck(): Promise<MemoryHealth> {
		try {
			if (this.store) {
				this.store.getStatus();
				return { clawmem: true, configured: this.configured };
			}

			const probe = await createClawMemStore(this.storePath, {
				busyTimeout: this.config.clawmem.busy_timeout_ms,
			});
			probe.getStatus();
			probe.close();
			return { clawmem: true, configured: this.configured };
		} catch {
			return { clawmem: false, configured: this.configured };
		}
	}

	async storeEpisode(episode: Episode): Promise<string> {
		if (!this.initialized) return episode.id;
		await this.persistDocument(this.config.collections.episodes, serializeEpisode(episode));
		return this.readEpisode(episode.id)?.id ?? episode.id;
	}

	async recallEpisodes(query: string, options?: RecallOptions): Promise<Episode[]> {
		if (!this.initialized) return [];
		const limit = options?.limit ?? 10;
		const matches = await this.searchCollection(query, [this.config.collections.episodes], options, parseEpisodeDocument, limit * 3);

		return matches
			.map(({ record, result }) => ({
				record,
				score: calculateEpisodeRecallScore(
					result.compositeScore,
					{
						importance: record.importance,
						accessCount: record.access_count,
						startedAt: record.started_at,
						lastAccessedAt: record.last_accessed_at,
						decayRate: record.decay_rate,
					},
					options?.strategy,
				),
			}))
			.filter((entry) => options?.minScore == null || entry.score >= options.minScore)
			.sort((a, b) => b.score - a.score)
			.slice(0, limit)
			.map((entry) => entry.record);
	}

	async storeFact(fact: SemanticFact): Promise<string> {
		if (!this.initialized) return fact.id;
		const contradictions = await this.findContradictions(fact);
		for (const existing of contradictions) {
			await this.resolveContradiction(fact, existing);
		}
		await this.persistDocument(this.config.collections.semantic_facts, serializeFact(fact));
		return this.readFact(fact.id)?.id ?? fact.id;
	}

	async recallFacts(query: string, options?: RecallOptions): Promise<SemanticFact[]> {
		if (!this.initialized) return [];
		const limit = options?.limit ?? 20;
		const matches = await this.searchCollection(
			query,
			[this.config.collections.semantic_facts],
			options,
			parseFactDocument,
			limit * 3,
		);

		return matches
			.map(({ record, result }) => ({ record, score: result.compositeScore }))
			.filter(({ record, score }) => {
				if (options?.timeRange) {
					const validFrom = Date.parse(record.valid_from);
					if (Number.isFinite(validFrom)) {
						if (validFrom < options.timeRange.from.getTime() || validFrom > options.timeRange.to.getTime()) {
							return false;
						}
					}
				} else if (record.valid_until) {
					return false;
				}

				return matchesFilters(record, options?.filters) && (options?.minScore == null || score >= options.minScore);
			})
			.sort((a, b) => b.score - a.score)
			.slice(0, limit)
			.map((entry) => entry.record);
	}

	async findContradictions(fact: SemanticFact): Promise<SemanticFact[]> {
		if (!this.initialized) return [];
		const facts = await this.recallFacts(`${fact.subject} ${fact.predicate}`, {
			limit: 10,
			filters: { subject: fact.subject },
		});

		return facts.filter((existing) => {
			if (existing.id === fact.id) return false;
			if (existing.valid_until) return false;
			return existing.subject === fact.subject && existing.predicate === fact.predicate && existing.object !== fact.object;
		});
	}

	async resolveContradiction(newFact: SemanticFact, existingFact: SemanticFact): Promise<void> {
		if (!this.initialized) return;
		if (newFact.confidence < existingFact.confidence) return;

		const current = this.readFact(existingFact.id);
		if (!current) return;

		await this.persistDocument(this.config.collections.semantic_facts, serializeFact({
			...current,
			valid_until: newFact.valid_from,
		}));
	}

	async storeProcedure(procedure: Procedure): Promise<string> {
		if (!this.initialized) return procedure.id;
		await this.persistDocument(this.config.collections.procedures, serializeProcedure(procedure));
		return this.readProcedure(procedure.id)?.id ?? procedure.id;
	}

	async findProcedure(taskDescription: string): Promise<Procedure | null> {
		if (!this.initialized) return null;
		const [bestMatch] = await this.searchCollection(
			taskDescription,
			[this.config.collections.procedures],
			{ limit: 5 },
			parseProcedureDocument,
			5,
		);

		if (!bestMatch || bestMatch.result.compositeScore < 0.2) {
			return null;
		}

		return bestMatch.record;
	}

	async updateProcedureOutcome(id: string, success: boolean): Promise<void> {
		if (!this.initialized) return;
		const procedure = this.readProcedure(id);
		if (!procedure) return;

		await this.persistDocument(this.config.collections.procedures, serializeProcedure({
			...procedure,
			success_count: procedure.success_count + (success ? 1 : 0),
			failure_count: procedure.failure_count + (success ? 0 : 1),
			last_used_at: new Date().toISOString(),
		}));
	}

	async consolidateSession(_sessionId: string): Promise<ConsolidationResult> {
		return { episodesCreated: 0, factsExtracted: 0, proceduresDetected: 0, durationMs: 0 };
	}

	private async persistDocument(collection: string, document: SerializedMemoryDocument): Promise<void> {
		const store = this.requireStore();
		const result = store.saveMemory({
			collection,
			path: document.path,
			title: document.title,
			body: document.body,
			contentType: document.contentType,
			confidence: document.confidence,
			qualityScore: document.qualityScore,
			semanticPayload: document.semanticPayload,
			topicKey: document.topicKey,
		});

		if (result.action === "deduplicated") {
			return;
		}

		await this.indexDocument(collection, document);
	}

	private async indexDocument(collection: string, document: SerializedMemoryDocument): Promise<void> {
		const store = this.requireStore();
		const current = this.readStoredDocument(collection, document.path);
		if (!current) return;

		const llmModule = await loadClawMemLlmModule();
		const llm = llmModule.getDefaultLlamaCpp();
		const embedding = await llm.embed(llmModule.formatDocForEmbedding(document.embeddingText, document.title), {
			model: this.config.clawmem.embed_model,
		});
		if (!embedding?.embedding || embedding.embedding.length === 0) {
			return;
		}

		store.ensureVecTable(embedding.embedding.length);
		store.insertEmbedding(
			current.hash,
			0,
			0,
			new Float32Array(embedding.embedding),
			embedding.model,
			new Date().toISOString(),
			"document",
			document.title,
		);
	}

	private async searchCollection<T>(
		query: string,
		collections: string[],
		options: RecallOptions | undefined,
		parse: (body: string) => T | null,
		candidateLimit: number,
	): Promise<Array<{ record: T; result: ScoredResult }>> {
		const results = await this.hybridSearch(query, collections, candidateLimit, options?.timeRange);
		const matches: Array<{ record: T; result: ScoredResult }> = [];

		for (const result of results) {
			const record = parse(result.body ?? "");
			if (!record) continue;
			if (!matchesFilters(record, options?.filters)) continue;
			matches.push({ record, result });
		}

		return dedupeByJson(matches).slice(0, candidateLimit);
	}

	private async hybridSearch(
		query: string,
		collections: string[],
		limit: number,
		timeRange?: { from: Date; to: Date },
	): Promise<ScoredResult[]> {
		const store = this.requireStore();
		const [{ enrichResults, reciprocalRankFusion, toRanked }, { applyCompositeScoring }] = await Promise.all([
			loadClawMemSearchUtilsModule(),
			loadClawMemMemoryModule(),
		]);
		const dateRange = timeRange
			? {
					start: timeRange.from.toISOString(),
					end: timeRange.to.toISOString(),
				}
			: undefined;
		const searchLimit = Math.max(limit, 1);
		const ftsResults = store.searchFTS(query, searchLimit * 3, undefined, collections, dateRange);
		let vecResults: SearchResult[] = [];

		try {
			vecResults = await store.searchVec(query, this.config.clawmem.embed_model, searchLimit * 3, undefined, collections, dateRange);
		} catch {
			vecResults = [];
		}

		if (ftsResults.length === 0 && vecResults.length === 0) {
			return [];
		}

		const rankedLists = [ftsResults.map(toRanked)];
		const weights = [1];
		if (vecResults.length > 0) {
			rankedLists.push(vecResults.map(toRanked));
			weights.push(1.15);
		}

		const fused = reciprocalRankFusion(rankedLists, weights);
		const rawByFile = new Map<string, SearchResult>();
		for (const result of [...ftsResults, ...vecResults]) {
			const current = rawByFile.get(result.filepath);
			if (!current || result.score > current.score) {
				rawByFile.set(result.filepath, result);
			}
		}

		const fusedResults = fused
			.map((result) => {
				const raw = rawByFile.get(result.file);
				return raw ? { ...raw, score: result.score } : null;
			})
			.filter((result): result is SearchResult => result !== null);

		const scored = applyCompositeScoring(enrichResults(store, fusedResults, query), query).slice(0, searchLimit);
		if (scored.length > 0) {
			store.incrementAccessCount(scored.map((result) => result.displayPath));
		}

		return scored;
	}

	private readEpisode(id: string): Episode | null {
		const stored = this.readStoredDocument(this.config.collections.episodes, episodeDocumentPath(id));
		return stored ? parseEpisodeDocument(stored.body) : null;
	}

	private readFact(id: string): SemanticFact | null {
		const stored = this.readStoredDocument(this.config.collections.semantic_facts, factDocumentPath(id));
		return stored ? parseFactDocument(stored.body) : null;
	}

	private readProcedure(id: string): Procedure | null {
		const stored = this.readStoredDocument(this.config.collections.procedures, procedureDocumentPath(id));
		return stored ? parseProcedureDocument(stored.body) : null;
	}

	private readStoredDocument(collection: string, path: string): { hash: string; body: string } | null {
		const store = this.requireStore();
		return store.db
			.prepare(
				`
				SELECT d.hash, c.doc AS body
				FROM documents d
				JOIN content c ON c.hash = d.hash
				WHERE d.collection = ? AND d.path = ? AND d.active = 1
				LIMIT 1
			`,
			)
			.get(collection, path) as { hash: string; body: string } | null;
	}

	private requireStore(): Store {
		if (!this.store) {
			throw new Error("Memory system is not initialized.");
		}
		return this.store;
	}
}

function dedupeByJson<T>(items: T[]): T[] {
	const seen = new Set<string>();
	const deduped: T[] = [];

	for (const item of items) {
		const key = JSON.stringify(item);
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(item);
	}

	return deduped;
}

function matchesFilters(record: unknown, filters?: Record<string, unknown>): boolean {
	if (!filters) return true;
	if (!record || typeof record !== "object") return false;

	for (const [key, expected] of Object.entries(filters)) {
		const actual = (record as Record<string, unknown>)[key];

		if (Array.isArray(expected)) {
			if (Array.isArray(actual)) {
				if (!expected.some((value) => actual.includes(value))) return false;
			} else if (!expected.includes(actual)) {
				return false;
			}
			continue;
		}

		if (Array.isArray(actual)) {
			if (!actual.includes(expected)) return false;
			continue;
		}

		if (actual !== expected) return false;
	}

	return true;
}
