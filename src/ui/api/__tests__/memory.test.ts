import { describe, expect, mock, test } from "bun:test";
import type { MemorySystem } from "../../../memory/system.ts";
import type { Episode, Procedure, SemanticFact } from "../../../memory/types.ts";
import { handleMemoryApi } from "../memory.ts";

function req(path: string, init?: RequestInit): Request {
	return new Request(`http://localhost${path}`, init);
}

function makeEpisode(id: string, overrides: Partial<Episode> = {}): Episode {
	return {
		id,
		type: "task",
		summary: "Refactored payments module",
		detail: "Cleaned up duplicate retry logic in src/payments/*.ts",
		parent_id: null,
		session_id: "sess-123",
		user_id: "u-1",
		tools_used: ["Read", "Edit"],
		files_touched: ["src/payments/index.ts"],
		outcome: "success",
		outcome_detail: "",
		lessons: ["stripe wants idempotency keys"],
		started_at: "2026-04-12T11:30:00.000Z",
		ended_at: "2026-04-12T11:42:00.000Z",
		duration_seconds: 720,
		importance: 0.82,
		access_count: 3,
		last_accessed_at: "2026-04-14T09:12:00.000Z",
		decay_rate: 0.95,
		...overrides,
	};
}

function makeFact(id: string, overrides: Partial<SemanticFact> = {}): SemanticFact {
	return {
		id,
		subject: "user",
		predicate: "prefers",
		object: "vim bindings",
		natural_language: "User prefers vim bindings in the editor.",
		source_episode_ids: ["ep-1"],
		confidence: 0.88,
		valid_from: "2026-04-10T09:00:00.000Z",
		valid_until: null,
		version: 1,
		previous_version_id: null,
		category: "user_preference",
		tags: ["editor", "input"],
		...overrides,
	};
}

function makeProcedure(id: string, overrides: Partial<Procedure> = {}): Procedure {
	return {
		id,
		name: "deploy phantom",
		description: "rsync + restart systemd",
		trigger: "deploy to production",
		steps: [],
		preconditions: [],
		postconditions: [],
		parameters: {},
		source_episode_ids: [],
		success_count: 4,
		failure_count: 0,
		last_used_at: "2026-04-13T10:00:00.000Z",
		confidence: 0.9,
		version: 1,
		...overrides,
	};
}

function memoryStub(overrides: Partial<Record<string, unknown>> = {}): MemorySystem {
	const base = {
		healthCheck: mock(async () => ({ qdrant: true, ollama: true, configured: true })),
		countEpisodes: mock(async () => 412),
		countFacts: mock(async () => 128),
		countProcedures: mock(async () => 18),
		recallEpisodes: mock(async () => [makeEpisode("ep-1")]),
		recallFacts: mock(async () => [makeFact("fact-1")]),
		findProcedure: mock(async () => makeProcedure("proc-1")),
		scrollEpisodes: mock(async () => ({ items: [makeEpisode("ep-1")], nextOffset: "cursor-2" })),
		scrollFacts: mock(async () => ({ items: [makeFact("fact-1")], nextOffset: null })),
		scrollProcedures: mock(async () => ({ items: [makeProcedure("proc-1")], nextOffset: null })),
		getEpisodeById: mock(async (id: string) => (id === "ep-1" ? makeEpisode("ep-1") : null)),
		getFactById: mock(async (id: string) => (id === "fact-1" ? makeFact("fact-1") : null)),
		getProcedureById: mock(async (id: string) => (id === "proc-1" ? makeProcedure("proc-1") : null)),
		deleteEpisode: mock(async () => undefined),
		deleteFact: mock(async () => undefined),
		deleteProcedure: mock(async () => undefined),
		...overrides,
	};
	return base as unknown as MemorySystem;
}

describe("memory API health", () => {
	test("returns counts when Qdrant and Ollama are healthy", async () => {
		const memory = memoryStub();
		const res = (await handleMemoryApi(req("/ui/api/memory/health"), new URL("http://localhost/ui/api/memory/health"), {
			memory,
		})) as Response;
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.qdrant).toBe(true);
		expect(body.ollama).toBe(true);
		const counts = body.counts as Record<string, number>;
		expect(counts.episodes).toBe(412);
		expect(counts.facts).toBe(128);
		expect(counts.procedures).toBe(18);
	});

	test("returns zero counts when Qdrant is down", async () => {
		const memory = memoryStub({
			healthCheck: mock(async () => ({ qdrant: false, ollama: true, configured: true })),
		});
		const res = (await handleMemoryApi(req("/ui/api/memory/health"), new URL("http://localhost/ui/api/memory/health"), {
			memory,
		})) as Response;
		const body = (await res.json()) as { qdrant: boolean; counts: Record<string, number> };
		expect(body.qdrant).toBe(false);
		expect(body.counts.episodes).toBe(0);
		expect(body.counts.facts).toBe(0);
		expect(body.counts.procedures).toBe(0);
	});

	test("tolerates individual count failures", async () => {
		const memory = memoryStub({
			countFacts: mock(async () => {
				throw new Error("boom");
			}),
		});
		const res = (await handleMemoryApi(req("/ui/api/memory/health"), new URL("http://localhost/ui/api/memory/health"), {
			memory,
		})) as Response;
		const body = (await res.json()) as { counts: Record<string, number> };
		expect(body.counts.episodes).toBe(412);
		expect(body.counts.facts).toBe(0);
		expect(body.counts.procedures).toBe(18);
	});

	test("405 on non-GET", async () => {
		const memory = memoryStub();
		const res = (await handleMemoryApi(
			req("/ui/api/memory/health", { method: "POST" }),
			new URL("http://localhost/ui/api/memory/health"),
			{ memory },
		)) as Response;
		expect(res.status).toBe(405);
	});
});

