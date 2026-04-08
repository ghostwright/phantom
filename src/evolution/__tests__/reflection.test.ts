import { describe, expect, test } from "bun:test";
import { buildCritiqueFromObservations, extractObservations, generateDeltas } from "../reflection.ts";
import type { EvolvedConfig, SessionObservation, SessionSummary } from "../types.ts";

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		session_id: "session-001",
		session_key: "cli:main",
		user_id: "user-1",
		user_messages: ["Hello, help me with TypeScript"],
		assistant_messages: ["Sure, I can help with TypeScript."],
		tools_used: [],
		files_tracked: [],
		outcome: "success",
		cost_usd: 0.05,
		started_at: "2026-03-25T10:00:00Z",
		ended_at: "2026-03-25T10:05:00Z",
		...overrides,
	};
}

function makeEvolvedConfig(): EvolvedConfig {
	return {
		constitution: "# Constitution\n1. Be honest.",
		persona: "# Persona\n- Be direct.",
		userProfile: "# User Profile\n",
		domainKnowledge: "# Domain Knowledge\n",
		strategies: {
			taskPatterns: "",
			toolPreferences: "",
			errorRecovery: "",
		},
		meta: {
			version: 1,
			metricsSnapshot: { session_count: 10, success_rate_7d: 0.9, correction_rate_7d: 0.1 },
		},
	};
}

describe("extractObservations", () => {
	test("extracts corrections from user messages", () => {
		const session = makeSession({
			user_messages: ["No, use TypeScript not JavaScript"],
		});
		const observations = extractObservations(session);
		const corrections = observations.filter((o) => o.type === "correction");
		expect(corrections.length).toBeGreaterThan(0);
		expect(corrections[0].content).toContain("TypeScript");
	});

	test("extracts preferences from user messages", () => {
		const session = makeSession({
			user_messages: ["I prefer using Bun instead of Node.js"],
		});
		const observations = extractObservations(session);
		const preferences = observations.filter((o) => o.type === "preference");
		expect(preferences.length).toBeGreaterThan(0);
	});

	test("records errors when session fails", () => {
		const session = makeSession({ outcome: "failure" });
		const observations = extractObservations(session);
		const errors = observations.filter((o) => o.type === "error");
		expect(errors.length).toBeGreaterThan(0);
	});

	test("records success for successful sessions", () => {
		const session = makeSession({ outcome: "success" });
		const observations = extractObservations(session);
		const successes = observations.filter((o) => o.type === "success");
		expect(successes.length).toBeGreaterThan(0);
	});

	test("records tool patterns when tools are used", () => {
		const session = makeSession({ tools_used: ["Read", "Write", "Bash"] });
		const observations = extractObservations(session);
		const toolPatterns = observations.filter((o) => o.type === "tool_pattern");
		expect(toolPatterns.length).toBeGreaterThan(0);
		expect(toolPatterns[0].content).toContain("Read");
	});

	test("extracts domain facts from user messages", () => {
		const session = makeSession({
			user_messages: ["Our team uses PostgreSQL for all databases"],
		});
		const observations = extractObservations(session);
		const domainFacts = observations.filter((o) => o.type === "domain_fact");
		expect(domainFacts.length).toBeGreaterThan(0);
	});

	test("returns empty for sessions with no signals", () => {
		const session = makeSession({
			user_messages: ["What time is it?"],
			tools_used: [],
			outcome: "success",
		});
		const observations = extractObservations(session);
		// Should at least have a success observation
		expect(observations.filter((o) => o.type === "success").length).toBe(1);
	});
});

