import { describe, expect, mock, test } from "bun:test";
import type { MemoryConfig } from "../../config/types.ts";
import { MemoryContextBuilder } from "../context-builder.ts";
import type { MemorySystem } from "../system.ts";

const TEST_CONFIG: MemoryConfig = {
	clawmem: { store_path: "data/test-clawmem.sqlite", embed_model: "embedding", busy_timeout_ms: 5000 },
	collections: { episodes: "episodes", semantic_facts: "semantic_facts", procedures: "procedures" },
	context: { max_tokens: 50000, episode_limit: 10, fact_limit: 20, procedure_limit: 5 },
};

function createMockMemorySystem(overrides?: {
	ready?: boolean;
	episodes?: ReturnType<MemorySystem["recallEpisodes"]>;
	facts?: ReturnType<MemorySystem["recallFacts"]>;
	procedure?: ReturnType<MemorySystem["findProcedure"]>;
}): MemorySystem {
	const ms = {
		isReady: () => overrides?.ready ?? true,
		recallEpisodes: mock(() => overrides?.episodes ?? Promise.resolve([])),
		recallFacts: mock(() => overrides?.facts ?? Promise.resolve([])),
		findProcedure: mock(() => overrides?.procedure ?? Promise.resolve(null)),
	} as unknown as MemorySystem;
	return ms;
}

