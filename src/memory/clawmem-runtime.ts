import type { Database } from "bun:sqlite";

export type ClawMemSearchResult = {
	filepath: string;
	displayPath: string;
	title: string;
	context: string | null;
	hash: string;
	docid: string;
	collectionName: string;
	modifiedAt: string;
	bodyLength: number;
	body?: string;
	score: number;
	source: "fts" | "vec";
	chunkPos?: number;
	fragmentType?: string;
	fragmentLabel?: string;
};

export type ClawMemIndexStatus = {
	totalDocuments: number;
	needsEmbedding: number;
	hasVectorIndex: boolean;
	collections: Array<{ name: string; documentCount: number }>;
};

export type ClawMemSaveMemoryParams = {
	collection: string;
	path: string;
	title: string;
	body: string;
	contentType: string;
	confidence?: number;
	qualityScore?: number;
	semanticPayload?: string;
	topicKey?: string;
};

export type ClawMemSaveMemoryResult = {
	action: "inserted" | "deduplicated" | "updated";
	docId: number;
	duplicateCount?: number;
	revisionCount?: number;
};

export type ClawMemStore = {
	db: Database;
	dbPath: string;
	close: () => void;
	ensureVecTable: (dimensions: number) => void;
	getStatus: () => ClawMemIndexStatus;
	searchFTS: (
		query: string,
		limit?: number,
		collectionId?: number,
		collections?: string[],
		dateRange?: { start: string; end: string },
	) => ClawMemSearchResult[];
	searchVec: (
		query: string,
		model: string,
		limit?: number,
		collectionId?: number,
		collections?: string[],
		dateRange?: { start: string; end: string },
	) => Promise<ClawMemSearchResult[]>;
	saveMemory: (params: ClawMemSaveMemoryParams) => ClawMemSaveMemoryResult;
	insertEmbedding: (
		hash: string,
		seq: number,
		pos: number,
		embedding: Float32Array,
		model: string,
		embeddedAt: string,
		fragmentType?: string,
		fragmentLabel?: string,
		canonicalId?: string,
	) => void;
	incrementAccessCount: (paths: string[]) => void;
};

export type ClawMemEnrichedResult = {
	filepath: string;
	displayPath: string;
	title: string;
	score: number;
	body?: string;
	contentType: string;
	modifiedAt: string;
	accessCount: number;
	confidence: number;
	qualityScore: number;
	pinned: boolean;
	context: string | null;
	hash: string;
	docid: string;
	collectionName: string;
	bodyLength: number;
	source: "fts" | "vec";
	chunkPos?: number;
	fragmentType?: string;
	fragmentLabel?: string;
	lastAccessedAt?: string | null;
	duplicateCount: number;
	revisionCount: number;
};

export type ClawMemScoredResult = ClawMemEnrichedResult & {
	compositeScore: number;
	recencyScore: number;
};

export type ClawMemRankedResult = {
	file: string;
	displayPath: string;
	title: string;
	body: string;
	score: number;
};

export type ClawMemLlamaEmbedResult = {
	embedding: number[];
	model: string;
};

export type ClawMemLlamaLike = {
	embed: (
		text: string,
		options?: {
			model?: string;
			isQuery?: boolean;
		},
	) => Promise<ClawMemLlamaEmbedResult | null>;
};

type StoreModule = {
	createStore: (dbPath?: string, opts?: { readonly?: boolean; busyTimeout?: number }) => ClawMemStore;
};

type SearchUtilsModule = {
	enrichResults: (store: ClawMemStore, results: ClawMemSearchResult[], query: string) => ClawMemEnrichedResult[];
	reciprocalRankFusion: (
		resultLists: ClawMemRankedResult[][],
		weights: number[],
		k?: number,
	) => ClawMemRankedResult[];
	toRanked: (result: ClawMemSearchResult) => ClawMemRankedResult;
};

type MemoryModule = {
	applyCompositeScoring: (results: ClawMemEnrichedResult[], query: string) => ClawMemScoredResult[];
};

type LlmModule = {
	formatDocForEmbedding: (text: string, title?: string) => string;
	getDefaultLlamaCpp: () => ClawMemLlamaLike;
	setDefaultLlamaCpp: (llm: ClawMemLlamaLike | null) => void;
};

const dynamicImport = new Function("specifier", "return import(specifier);") as <T>(specifier: string) => Promise<T>;

let storeModulePromise: Promise<StoreModule> | null = null;
let searchUtilsModulePromise: Promise<SearchUtilsModule> | null = null;
let memoryModulePromise: Promise<MemoryModule> | null = null;
let llmModulePromise: Promise<LlmModule> | null = null;

export function loadClawMemStoreModule(): Promise<StoreModule> {
	storeModulePromise ??= dynamicImport<StoreModule>("clawmem/src/store.ts");
	return storeModulePromise;
}

export function loadClawMemSearchUtilsModule(): Promise<SearchUtilsModule> {
	searchUtilsModulePromise ??= dynamicImport<SearchUtilsModule>("clawmem/src/search-utils.ts");
	return searchUtilsModulePromise;
}

export function loadClawMemMemoryModule(): Promise<MemoryModule> {
	memoryModulePromise ??= dynamicImport<MemoryModule>("clawmem/src/memory.ts");
	return memoryModulePromise;
}

export function loadClawMemLlmModule(): Promise<LlmModule> {
	llmModulePromise ??= dynamicImport<LlmModule>("clawmem/src/llm.ts");
	return llmModulePromise;
}

export async function createClawMemStore(
	dbPath?: string,
	opts?: { readonly?: boolean; busyTimeout?: number },
): Promise<ClawMemStore> {
	return (await loadClawMemStoreModule()).createStore(dbPath, opts);
}

export async function setClawMemDefaultLlama(llm: ClawMemLlamaLike | null): Promise<void> {
	(await loadClawMemLlmModule()).setDefaultLlamaCpp(llm);
}
