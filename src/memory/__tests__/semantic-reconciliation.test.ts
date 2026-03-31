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
		confidence: 0.85,
		valid_from: new Date().toISOString(),
		valid_until: null,
		version: 1,
		previous_version_id: null,
		category: "domain_knowledge",
		tags: ["infra"],
		...overrides,
	};
}

function make768dVector(): number[] {
	return Array.from({ length: 768 }, (_, i) => Math.cos(i * 0.01));
}

describe("SemanticStore reconciliation", () => {
	const originalFetch = globalThis.fetch;

	afterAll(() => {
		globalThis.fetch = originalFetch;
	});

	test("store() reinforces repeated facts instead of creating duplicates", async () => {
		const vec = make768dVector();
		let upsertBody: Record<string, unknown> | null = null;

		globalThis.fetch = mock((url: string | Request, init?: RequestInit) => {
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
										id: "fact-existing",
										score: 0.94,
										payload: {
											subject: "staging server",
											predicate: "runs on",
											object: "port 3001",
											natural_language: "The staging server runs on port 3001",
											source_episode_ids: ["ep-001"],
											confidence: 0.75,
											valid_from: Date.now() - 86400000,
											valid_until: null,
											version: 2,
											reinforcement_count: 1,
											last_reinforced_at: Date.now() - 86400000,
											category: "domain_knowledge",
											tags: ["infra"],
										},
									},
								],
							},
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
				);
			}

			if (urlStr.includes("/points") && init?.method === "PUT") {
				upsertBody = JSON.parse(init.body as string);
			}

			return Promise.resolve(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
		}) as unknown as typeof fetch;

		const store = new SemanticStore(new QdrantClient(TEST_CONFIG), new EmbeddingClient(TEST_CONFIG), TEST_CONFIG);
		const id = await store.store(makeTestFact({ source_episode_ids: ["ep-002"], tags: ["deploy"] }));

		expect(id).toBe("fact-existing");
		expect(upsertBody).not.toBeNull();

		const upsertData = upsertBody as unknown as { points: Array<Record<string, unknown>> };
		const point = upsertData.points[0] as Record<string, unknown>;
		const payload = point.payload as Record<string, unknown>;
		expect(point.id).toBe("fact-existing");
		expect(payload.reinforcement_count).toBe(2);
		expect(payload.version).toBe(3);
		expect(payload.confidence).toBe(0.9);
		expect(payload.source_episode_ids).toEqual(["ep-001", "ep-002"]);
		expect(payload.tags).toEqual(["infra", "deploy"]);
	});

	test("store() immediately supersedes lower-confidence contradictions", async () => {
		const vec = make768dVector();
		let upsertBody: Record<string, unknown> | null = null;

		globalThis.fetch = mock((url: string | Request, init?: RequestInit) => {
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
										id: "fact-current",
										score: 0.93,
										payload: {
											subject: "staging server",
											predicate: "runs on",
											object: "port 3000",
											natural_language: "The staging server runs on port 3000",
											confidence: 0.95,
											valid_from: Date.now() - 86400000,
											valid_until: null,
											version: 4,
											category: "domain_knowledge",
											tags: ["infra"],
										},
									},
								],
							},
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
				);
			}

			if (urlStr.includes("/points") && init?.method === "PUT") {
				upsertBody = JSON.parse(init.body as string);
			}

			return Promise.resolve(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
		}) as unknown as typeof fetch;

		const store = new SemanticStore(new QdrantClient(TEST_CONFIG), new EmbeddingClient(TEST_CONFIG), TEST_CONFIG);
		await store.store(makeTestFact({ object: "port 3001", confidence: 0.6 }));

		const upsertData = upsertBody as unknown as { points: Array<Record<string, unknown>> };
		const point = upsertData.points[0] as Record<string, unknown>;
		const payload = point.payload as Record<string, unknown>;
		expect(payload.valid_until).toBeDefined();
		expect(payload.previous_version_id).toBe("fact-current");
		expect(payload.superseded_by_fact_id).toBe("fact-current");
	});

	test("recall() attaches contradiction notes to current facts", async () => {
		const vec = make768dVector();
		let queryCount = 0;

		globalThis.fetch = mock((url: string | Request) => {
			const urlStr = typeof url === "string" ? url : url.url;

			if (urlStr.includes("/api/embed")) {
				return Promise.resolve(new Response(JSON.stringify({ embeddings: [vec] }), { status: 200 }));
			}

			if (urlStr.includes("/points/query")) {
				queryCount += 1;

				if (queryCount === 1) {
					return Promise.resolve(
						new Response(
							JSON.stringify({
								result: {
									points: [
										{
											id: "fact-current",
											score: 0.92,
											payload: {
												subject: "staging server",
												predicate: "runs on",
												object: "port 3001",
												natural_language: "The staging server runs on port 3001",
												confidence: 0.9,
												valid_from: Date.now() - 86400000,
												valid_until: null,
												version: 2,
												reinforcement_count: 1,
												category: "domain_knowledge",
												tags: ["infra"],
											},
										},
									],
								},
							}),
							{ status: 200, headers: { "Content-Type": "application/json" } },
						),
					);
				}

				return Promise.resolve(
					new Response(
						JSON.stringify({
							result: {
								points: [
									{
										id: "fact-old",
										score: 0.88,
										payload: {
											subject: "staging server",
											predicate: "runs on",
											object: "port 3000",
											natural_language: "The staging server runs on port 3000",
											confidence: 0.8,
											valid_from: Date.now() - 2 * 86400000,
											valid_until: Date.now() - 86400000,
											version: 1,
											superseded_by_fact_id: "fact-current",
											category: "domain_knowledge",
											tags: ["infra"],
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

		const store = new SemanticStore(new QdrantClient(TEST_CONFIG), new EmbeddingClient(TEST_CONFIG), TEST_CONFIG);
		const facts = await store.recall("staging server");

		expect(facts).toHaveLength(1);
		expect(facts[0].contradiction_note).toContain("port 3000");
	});
});
