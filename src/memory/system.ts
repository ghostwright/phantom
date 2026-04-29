import type { MemoryConfig } from "../config/types.ts";
import { EmbeddingClient } from "./embeddings.ts";
import { EpisodicStore } from "./episodic.ts";
import { ProceduralStore } from "./procedural.ts";
import { QdrantClient } from "./qdrant-client.ts";
import { SemanticStore } from "./semantic.ts";
import type { ConsolidationResult, Episode, MemoryHealth, Procedure, RecallOptions, SemanticFact } from "./types.ts";

export class MemorySystem {
	private qdrant: QdrantClient;
	private embedder: EmbeddingClient;
	private episodic: EpisodicStore;
	private semantic: SemanticStore;
	private procedural: ProceduralStore;
	private initialized = false;

	constructor(config: MemoryConfig) {
		this.qdrant = new QdrantClient(config);
		this.embedder = new EmbeddingClient(config);
		this.episodic = new EpisodicStore(this.qdrant, this.embedder, config);
		this.semantic = new SemanticStore(this.qdrant, this.embedder, config);
		this.procedural = new ProceduralStore(this.qdrant, this.embedder, config);
	}

	async initialize(): Promise<void> {
		const health = await this.healthCheck();

		if (!health.qdrant) {
			console.warn("[memory] Qdrant is not available. Memory system running in degraded mode.");
			return;
		}

		if (!health.ollama) {
			console.warn("[memory] Ollama is not available. Memory system running in degraded mode.");
			return;
		}

		try {
			await this.episodic.initialize();
			await this.semantic.initialize();
			await this.procedural.initialize();
			this.initialized = true;
			console.log("[memory] Memory system initialized successfully.");
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[memory] Failed to initialize: ${msg}`);
		}
	}

	async close(): Promise<void> {
		this.initialized = false;
	}

	isReady(): boolean {
		return this.initialized;
	}

	async healthCheck(): Promise<MemoryHealth> {
		const [qdrant, ollama] = await Promise.all([this.qdrant.isHealthy(), this.embedder.isHealthy()]);
		return { qdrant, ollama, configured: true };
	}

	// Episodic memory
	async storeEpisode(episode: Episode): Promise<string> {
		if (!this.initialized) return episode.id;
		return this.episodic.store(episode);
	}

	async recallEpisodes(query: string, options?: RecallOptions): Promise<Episode[]> {
		if (!this.initialized) return [];
		return this.episodic.recall(query, options);
	}

	// Semantic memory
	async storeFact(fact: SemanticFact): Promise<string> {
		if (!this.initialized) return fact.id;
		return this.semantic.store(fact);
	}

	async recallFacts(query: string, options?: RecallOptions): Promise<SemanticFact[]> {
		if (!this.initialized) return [];
		return this.semantic.recall(query, options);
	}

	async findContradictions(fact: SemanticFact): Promise<SemanticFact[]> {
		if (!this.initialized) return [];
		return this.semantic.findContradictions(fact);
	}

	async resolveContradiction(newFact: SemanticFact, existingFact: SemanticFact): Promise<void> {
		if (!this.initialized) return;
		return this.semantic.resolveContradiction(newFact, existingFact);
	}

	// Procedural memory
	async storeProcedure(procedure: Procedure): Promise<string> {
		if (!this.initialized) return procedure.id;
		return this.procedural.store(procedure);
	}

	async findProcedure(taskDescription: string): Promise<Procedure | null> {
		if (!this.initialized) return null;
		return this.procedural.find(taskDescription);
	}

	async updateProcedureOutcome(id: string, success: boolean): Promise<void> {
		if (!this.initialized) return;
		return this.procedural.updateOutcome(id, success);
	}

	// Consolidation (delegates to consolidation.ts, called from index.ts)
	async consolidateSession(_sessionId: string): Promise<ConsolidationResult> {
		return { episodesCreated: 0, factsExtracted: 0, proceduresDetected: 0, durationMs: 0 };
	}

	// Dashboard read/delete surface. Scroll paginates by recency; getById fetches
	// one item; deleteById is the operator-confirmed write path used by the
	// Memory explorer tab. Counts power the health strip.
	async scrollEpisodes(opts: {
		limit: number;
		offset?: string | number;
	}): Promise<{ items: Episode[]; nextOffset: string | number | null }> {
		return this.episodic.scroll(opts);
	}

	async scrollFacts(opts: {
		limit: number;
		offset?: string | number;
	}): Promise<{ items: SemanticFact[]; nextOffset: string | number | null }> {
		return this.semantic.scroll(opts);
	}

	async scrollProcedures(opts: {
		limit: number;
		offset?: string | number;
	}): Promise<{ items: Procedure[]; nextOffset: string | number | null }> {
		return this.procedural.scroll(opts);
	}

	async getEpisodeById(id: string): Promise<Episode | null> {
		return this.episodic.getById(id);
	}

	async getFactById(id: string): Promise<SemanticFact | null> {
		return this.semantic.getById(id);
	}

	async getProcedureById(id: string): Promise<Procedure | null> {
		return this.procedural.getById(id);
	}

	async deleteEpisode(id: string): Promise<void> {
		return this.episodic.deleteById(id);
	}

	async deleteFact(id: string): Promise<void> {
		return this.semantic.deleteById(id);
	}

	async deleteProcedure(id: string): Promise<void> {
		return this.procedural.deleteById(id);
	}

	async countEpisodes(): Promise<number> {
		return this.episodic.count();
	}

	async countFacts(): Promise<number> {
		return this.semantic.count();
	}

	async countProcedures(): Promise<number> {
		return this.procedural.count();
	}

	getEpisodicStore(): EpisodicStore {
		return this.episodic;
	}

	getSemanticStore(): SemanticStore {
		return this.semantic;
	}

	getProceduralStore(): ProceduralStore {
		return this.procedural;
	}

	getEmbedder(): EmbeddingClient {
		return this.embedder;
	}
}
