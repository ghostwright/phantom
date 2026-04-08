import { describe, expect, mock, test } from "bun:test";
import { type SessionData, consolidateSession, consolidateSessionWithLLM } from "../consolidation.ts";
import type { MemorySystem } from "../system.ts";

function makeTestSessionData(overrides?: Partial<SessionData>): SessionData {
	return {
		sessionId: "sdk-session-1",
		sessionKey: "cli:local",
		userId: "user-1",
		userMessages: ["Deploy the staging server"],
		assistantMessages: ["I'll deploy the staging server now."],
		toolsUsed: ["Bash", "Write"],
		filesTracked: ["/deploy.sh"],
		startedAt: new Date(Date.now() - 300000).toISOString(),
		endedAt: new Date().toISOString(),
		costUsd: 0.15,
		outcome: "success",
		...overrides,
	};
}

function createMockMemory(): {
	memory: MemorySystem;
	storedEpisodes: Array<Record<string, unknown>>;
	storedFacts: Array<Record<string, unknown>>;
	storedProcedures: Array<Record<string, unknown>>;
} {
	const storedEpisodes: Array<Record<string, unknown>> = [];
	const storedFacts: Array<Record<string, unknown>> = [];
	const storedProcedures: Array<Record<string, unknown>> = [];

	const memory = {
		storeEpisode: mock((episode: Record<string, unknown>) => {
			storedEpisodes.push(episode);
			return Promise.resolve(episode.id as string);
		}),
		storeFact: mock((fact: Record<string, unknown>) => {
			storedFacts.push(fact);
			return Promise.resolve(fact.id as string);
		}),
		storeProcedure: mock((procedure: Record<string, unknown>) => {
			storedProcedures.push(procedure);
			return Promise.resolve(procedure.id as string);
		}),
	} as unknown as MemorySystem;

	return { memory, storedEpisodes, storedFacts, storedProcedures };
}

describe("consolidateSession", () => {
	test("creates an episode from session data", async () => {
		const { memory, storedEpisodes } = createMockMemory();
		const data = makeTestSessionData();

		const result = await consolidateSession(memory, data);

		expect(result.episodesCreated).toBe(1);
		expect(storedEpisodes.length).toBe(1);

		const episode = storedEpisodes[0];
		expect(episode.type).toBe("task");
		expect(episode.session_id).toBe("sdk-session-1");
		expect(episode.user_id).toBe("user-1");
		expect(episode.outcome).toBe("success");
		expect(episode.tools_used).toEqual(["Bash", "Write"]);
		expect(episode.files_touched).toEqual(["/deploy.sh"]);
	});

	test("episode summary is derived from first user message", async () => {
		const { memory, storedEpisodes } = createMockMemory();
		const data = makeTestSessionData({
			userMessages: ["Deploy the staging server to us-west-2"],
		});

		await consolidateSession(memory, data);

		expect(storedEpisodes[0].summary).toBe("Deploy the staging server to us-west-2");
	});

	test("long messages are truncated in summary", async () => {
		const { memory, storedEpisodes } = createMockMemory();
		const longMessage = "A".repeat(300);
		const data = makeTestSessionData({ userMessages: [longMessage] });

		await consolidateSession(memory, data);

		const summary = storedEpisodes[0].summary as string;
		expect(summary.length).toBeLessThanOrEqual(200);
		expect(summary.endsWith("...")).toBe(true);
	});

	test("failure sessions get higher importance", async () => {
		const { memory: memSuccess, storedEpisodes: epsSuccess } = createMockMemory();
		const { memory: memFailure, storedEpisodes: epsFailure } = createMockMemory();

		await consolidateSession(memSuccess, makeTestSessionData({ outcome: "success" }));
		await consolidateSession(memFailure, makeTestSessionData({ outcome: "failure" }));

		const successImportance = epsSuccess[0].importance as number;
		const failureImportance = epsFailure[0].importance as number;

		expect(failureImportance).toBeGreaterThan(successImportance);
	});

	test("extracts correction facts from user messages", async () => {
		const { memory, storedFacts } = createMockMemory();
		const data = makeTestSessionData({
			userMessages: ["Actually, the staging server is on port 3001 not 3000", "Deploy it now"],
		});

		const result = await consolidateSession(memory, data);

		expect(result.factsExtracted).toBe(1);
		expect(storedFacts.length).toBe(1);
		expect(storedFacts[0].category).toBe("user_preference");
		expect(storedFacts[0].tags).toContain("correction");
	});

	test("extracts preference facts from user messages", async () => {
		const { memory, storedFacts } = createMockMemory();
		const data = makeTestSessionData({
			userMessages: ["I prefer PRs over direct pushes", "Please always use feature branches"],
		});

		const result = await consolidateSession(memory, data);

		expect(result.factsExtracted).toBe(2);
		expect(storedFacts[0].tags).toContain("preference");
		expect(storedFacts[1].tags).toContain("preference");
	});

	test("does not extract facts from normal messages", async () => {
		const { memory, storedFacts } = createMockMemory();
		const data = makeTestSessionData({
			userMessages: ["How's the build going?", "Looks good, thanks"],
		});

		const result = await consolidateSession(memory, data);

		expect(result.factsExtracted).toBe(0);
		expect(storedFacts.length).toBe(0);
	});

	test("episode detail includes tools and files", async () => {
		const { memory, storedEpisodes } = createMockMemory();
		const data = makeTestSessionData({
			toolsUsed: ["Bash", "Write", "Edit"],
			filesTracked: ["/src/index.ts", "/package.json"],
		});

		await consolidateSession(memory, data);

		const detail = storedEpisodes[0].detail as string;
		expect(detail).toContain("Bash, Write, Edit");
		expect(detail).toContain("/src/index.ts");
	});

	test("returns timing information", async () => {
		const { memory } = createMockMemory();
		const result = await consolidateSession(memory, makeTestSessionData());

		expect(result.durationMs).toBeGreaterThanOrEqual(0);
		expect(typeof result.durationMs).toBe("number");
	});
});