describe("memory API list", () => {
	test("empty search uses scroll", async () => {
		const memory = memoryStub();
		const res = (await handleMemoryApi(
			req("/ui/api/memory/episodes"),
			new URL("http://localhost/ui/api/memory/episodes"),
			{ memory },
		)) as Response;
		expect(res.status).toBe(200);
		const body = (await res.json()) as { items: Episode[]; nextOffset: string | null };
		expect(body.items.length).toBe(1);
		expect(body.nextOffset).toBe("cursor-2");
		expect(
			(memory as unknown as { scrollEpisodes: { mock: { calls: unknown[][] } } }).scrollEpisodes.mock.calls.length,
		).toBe(1);
		expect(
			(memory as unknown as { recallEpisodes: { mock: { calls: unknown[][] } } }).recallEpisodes.mock.calls.length,
		).toBe(0);
	});

	test("with q uses recall for episodes", async () => {
		const memory = memoryStub();
		const res = (await handleMemoryApi(
			req("/ui/api/memory/episodes?q=payments"),
			new URL("http://localhost/ui/api/memory/episodes?q=payments"),
			{ memory },
		)) as Response;
		const body = (await res.json()) as { items: Episode[]; nextOffset: string | null };
		expect(body.items.length).toBe(1);
		expect(body.nextOffset).toBeNull();
		const recallCalls = (memory as unknown as { recallEpisodes: { mock: { calls: unknown[][] } } }).recallEpisodes.mock
			.calls;
		expect(recallCalls.length).toBe(1);
		expect(recallCalls[0][0]).toBe("payments");
	});

	test("with q uses recall for facts", async () => {
		const memory = memoryStub();
		const res = (await handleMemoryApi(
			req("/ui/api/memory/facts?q=vim"),
			new URL("http://localhost/ui/api/memory/facts?q=vim"),
			{ memory },
		)) as Response;
		const body = (await res.json()) as { items: SemanticFact[]; nextOffset: null };
		expect(body.items.length).toBe(1);
		expect(body.nextOffset).toBeNull();
	});

	test("with q uses findProcedure for procedures", async () => {
		const memory = memoryStub();
		const res = (await handleMemoryApi(
			req("/ui/api/memory/procedures?q=deploy"),
			new URL("http://localhost/ui/api/memory/procedures?q=deploy"),
			{ memory },
		)) as Response;
		const body = (await res.json()) as { items: Procedure[]; nextOffset: null };
		expect(body.items.length).toBe(1);
	});

	test("findProcedure returns null yields empty list", async () => {
		const memory = memoryStub({ findProcedure: mock(async () => null) });
		const res = (await handleMemoryApi(
			req("/ui/api/memory/procedures?q=nope"),
			new URL("http://localhost/ui/api/memory/procedures?q=nope"),
			{ memory },
		)) as Response;
		const body = (await res.json()) as { items: Procedure[] };
		expect(body.items).toEqual([]);
	});

	test("passes offset to scroll", async () => {
		const memory = memoryStub();
		await handleMemoryApi(
			req("/ui/api/memory/episodes?offset=cursor-123&limit=5"),
			new URL("http://localhost/ui/api/memory/episodes?offset=cursor-123&limit=5"),
			{ memory },
		);
		const calls = (memory as unknown as { scrollEpisodes: { mock: { calls: unknown[][] } } }).scrollEpisodes.mock.calls;
		expect(calls.length).toBe(1);
		const firstArg = calls[0][0] as { limit: number; offset?: string };
		expect(firstArg.limit).toBe(5);
		expect(firstArg.offset).toBe("cursor-123");
	});

	test("422 on limit > 100", async () => {
		const memory = memoryStub();
		const res = (await handleMemoryApi(
			req("/ui/api/memory/episodes?limit=200"),
			new URL("http://localhost/ui/api/memory/episodes?limit=200"),
			{ memory },
		)) as Response;
		expect(res.status).toBe(422);
	});

	test("422 on non-integer limit", async () => {
		const memory = memoryStub();
		const res = (await handleMemoryApi(
			req("/ui/api/memory/facts?limit=abc"),
			new URL("http://localhost/ui/api/memory/facts?limit=abc"),
			{ memory },
		)) as Response;
		expect(res.status).toBe(422);
	});

	test("404 on unknown type in list", async () => {
		const memory = memoryStub();
		const res = (await handleMemoryApi(req("/ui/api/memory/dreams"), new URL("http://localhost/ui/api/memory/dreams"), {
			memory,
		})) as Response;
		expect(res.status).toBe(404);
	});

	test("405 on non-GET to list", async () => {
		const memory = memoryStub();
		const res = (await handleMemoryApi(
			req("/ui/api/memory/episodes", { method: "POST" }),
			new URL("http://localhost/ui/api/memory/episodes"),
			{ memory },
		)) as Response;
		expect(res.status).toBe(405);
	});
});

