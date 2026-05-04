import { afterAll, describe, expect, mock, test } from "bun:test";
import type { MemoryConfig } from "../../config/types.ts";
import { EmbeddingClient } from "../embeddings.ts";
import { QdrantClient } from "../qdrant-client.ts";
import { SemanticStore } from "../semantic.ts";
import type { SemanticFact } from "../types.ts";

const TEST_CONFIG: MemoryConfig = {
	qdrant: { url: "http://localhost:6333" },
	ollama: { url: "http://localhost:11434", model: "nomic-embed-text" },
	collections: { episodes: "episodes", semantic_facts: "semantic_facts", procedures: "procedures" },
	embedding: { dimensions: 768, batch_size: 32 },
	context: { max_tokens: 50000, episode_limit: 10, fact_limit: 20, procedure_limit: 5 },
};

function makeTestFact(overrides?: Partial<SemanticFact>): SemanticFact {
	return {
		id: "fact-001",
		subject: "staging server",
		predicate: "runs on",
		object: "port 3001",
		natural_language: "The staging server runs on port 3001",
		source_episode_ids: ["ep-001"],
		confidence: 0.9,
		valid_from: new Date().toISOString(),
		valid_until: null,
		version: 1,
		previous_version_id: null,
		category: "domain_knowledge",
		tags: ["infrastructure"],
		...overrides,
	};
}

function make768dVector(): number[] {
	return Array.from({ length: 768 }, (_, i) => Math.sin(i * 0.01));
}

