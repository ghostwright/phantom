import { describe, expect, mock, test } from "bun:test";
import { type SessionData, consolidateSession } from "../consolidation.ts";
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
} {
	const storedEpisodes: Array<Record<string, unknown>> = [];
	const storedFacts: Array<Record<string, unknown>> = [];

	const memory = {
		storeEpisode: mock((episode: Record<string, unknown>) => {
			storedEpisodes.push(episode);
			return Promise.resolve(episode.id as string);
		}),
		storeFact: mock((fact: Record<string, unknown>) => {
			storedFacts.push(fact);
			return Promise.resolve(fact.id as string);
		}),
	} as unknown as MemorySystem;

	return { memory, storedEpisodes, storedFacts };
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

	test("rejects pattern-matching messages that end in a question mark", async () => {
		const { memory, storedFacts } = createMockMemory();
		const data = makeTestSessionData({
			userMessages: ["No did you see the images or no?", "Actually is the deploy script broken?"],
		});

		const result = await consolidateSession(memory, data);

		expect(result.factsExtracted).toBe(0);
		expect(storedFacts.length).toBe(0);
	});

	test("rejects pattern-matching messages with fewer than three words", async () => {
		const { memory, storedFacts } = createMockMemory();
		const data = makeTestSessionData({
			userMessages: ["No actually", "Wrong"],
		});

		const result = await consolidateSession(memory, data);

		expect(result.factsExtracted).toBe(0);
		expect(storedFacts.length).toBe(0);
	});

	test("rejects pattern-matching messages longer than the truncation boundary", async () => {
		const { memory, storedFacts } = createMockMemory();
		const longThinkingOutLoud = `No need to ${"keep typing this whole long stream of consciousness ".repeat(6)}and a final clause`;
		expect(longThinkingOutLoud.length).toBeGreaterThan(200);
		const data = makeTestSessionData({
			userMessages: [longThinkingOutLoud],
		});

		const result = await consolidateSession(memory, data);

		expect(result.factsExtracted).toBe(0);
		expect(storedFacts.length).toBe(0);
	});

	test("dedupes identical messages within the same session", async () => {
		const { memory, storedFacts } = createMockMemory();
		const data = makeTestSessionData({
			userMessages: [
				"I prefer PRs over direct pushes",
				"I prefer PRs over direct pushes",
				"  I prefer PRs over direct pushes  ",
			],
		});

		const result = await consolidateSession(memory, data);

		expect(result.factsExtracted).toBe(1);
		expect(storedFacts.length).toBe(1);
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