describe("buildCritiqueFromObservations", () => {
	test("produces suggested changes for corrections", () => {
		const session = makeSession({ user_messages: ["No, use TypeScript not JavaScript"] });
		const observations = extractObservations(session);
		const critique = buildCritiqueFromObservations(observations, session, makeEvolvedConfig());

		expect(critique.corrections_detected.length).toBeGreaterThan(0);
		expect(critique.suggested_changes.length).toBeGreaterThan(0);
		expect(critique.suggested_changes[0].file).toBe("user-profile.md");
	});

	test("routes domain_fact observations to domain-knowledge.md", () => {
		const session = makeSession({ user_messages: ["Our team uses PostgreSQL for all databases"] });
		const observations = extractObservations(session);
		const critique = buildCritiqueFromObservations(observations, session, makeEvolvedConfig());

		const domainChanges = critique.suggested_changes.filter((c) => c.file === "domain-knowledge.md");
		expect(domainChanges.length).toBeGreaterThan(0);
		expect(domainChanges[0].type).toBe("append");
	});

	test("routes error observations to strategies/error-recovery.md", () => {
		const session = makeSession({ outcome: "failure" });
		const observations = extractObservations(session);
		const critique = buildCritiqueFromObservations(observations, session, makeEvolvedConfig());

		const errorChanges = critique.suggested_changes.filter((c) => c.file === "strategies/error-recovery.md");
		expect(errorChanges.length).toBeGreaterThan(0);
	});

	test("routes tool_pattern observations to strategies/tool-preferences.md", () => {
		const session = makeSession({ tools_used: ["Read", "Write", "Bash"] });
		const observations = extractObservations(session);
		const critique = buildCritiqueFromObservations(observations, session, makeEvolvedConfig());

		const toolChanges = critique.suggested_changes.filter((c) => c.file === "strategies/tool-preferences.md");
		expect(toolChanges.length).toBeGreaterThan(0);
	});

	test("routes success observations to strategies/task-patterns.md", () => {
		const session = makeSession({ outcome: "success" });
		const observations = extractObservations(session);
		const critique = buildCritiqueFromObservations(observations, session, makeEvolvedConfig());

		const successChanges = critique.suggested_changes.filter((c) => c.file === "strategies/task-patterns.md");
		expect(successChanges.length).toBeGreaterThan(0);
	});

	test("rejects path traversal in affected_files", () => {
		const observations: SessionObservation[] = [
			{
				type: "domain_fact",
				content: "Malicious content",
				context: "Attacker-controlled",
				confidence: 0.8,
				source_messages: ["test"],
				affected_files: ["../../.env"],
			},
		];
		const session = makeSession();
		const critique = buildCritiqueFromObservations(observations, session, makeEvolvedConfig());

		// Should fall back to default, not use the traversal path
		const changes = critique.suggested_changes.filter((c) => c.file === "domain-knowledge.md");
		expect(changes.length).toBe(1);
		expect(critique.suggested_changes.every((c) => !c.file.includes(".."))).toBe(true);
	});

	test("uses affected_files override when present", () => {
		const observations: SessionObservation[] = [
			{
				type: "domain_fact",
				content: "API runs on port 8080",
				context: "User shared domain knowledge",
				confidence: 0.8,
				source_messages: ["Our API runs on port 8080"],
				affected_files: ["strategies/task-patterns.md"],
			},
		];
		const session = makeSession();
		const critique = buildCritiqueFromObservations(observations, session, makeEvolvedConfig());

		const changes = critique.suggested_changes.filter((c) => c.file === "strategies/task-patterns.md");
		expect(changes.length).toBeGreaterThan(0);
		expect(changes[0].content).toContain("API runs on port 8080");
	});

	test("produces only success/tool changes for simple successful sessions", () => {
		const session = makeSession({ user_messages: ["What is 2+2?"] });
		const observations = extractObservations(session);
		const critique = buildCritiqueFromObservations(observations, session, makeEvolvedConfig());

		// No correction or preference changes, but success routes to task-patterns
		const correctionChanges = critique.suggested_changes.filter((c) => c.file === "user-profile.md");
		expect(correctionChanges.length).toBe(0);
		const successChanges = critique.suggested_changes.filter((c) => c.file === "strategies/task-patterns.md");
		expect(successChanges.length).toBeGreaterThan(0);
	});

	test("critique format has all required fields", () => {
		const session = makeSession({ user_messages: ["Actually, always use tabs not spaces"] });
		const observations = extractObservations(session);
		const critique = buildCritiqueFromObservations(observations, session, makeEvolvedConfig());

		expect(critique).toHaveProperty("overall_assessment");
		expect(critique).toHaveProperty("what_worked");
		expect(critique).toHaveProperty("what_failed");
		expect(critique).toHaveProperty("corrections_detected");
		expect(critique).toHaveProperty("suggested_changes");
	});
});

describe("generateDeltas", () => {
	test("converts critique suggestions to ConfigDelta objects", () => {
		const session = makeSession({ user_messages: ["No, use TypeScript not JavaScript"] });
		const observations = extractObservations(session);
		const critique = buildCritiqueFromObservations(observations, session, makeEvolvedConfig());
		const deltas = generateDeltas(critique, session.session_id);

		expect(deltas.length).toBeGreaterThan(0);
		for (const delta of deltas) {
			expect(delta).toHaveProperty("file");
			expect(delta).toHaveProperty("type");
			expect(delta).toHaveProperty("content");
			expect(delta).toHaveProperty("rationale");
			expect(delta).toHaveProperty("session_ids");
			expect(delta).toHaveProperty("tier");
			expect(delta.session_ids).toContain(session.session_id);
		}
	});

	test("returns only success/tool deltas for simple sessions", () => {
		const session = makeSession({ user_messages: ["What is 2+2?"] });
		const observations = extractObservations(session);
		const critique = buildCritiqueFromObservations(observations, session, makeEvolvedConfig());
		const deltas = generateDeltas(critique, session.session_id);

		// Success observation generates a delta for task-patterns
		const userProfileDeltas = deltas.filter((d) => d.file === "user-profile.md");
		expect(userProfileDeltas.length).toBe(0);
	});
});