describe("MemoryContextBuilder", () => {
	test("returns empty string when memory system is not ready", async () => {
		const memory = createMockMemorySystem({ ready: false });
		const builder = new MemoryContextBuilder(memory, TEST_CONFIG);

		const result = await builder.build("test query");
		expect(result).toBe("");
	});

	test("returns empty string when no memories found", async () => {
		const memory = createMockMemorySystem();
		const builder = new MemoryContextBuilder(memory, TEST_CONFIG);

		const result = await builder.build("test query");
		expect(result).toBe("");
	});

	test("formats facts section correctly", async () => {
		const memory = createMockMemorySystem({
			facts: Promise.resolve([
				{
					id: "f1",
					subject: "staging",
					predicate: "runs on",
					object: "port 3001",
					natural_language: "The staging server runs on port 3001",
					source_episode_ids: [],
					confidence: 0.9,
					valid_from: new Date().toISOString(),
					valid_until: null,
					version: 1,
					previous_version_id: null,
					category: "domain_knowledge" as const,
					tags: [],
				},
				{
					id: "f2",
					subject: "user",
					predicate: "prefers",
					object: "PRs over direct pushes",
					natural_language: "Cheema prefers PRs over direct pushes",
					source_episode_ids: [],
					confidence: 0.8,
					valid_from: new Date().toISOString(),
					valid_until: null,
					version: 1,
					previous_version_id: null,
					category: "user_preference" as const,
					tags: [],
				},
			]),
		});

		const builder = new MemoryContextBuilder(memory, TEST_CONFIG);
		const result = await builder.build("test query");

		expect(result).toContain("## Known Facts");
		expect(result).toContain("staging server runs on port 3001");
		expect(result).toContain("PRs over direct pushes");
		expect(result).toContain("[confidence: 0.9]");
	});

	test("formats episodes section correctly", async () => {
		const memory = createMockMemorySystem({
			episodes: Promise.resolve([
				{
					id: "ep1",
					type: "task" as const,
					summary: "Deployed the staging server",
					detail: "Full detail",
					parent_id: null,
					session_id: "s1",
					user_id: "u1",
					tools_used: ["Bash"],
					files_touched: [],
					outcome: "success" as const,
					outcome_detail: "",
					lessons: [],
					started_at: new Date(Date.now() - 3600000).toISOString(),
					ended_at: new Date().toISOString(),
					duration_seconds: 3600,
					importance: 0.8,
					access_count: 0,
					last_accessed_at: "",
					decay_rate: 1.0,
				},
			]),
		});

		const builder = new MemoryContextBuilder(memory, TEST_CONFIG);
		const result = await builder.build("test query");

		expect(result).toContain("## Recent Memories");
		expect(result).toContain("[task]");
		expect(result).toContain("Deployed the staging server");
		expect(result).toContain("success");
	});

	test("filters stale low-signal episodes from prompt context", async () => {
		const memory = createMockMemorySystem({
			episodes: Promise.resolve([
				{
					id: "stale-ep",
					type: "task" as const,
					summary: "One-off stale note",
					detail: "No longer important",
					parent_id: null,
					session_id: "s1",
					user_id: "u1",
					tools_used: [],
					files_touched: [],
					outcome: "success" as const,
					outcome_detail: "",
					lessons: [],
					started_at: new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString(),
					ended_at: new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString(),
					duration_seconds: 300,
					importance: 0.2,
					access_count: 0,
					last_accessed_at: new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString(),
					decay_rate: 1.0,
				},
				{
					id: "durable-ep",
					type: "task" as const,
					summary: "Repeated deployment pattern",
					detail: "Still referenced often",
					parent_id: null,
					session_id: "s2",
					user_id: "u1",
					tools_used: ["Bash"],
					files_touched: [],
					outcome: "success" as const,
					outcome_detail: "",
					lessons: [],
					started_at: new Date(Date.now() - 45 * 24 * 3600 * 1000).toISOString(),
					ended_at: new Date(Date.now() - 45 * 24 * 3600 * 1000).toISOString(),
					duration_seconds: 300,
					importance: 0.8,
					access_count: 4,
					last_accessed_at: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
					decay_rate: 1.0,
				},
			]),
		});

		const builder = new MemoryContextBuilder(memory, TEST_CONFIG);
		const result = await builder.build("deployment");

		expect(result).toContain("Repeated deployment pattern");
		expect(result).not.toContain("One-off stale note");
	});

	test("formats procedure section correctly", async () => {
		const memory = createMockMemorySystem({
			procedure: Promise.resolve({
				id: "proc1",
				name: "deploy_staging",
				description: "Deploy to staging environment",
				trigger: "User asks to deploy to staging",
				steps: [
					{
						order: 1,
						action: "Run tests",
						tool: "Bash",
						expected_outcome: "All pass",
						error_handling: null,
						decision_point: false,
					},
					{
						order: 2,
						action: "Create PR",
						tool: "Bash",
						expected_outcome: "PR created",
						error_handling: null,
						decision_point: false,
					},
				],
				preconditions: [],
				postconditions: [],
				parameters: {},
				source_episode_ids: [],
				success_count: 5,
				failure_count: 1,
				last_used_at: new Date().toISOString(),
				confidence: 0.8,
				version: 1,
			}),
		});

		const builder = new MemoryContextBuilder(memory, TEST_CONFIG);
		const result = await builder.build("deploy to staging");

		expect(result).toContain("## Relevant Procedure: deploy_staging");
		expect(result).toContain("1. Run tests");
		expect(result).toContain("2. Create PR");
		expect(result).toContain("5 successes");
	});

	test("respects token budget and truncates", async () => {
		// Create many facts that would exceed a tiny budget
		const manyFacts = Array.from({ length: 100 }, (_, i) => ({
			id: `f${i}`,
			subject: `subject-${i}`,
			predicate: "is",
			object: `a very long description that takes up many tokens for fact number ${i}`,
			natural_language: `Subject ${i} is a very long description that takes up many tokens for fact number ${i} with lots of extra text to make it really long`,
			source_episode_ids: [],
			confidence: 0.9,
			valid_from: new Date().toISOString(),
			valid_until: null,
			version: 1,
			previous_version_id: null,
			category: "domain_knowledge" as const,
			tags: [],
		}));

		const memory = createMockMemorySystem({
			facts: Promise.resolve(manyFacts),
		});

		// Use a very small token budget
		const smallConfig = { ...TEST_CONFIG, context: { ...TEST_CONFIG.context, max_tokens: 100 } };
		const builder = new MemoryContextBuilder(memory, smallConfig);
		const result = await builder.build("test");

		// Context should be bounded
		const estimatedTokens = Math.ceil(result.length / 4);
		// It should fit within a reasonable margin of the budget
		expect(estimatedTokens).toBeLessThan(200);
	});

	test("handles errors from memory system gracefully", async () => {
		const memory = createMockMemorySystem({
			episodes: Promise.reject(new Error("ClawMem unavailable")),
			facts: Promise.reject(new Error("ClawMem unavailable")),
			procedure: Promise.reject(new Error("ClawMem unavailable")),
		});

		const builder = new MemoryContextBuilder(memory, TEST_CONFIG);
		const result = await builder.build("test");

		// Should not throw, just return empty
		expect(result).toBe("");
	});
});