// Mock the consolidation judge for LLM path tests
mock.module("../../evolution/judges/consolidation-judge.ts", () => ({
	runConsolidationJudge: mock(),
}));

import { runConsolidationJudge } from "../../evolution/judges/consolidation-judge.ts";
const mockedRunConsolidationJudge = runConsolidationJudge as ReturnType<typeof mock>;

function makeJudgeResult(overrides?: {
	detected_procedures?: Array<{
		name: string;
		description: string;
		trigger: string;
		steps: string[];
		confidence: number;
		evidence: string;
	}>;
	extracted_facts?: Array<Record<string, unknown>>;
}) {
	return {
		data: {
			reasoning: "test reasoning",
			extracted_facts: overrides?.extracted_facts ?? [],
			detected_procedures: overrides?.detected_procedures ?? [],
			episode_importance: 0.5,
			episode_importance_reasoning: "test",
			contradiction_alerts: [],
			key_takeaways: ["test"],
		},
		costUsd: 0.01,
		inputTokens: 100,
		outputTokens: 50,
	};
}

describe("consolidateSessionWithLLM - procedure storage", () => {
	test("stores detected procedures from judge output", async () => {
		const { memory, storedProcedures } = createMockMemory();
		mockedRunConsolidationJudge.mockResolvedValueOnce(
			makeJudgeResult({
				detected_procedures: [
					{
						name: "deploy-staging",
						description: "Deploy to staging environment",
						trigger: "User asks to deploy staging",
						steps: ["Run tests", "Build artifacts", "Deploy"],
						confidence: 0.8,
						evidence: "User deployed staging",
					},
				],
			}),
		);

		const { result } = await consolidateSessionWithLLM(memory, makeTestSessionData(), "");

		expect(result.proceduresDetected).toBe(1);
		expect(storedProcedures.length).toBe(1);
		expect(storedProcedures[0].name).toBe("deploy-staging");
		expect(storedProcedures[0].description).toBe("Deploy to staging environment");
		expect(storedProcedures[0].trigger).toBe("User asks to deploy staging");
		expect(storedProcedures[0].confidence).toBe(0.8);

		const steps = storedProcedures[0].steps as Array<{ order: number; action: string }>;
		expect(steps.length).toBe(3);
		expect(steps[0].order).toBe(1);
		expect(steps[0].action).toBe("Run tests");
		expect(steps[2].order).toBe(3);
		expect(steps[2].action).toBe("Deploy");
	});

	test("seeds success_count from session outcome", async () => {
		const { memory: memSuccess, storedProcedures: procsSuccess } = createMockMemory();
		const { memory: memFailure, storedProcedures: procsFailure } = createMockMemory();

		const proc = {
			name: "test-proc",
			description: "test",
			trigger: "test",
			steps: ["step1"],
			confidence: 0.7,
			evidence: "test",
		};

		mockedRunConsolidationJudge.mockResolvedValueOnce(makeJudgeResult({ detected_procedures: [proc] }));
		await consolidateSessionWithLLM(memSuccess, makeTestSessionData({ outcome: "success" }), "");

		mockedRunConsolidationJudge.mockResolvedValueOnce(makeJudgeResult({ detected_procedures: [proc] }));
		await consolidateSessionWithLLM(memFailure, makeTestSessionData({ outcome: "failure" }), "");

		expect(procsSuccess[0].success_count).toBe(1);
		expect(procsSuccess[0].failure_count).toBe(0);
		expect(procsFailure[0].success_count).toBe(0);
		expect(procsFailure[0].failure_count).toBe(1);
	});

	test("handles empty procedures array gracefully", async () => {
		const { memory, storedProcedures } = createMockMemory();
		mockedRunConsolidationJudge.mockResolvedValueOnce(makeJudgeResult());

		const { result } = await consolidateSessionWithLLM(memory, makeTestSessionData(), "");

		expect(result.proceduresDetected).toBe(0);
		expect(storedProcedures.length).toBe(0);
	});
});
