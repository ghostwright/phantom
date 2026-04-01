import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryConfig } from "../../config/types.ts";
import { setClawMemDefaultLlama, type ClawMemLlamaLike } from "../clawmem-runtime.ts";
import { MemorySystem } from "../system.ts";
import type { Episode, Procedure, SemanticFact } from "../types.ts";

function createConfig(storePath: string): MemoryConfig {
	return {
		clawmem: {
			store_path: storePath,
			embed_model: "embedding",
			busy_timeout_ms: 1000,
		},
		collections: {
			episodes: "episodes",
			semantic_facts: "semantic_facts",
			procedures: "procedures",
		},
		context: {
			max_tokens: 50000,
			episode_limit: 10,
			fact_limit: 20,
			procedure_limit: 5,
		},
	};
}

function createFakeLlm(): ClawMemLlamaLike {
	return {
		embed: async (text: string) => ({
			embedding: buildEmbedding(text),
			model: "fake-embed",
		}),
	};
}

function buildEmbedding(text: string): number[] {
	const lower = text.toLowerCase();
	const keywords = ["deploy", "staging", "server", "port", "branch", "procedure", "test", "user"];
	const base: number[] = keywords.map((keyword) => (lower.includes(keyword) ? 1 : 0));
	base.push(Math.max(0.01, Math.min(lower.length / 1000, 1)));
	return base;
}

function createEpisode(): Episode {
	return {
		id: "ep-1",
		type: "task",
		summary: "Deploy staging server",
		detail: "Updated the release pipeline and deployed the staging server to port 3001.",
		parent_id: null,
		session_id: "session-1",
		user_id: "user-1",
		tools_used: ["Bash"],
		files_touched: ["src/index.ts"],
		outcome: "success",
		outcome_detail: "Deployment completed cleanly",
		lessons: ["Run tests before deployment"],
		started_at: new Date(Date.now() - 60_000).toISOString(),
		ended_at: new Date().toISOString(),
		duration_seconds: 60,
		importance: 0.9,
		access_count: 0,
		last_accessed_at: new Date().toISOString(),
		decay_rate: 1,
	};
}

function createFact(overrides?: Partial<SemanticFact>): SemanticFact {
	return {
		id: crypto.randomUUID(),
		subject: "staging server",
		predicate: "runs on",
		object: "port 3000",
		natural_language: "The staging server runs on port 3000.",
		source_episode_ids: ["ep-1"],
		confidence: 0.7,
		valid_from: new Date().toISOString(),
		valid_until: null,
		version: 1,
		previous_version_id: null,
		category: "codebase",
		tags: ["staging"],
		...overrides,
	};
}

function createProcedure(): Procedure {
	return {
		id: "proc-1",
		name: "deploy_staging",
		description: "Deploy the application to staging.",
		trigger: "Use when the user asks for a staging deploy.",
		steps: [
			{
				order: 1,
				action: "Run tests",
				tool: "Bash",
				expected_outcome: "All tests pass",
				error_handling: null,
				decision_point: false,
			},
			{
				order: 2,
				action: "Deploy to staging",
				tool: "Bash",
				expected_outcome: "Staging is updated",
				error_handling: null,
				decision_point: false,
			},
		],
		preconditions: ["CI is green"],
		postconditions: ["Staging has the latest build"],
		parameters: {},
		source_episode_ids: ["ep-1"],
		success_count: 0,
		failure_count: 0,
		last_used_at: new Date(0).toISOString(),
		confidence: 0.8,
		version: 1,
	};
}

describe("MemorySystem with ClawMem", () => {
	let tempDir: string;
	let memory: MemorySystem;

	beforeEach(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "phantom-clawmem-"));
		await setClawMemDefaultLlama(createFakeLlm());
		memory = new MemorySystem(createConfig(join(tempDir, "memory.sqlite")));
		await memory.initialize();
	});

	afterEach(async () => {
		await memory.close();
		await setClawMemDefaultLlama(null);
		await removeTempDir(tempDir);
	});

	test("stores and recalls episodic memory", async () => {
		await memory.storeEpisode(createEpisode());

		const episodes = await memory.recallEpisodes("deploy staging", { limit: 5 });
		expect(episodes).toHaveLength(1);
		expect(episodes[0]?.summary).toContain("Deploy staging server");
	});

	test("invalidates contradicted facts when a stronger fact arrives", async () => {
		await memory.storeFact(createFact());
		await memory.storeFact(
			createFact({
				subject: "staging server",
				predicate: "runs on",
				object: "port 3001",
				natural_language: "The staging server runs on port 3001.",
				confidence: 0.95,
			}),
		);

		const facts = await memory.recallFacts("staging server port", { limit: 10 });
		expect(facts).toHaveLength(1);
		expect(facts[0]?.object).toBe("port 3001");
		expect(facts[0]?.valid_until).toBeNull();
	});

	test("finds procedures and updates their outcomes", async () => {
		await memory.storeProcedure(createProcedure());
		await memory.updateProcedureOutcome("proc-1", true);

		const procedure = await memory.findProcedure("deploy the app to staging");
		expect(procedure).not.toBeNull();
		expect(procedure?.success_count).toBe(1);
		expect(procedure?.failure_count).toBe(0);
	});

	test("reports clawmem health when initialized", async () => {
		const health = await memory.healthCheck();
		expect(health).toEqual({ clawmem: true, configured: true });
	});
});

async function removeTempDir(path: string): Promise<void> {
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			rmSync(path, { recursive: true, force: true });
			return;
		} catch (error: unknown) {
			const code = error instanceof Error && "code" in error ? String(error.code) : "";
			if (code !== "EBUSY") {
				throw error;
			}
			if (attempt < 4) {
				await Bun.sleep(50);
			}
		}
	}
}