describe("SemanticStore", () => {
	const originalFetch = globalThis.fetch;

	afterAll(() => {
		globalThis.fetch = originalFetch;
	});

	test("store() embeds fact and upserts to Qdrant", async () => {
		const vec = make768dVector();
		let upsertBody: Record<string, unknown> | null = null;

		globalThis.fetch = mock((url: string | Request, init?: RequestInit) => {
			const urlStr = typeof url === "string" ? url : url.url;

			if (urlStr.includes("/api/embed")) {
				return Promise.resolve(new Response(JSON.stringify({ embeddings: [vec] }), { status: 200 }));
			}

			// Contradiction search returns no results
			if (urlStr.includes("/points/query")) {
				return Promise.resolve(new Response(JSON.stringify({ result: { points: [] } }), { status: 200 }));
			}

			// Exact duplicate scroll returns no match
			if (urlStr.includes("/points/scroll")) {
				return Promise.resolve(
					new Response(
						JSON.stringify({ result: { points: [], next_page_offset: null } }),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
				);
			}

			if (urlStr.includes("/points") && init?.method === "PUT") {
				upsertBody = JSON.parse(init.body as string);
			}

			return Promise.resolve(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
		}) as unknown as typeof fetch;

		const qdrant = new QdrantClient(TEST_CONFIG);
		const embedder = new EmbeddingClient(TEST_CONFIG);
		const store = new SemanticStore(qdrant, embedder, TEST_CONFIG);

		const fact = makeTestFact();
		const id = await store.store(fact);

		expect(id).toBe("fact-001");
		expect(upsertBody).not.toBeNull();

		const upsertData = upsertBody as unknown as Record<string, unknown>;
		const points = upsertData.points as Array<Record<string, unknown>>;
		const payload = points[0].payload as Record<string, unknown>;
		expect(payload.subject).toBe("staging server");
		expect(payload.predicate).toBe("runs on");
		expect(payload.category).toBe("domain_knowledge");
	});

	test("recall() returns facts filtered to currently valid", async () => {
		const vec = make768dVector();
		let capturedBody: Record<string, unknown> | null = null;

		globalThis.fetch = mock((url: string | Request, init?: RequestInit) => {
			const urlStr = typeof url === "string" ? url : url.url;

			if (urlStr.includes("/api/embed")) {
				return Promise.resolve(new Response(JSON.stringify({ embeddings: [vec] }), { status: 200 }));
			}

			if (urlStr.includes("/points/query")) {
				if (init?.body) capturedBody = JSON.parse(init.body as string);
				return Promise.resolve(
					new Response(
						JSON.stringify({
							result: {
								points: [
									{
										id: "fact-001",
										score: 0.9,
										payload: {
											subject: "staging server",
											predicate: "runs on",
											object: "port 3001",
											natural_language: "The staging server runs on port 3001",
											confidence: 0.9,
											valid_from: Date.now() - 86400000,
											valid_until: null,
											category: "domain_knowledge",
											version: 1,
										},
									},
								],
							},
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
				);
			}

			return Promise.resolve(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
		}) as unknown as typeof fetch;

		const qdrant = new QdrantClient(TEST_CONFIG);
		const embedder = new EmbeddingClient(TEST_CONFIG);
		const store = new SemanticStore(qdrant, embedder, TEST_CONFIG);

		const facts = await store.recall("staging server port");

		expect(facts.length).toBe(1);
		expect(facts[0].subject).toBe("staging server");
		expect(facts[0].valid_until).toBeNull();

		// Verify the filter includes valid_until is_null check
		const recallBody = capturedBody as unknown as Record<string, unknown>;
		expect(recallBody).not.toBeNull();
		const filter = recallBody.filter as Record<string, unknown> | undefined;
		expect(filter).toBeDefined();
	});

	test("findContradictions() detects conflicting facts", async () => {
		const vec = make768dVector();

		globalThis.fetch = mock((url: string | Request) => {
			const urlStr = typeof url === "string" ? url : url.url;

			if (urlStr.includes("/api/embed")) {
				return Promise.resolve(new Response(JSON.stringify({ embeddings: [vec] }), { status: 200 }));
			}

			if (urlStr.includes("/points/query")) {
				return Promise.resolve(
					new Response(
						JSON.stringify({
							result: {
								points: [
									{
										id: "fact-old",
										score: 0.92,
										payload: {
											subject: "staging server",
											predicate: "runs on",
											object: "port 3000",
											natural_language: "The staging server runs on port 3000",
											confidence: 0.8,
											valid_until: null,
										},
									},
								],
							},
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
				);
			}

			return Promise.resolve(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
		}) as unknown as typeof fetch;

		const qdrant = new QdrantClient(TEST_CONFIG);
		const embedder = new EmbeddingClient(TEST_CONFIG);
		const store = new SemanticStore(qdrant, embedder, TEST_CONFIG);

		const newFact = makeTestFact({ object: "port 3001" });
		const contradictions = await store.findContradictions(newFact);

		// The existing fact says port 3000, new fact says port 3001 - contradiction
		expect(contradictions.length).toBe(1);
		expect(contradictions[0].object).toBe("port 3000");
	});

	test("findContradictions() does not flag same-object facts", async () => {
		const vec = make768dVector();

		globalThis.fetch = mock((url: string | Request) => {
			const urlStr = typeof url === "string" ? url : url.url;

			if (urlStr.includes("/api/embed")) {
				return Promise.resolve(new Response(JSON.stringify({ embeddings: [vec] }), { status: 200 }));
			}

			if (urlStr.includes("/points/query")) {
				return Promise.resolve(
					new Response(
						JSON.stringify({
							result: {
								points: [
									{
										id: "fact-same",
										score: 0.95,
										payload: {
											subject: "staging server",
											predicate: "runs on",
											object: "port 3001",
											valid_until: null,
										},
									},
								],
							},
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
				);
			}

			return Promise.resolve(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
		}) as unknown as typeof fetch;

		const qdrant = new QdrantClient(TEST_CONFIG);
		const embedder = new EmbeddingClient(TEST_CONFIG);
		const store = new SemanticStore(qdrant, embedder, TEST_CONFIG);

		const newFact = makeTestFact({ object: "port 3001" });
		const contradictions = await store.findContradictions(newFact);

		// Same object value is not a contradiction
		expect(contradictions.length).toBe(0);
	});

	test("store() skips upsert and merges episode IDs for exact duplicate", async () => {
		const vec = make768dVector();
		let upsertCalled = false;
		let updatePayloadBody: Record<string, unknown> | null = null;

		globalThis.fetch = mock((url: string | Request, init?: RequestInit) => {
			const urlStr = typeof url === "string" ? url : url.url;

			if (urlStr.includes("/api/embed")) {
				return Promise.resolve(new Response(JSON.stringify({ embeddings: [vec] }), { status: 200 }));
			}

			// Contradiction search returns no results
			if (urlStr.includes("/points/query")) {
				return Promise.resolve(new Response(JSON.stringify({ result: { points: [] } }), { status: 200 }));
			}

			// Exact duplicate scroll returns an existing fact
			if (urlStr.includes("/points/scroll")) {
				return Promise.resolve(
					new Response(
						JSON.stringify({
							result: {
								points: [
									{
										id: "existing-fact-id",
										payload: {
											subject: "staging server",
											predicate: "runs on",
											object: "port 3001",
											natural_language: "The staging server runs on port 3001",
											source_episode_ids: ["ep-001"],
											confidence: 0.9,
											valid_from: Date.now(),
											valid_until: null,
											version: 1,
											category: "domain_knowledge",
											tags: ["infrastructure"],
										},
									},
								],
							},
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
				);
			}

			// Track upsert calls (should NOT be called)
			if (urlStr.includes("/points") && init?.method === "PUT") {
				upsertCalled = true;
			}

			// Track updatePayload calls
			if (urlStr.includes("/points/payload") && init?.method === "POST") {
				updatePayloadBody = JSON.parse(init.body as string);
			}

			return Promise.resolve(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
		}) as unknown as typeof fetch;

		const qdrant = new QdrantClient(TEST_CONFIG);
		const embedder = new EmbeddingClient(TEST_CONFIG);
		const store = new SemanticStore(qdrant, embedder, TEST_CONFIG);

		const fact = makeTestFact({ id: "new-fact-id", source_episode_ids: ["ep-002"] });
		const id = await store.store(fact);

		expect(id).toBe("existing-fact-id");
		expect(upsertCalled).toBe(false);
		expect(updatePayloadBody).not.toBeNull();
		const payload = (updatePayloadBody as Record<string, unknown>).payload as Record<string, unknown>;
		const mergedEpisodes = payload.source_episode_ids as string[];
		expect(mergedEpisodes).toContain("ep-001");
		expect(mergedEpisodes).toContain("ep-002");
		expect(mergedEpisodes.length).toBe(2);
	});

	test("store() creates new point when subject matches but object differs", async () => {
		const vec = make768dVector();
		let upsertCalled = false;

		globalThis.fetch = mock((url: string | Request, init?: RequestInit) => {
			const urlStr = typeof url === "string" ? url : url.url;

			if (urlStr.includes("/api/embed")) {
				return Promise.resolve(new Response(JSON.stringify({ embeddings: [vec] }), { status: 200 }));
			}

			// Contradiction search returns no results
			if (urlStr.includes("/points/query")) {
				return Promise.resolve(new Response(JSON.stringify({ result: { points: [] } }), { status: 200 }));
			}

			// Exact duplicate scroll returns no match (different object)
			if (urlStr.includes("/points/scroll")) {
				return Promise.resolve(
					new Response(
						JSON.stringify({ result: { points: [], next_page_offset: null } }),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
				);
			}

			if (urlStr.includes("/points") && init?.method === "PUT") {
				upsertCalled = true;
			}

			return Promise.resolve(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
		}) as unknown as typeof fetch;

		const qdrant = new QdrantClient(TEST_CONFIG);
		const embedder = new EmbeddingClient(TEST_CONFIG);
		const store = new SemanticStore(qdrant, embedder, TEST_CONFIG);

		const fact = makeTestFact({ id: "new-fact-id", object: "port 4000" });
		const id = await store.store(fact);

		expect(id).toBe("new-fact-id");
		expect(upsertCalled).toBe(true);
	});

	test("resolveContradiction() invalidates old fact when new has higher confidence", async () => {
		let updatePayloadCalled = false;
		let updateBody: Record<string, unknown> | null = null;

		globalThis.fetch = mock((_url: string | Request, init?: RequestInit) => {
			if (init?.method === "POST" && init.body) {
				updatePayloadCalled = true;
				updateBody = JSON.parse(init.body as string);
			}
			return Promise.resolve(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
		}) as unknown as typeof fetch;

		const qdrant = new QdrantClient(TEST_CONFIG);
		const embedder = new EmbeddingClient(TEST_CONFIG);
		const store = new SemanticStore(qdrant, embedder, TEST_CONFIG);

		const newFact = makeTestFact({ confidence: 0.9 });
		const oldFact = makeTestFact({ id: "fact-old", confidence: 0.7 });

		await store.resolveContradiction(newFact, oldFact);

		expect(updatePayloadCalled).toBe(true);
		// The old fact should have valid_until set
		const updateData = updateBody as unknown as Record<string, unknown>;
		const payload = updateData.payload as Record<string, unknown>;
		expect(payload.valid_until).toBeDefined();
		expect(typeof payload.valid_until).toBe("number");
	});
});
