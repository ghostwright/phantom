import { describe, expect, mock, test } from "bun:test";
import { type SessionData, consolidateSession } from "../consolidation.ts";
import type { MemorySystem } from "../system.ts";

function makeTestSessionData(overrides?: Partial<SessionData>): SessionData {
	return {
		sessionId: "sdk-session-1",
		sessionKey: "cli:local",
		userId: "user-1",
		userMessages: [],
		assistantMessages: [],
		toolsUsed: [],
		filesTracked: [],
		startedAt: new Date(Date.now() - 300000).toISOString(),
		endedAt: new Date().toISOString(),
		costUsd: 0.01,
		outcome: "success",
		...overrides,
	};
}

function createMockMemory(): {
	memory: MemorySystem;
	storedFacts: Array<Record<string, unknown>>;
} {
	const storedFacts: Array<Record<string, unknown>> = [];

	const memory = {
		storeEpisode: mock(() => Promise.resolve("episode-id")),
		storeFact: mock((fact: Record<string, unknown>) => {
			storedFacts.push(fact);
			return Promise.resolve(fact.id as string);
		}),
	} as unknown as MemorySystem;

	return { memory, storedFacts };
}

describe("extractFactsFromSession quality gates", () => {
	test("rejects messages with fewer than 5 words", async () => {
		const { memory, storedFacts } = createMockMemory();
		const data = makeTestSessionData({
			userMessages: ["No way", "Actually no", "Wrong thing here", "No that is wrong"],
		});

		await consolidateSession(memory, data);

		expect(storedFacts.length).toBe(0);
	});

	test("accepts messages with exactly 5 words", async () => {
		const { memory, storedFacts } = createMockMemory();
		const data = makeTestSessionData({
			userMessages: ["Actually that is wrong here."],
		});

		await consolidateSession(memory, data);

		expect(storedFacts.length).toBe(1);
		expect(storedFacts[0].confidence).toBe(0.4);
	});

	test("rejects messages with more than 150 words", async () => {
		const { memory, storedFacts } = createMockMemory();
		const words = Array(151).fill("word").join(" ");
		const data = makeTestSessionData({
			userMessages: [`Actually ${words}.`],
		});

		await consolidateSession(memory, data);

		expect(storedFacts.length).toBe(0);
	});

	test("accepts messages with exactly 150 words", async () => {
		const { memory, storedFacts } = createMockMemory();
		const words = Array(149).fill("word").join(" ");
		const data = makeTestSessionData({
			userMessages: [`Actually ${words}.`],
		});

		await consolidateSession(memory, data);

		expect(storedFacts.length).toBe(1);
		expect(storedFacts[0].confidence).toBe(0.4);
	});

	test("rejects messages that appear truncated (no sentence-ending punctuation)", async () => {
		const { memory, storedFacts } = createMockMemory();
		const data = makeTestSessionData({
			userMessages: ["Actually I prefer using tabs instead of", "No that is wrong about the configuration"],
		});

		await consolidateSession(memory, data);

		expect(storedFacts.length).toBe(0);
	});

	test("accepts messages ending with period", async () => {
		const { memory, storedFacts } = createMockMemory();
		const data = makeTestSessionData({
			userMessages: ["Actually I prefer using tabs instead of spaces."],
		});

		await consolidateSession(memory, data);

		expect(storedFacts.length).toBe(2);
	});

	test("accepts messages ending with exclamation mark", async () => {
		const { memory, storedFacts } = createMockMemory();
		const data = makeTestSessionData({
			userMessages: ["No that is completely wrong!"],
		});

		await consolidateSession(memory, data);

		expect(storedFacts.length).toBe(1);
	});

	test("accepts messages ending with question mark", async () => {
		const { memory, storedFacts } = createMockMemory();
		const data = makeTestSessionData({
			userMessages: ["Actually should we use tabs instead?"],
		});

		await consolidateSession(memory, data);

		expect(storedFacts.length).toBe(1);
	});

	test("accepts messages ending with semicolon", async () => {
		const { memory, storedFacts } = createMockMemory();
		const data = makeTestSessionData({
			userMessages: ["I prefer using tabs for indentation;"],
		});

		await consolidateSession(memory, data);

		expect(storedFacts.length).toBe(1);
	});

	test("accepts messages ending with colon", async () => {
		const { memory, storedFacts } = createMockMemory();
		const data = makeTestSessionData({
			userMessages: ["Always use these tools for development:"],
		});

		await consolidateSession(memory, data);

		expect(storedFacts.length).toBe(1);
	});

	test("correction facts have confidence 0.4", async () => {
		const { memory, storedFacts } = createMockMemory();
		const data = makeTestSessionData({
			userMessages: ["Actually the port is five thousand."],
		});

		await consolidateSession(memory, data);

		expect(storedFacts.length).toBe(1);
		expect(storedFacts[0].tags).toContain("correction");
		expect(storedFacts[0].confidence).toBe(0.4);
	});

	test("preference facts have confidence 0.4", async () => {
		const { memory, storedFacts } = createMockMemory();
		const data = makeTestSessionData({
			userMessages: ["I prefer using tabs over spaces."],
		});

		await consolidateSession(memory, data);

		expect(storedFacts.length).toBe(1);
		expect(storedFacts[0].tags).toContain("preference");
		expect(storedFacts[0].confidence).toBe(0.4);
	});

	test("deduplicates identical messages within same session", async () => {
		const { memory, storedFacts } = createMockMemory();
		const data = makeTestSessionData({
			userMessages: ["I prefer using tabs over spaces.", "I prefer using tabs over spaces."],
		});

		await consolidateSession(memory, data);

		expect(storedFacts.length).toBe(1);
	});

	test("deduplicates messages differing only in whitespace", async () => {
		const { memory, storedFacts } = createMockMemory();
		const data = makeTestSessionData({
			userMessages: ["I prefer using tabs over spaces.", "I  prefer  using  tabs  over  spaces."],
		});

		await consolidateSession(memory, data);

		expect(storedFacts.length).toBe(1);
	});

	test("deduplicates messages differing only in case", async () => {
		const { memory, storedFacts } = createMockMemory();
		const data = makeTestSessionData({
			userMessages: ["I prefer using tabs over spaces.", "I PREFER USING TABS OVER SPACES."],
		});

		await consolidateSession(memory, data);

		expect(storedFacts.length).toBe(1);
	});

	test("does not deduplicate genuinely different messages", async () => {
		const { memory, storedFacts } = createMockMemory();
		const data = makeTestSessionData({
			userMessages: ["I prefer using tabs over spaces.", "I prefer using semicolons at line ends."],
		});

		await consolidateSession(memory, data);

		expect(storedFacts.length).toBe(2);
	});

	test("applies all quality gates together", async () => {
		const { memory, storedFacts } = createMockMemory();
		const data = makeTestSessionData({
			userMessages: [
				"No way",
				"Actually this is the correct approach.",
				"I prefer tabs",
				"Wrong that is incorrect configuration here",
				Array(151).fill("word").join(" "),
				"I prefer using semicolons at line ends.",
				"I prefer using semicolons at line ends.",
			],
		});

		await consolidateSession(memory, data);

		expect(storedFacts.length).toBe(2);
		expect(storedFacts.every((f) => f.confidence === 0.4)).toBe(true);
	});

	test("issue #84 regression: short Slack fragments are rejected", async () => {
		const { memory, storedFacts } = createMockMemory();
		const data = makeTestSessionData({
			userMessages: ["No thanks."],
		});

		await consolidateSession(memory, data);

		expect(storedFacts.length).toBe(0);
	});
});