describe("memory API detail", () => {
	test("happy path returns item", async () => {
		const memory = memoryStub();
		const res = (await handleMemoryApi(
			req("/ui/api/memory/episodes/ep-1"),
			new URL("http://localhost/ui/api/memory/episodes/ep-1"),
			{ memory },
		)) as Response;
		const body = (await res.json()) as { item: Episode };
		expect(body.item.id).toBe("ep-1");
	});

	test("404 on unknown id", async () => {
		const memory = memoryStub();
		const res = (await handleMemoryApi(
			req("/ui/api/memory/episodes/nope"),
			new URL("http://localhost/ui/api/memory/episodes/nope"),
			{ memory },
		)) as Response;
		expect(res.status).toBe(404);
	});

	test("400 on id containing control characters", async () => {
		const memory = memoryStub();
		const encoded = encodeURIComponent("bad\u0000id");
		const res = (await handleMemoryApi(
			req(`/ui/api/memory/facts/${encoded}`),
			new URL(`http://localhost/ui/api/memory/facts/${encoded}`),
			{ memory },
		)) as Response;
		expect(res.status).toBe(400);
	});

	test("handles URL-encoded id with colon", async () => {
		const memory = memoryStub({
			getEpisodeById: mock(async (id: string) => (id === "chat:abc" ? makeEpisode("chat:abc") : null)),
		});
		const encoded = encodeURIComponent("chat:abc");
		const res = (await handleMemoryApi(
			req(`/ui/api/memory/episodes/${encoded}`),
			new URL(`http://localhost/ui/api/memory/episodes/${encoded}`),
			{ memory },
		)) as Response;
		expect(res.status).toBe(200);
	});
});

describe("memory API delete", () => {
	test("happy path removes and returns deleted:true", async () => {
		const memory = memoryStub();
		const res = (await handleMemoryApi(
			req("/ui/api/memory/episodes/ep-1", { method: "DELETE" }),
			new URL("http://localhost/ui/api/memory/episodes/ep-1"),
			{ memory },
		)) as Response;
		expect(res.status).toBe(200);
		const body = (await res.json()) as { deleted: boolean; id: string };
		expect(body.deleted).toBe(true);
		expect(body.id).toBe("ep-1");
		const deleteCalls = (memory as unknown as { deleteEpisode: { mock: { calls: unknown[][] } } }).deleteEpisode.mock
			.calls;
		expect(deleteCalls.length).toBe(1);
		expect(deleteCalls[0][0]).toBe("ep-1");
	});

	test("404 on unknown id returns without calling deletePoint", async () => {
		const memory = memoryStub();
		const res = (await handleMemoryApi(
			req("/ui/api/memory/facts/missing", { method: "DELETE" }),
			new URL("http://localhost/ui/api/memory/facts/missing"),
			{ memory },
		)) as Response;
		expect(res.status).toBe(404);
		const deleteCalls = (memory as unknown as { deleteFact: { mock: { calls: unknown[][] } } }).deleteFact.mock.calls;
		expect(deleteCalls.length).toBe(0);
	});

	test("procedures delete works", async () => {
		const memory = memoryStub();
		const res = (await handleMemoryApi(
			req("/ui/api/memory/procedures/proc-1", { method: "DELETE" }),
			new URL("http://localhost/ui/api/memory/procedures/proc-1"),
			{ memory },
		)) as Response;
		expect(res.status).toBe(200);
	});
});

describe("memory API misrouting", () => {
	test("returns null on unrelated path", async () => {
		const memory = memoryStub();
		const res = await handleMemoryApi(req("/ui/api/sessions"), new URL("http://localhost/ui/api/sessions"), { memory });
		expect(res).toBeNull();
	});

	test("PUT method not allowed on detail", async () => {
		const memory = memoryStub();
		const res = (await handleMemoryApi(
			req("/ui/api/memory/episodes/ep-1", { method: "PUT" }),
			new URL("http://localhost/ui/api/memory/episodes/ep-1"),
			{ memory },
		)) as Response;
		expect(res.status).toBe(405);
	});
});
