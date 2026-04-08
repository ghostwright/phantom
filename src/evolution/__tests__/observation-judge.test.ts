import { describe, expect, test } from "bun:test";
import { toSessionObservations } from "../judges/observation-judge.ts";
import type { ObservationExtractionResultType } from "../judges/schemas.ts";

describe("toSessionObservations", () => {
	test("preserves affected_files from judge output", () => {
		const judgeResult: ObservationExtractionResultType = {
			session_summary: "Test session",
			session_outcome: "success",
			observations: [
				{
					type: "domain_fact_learned",
					summary: "API runs on port 8080",
					detail: "User mentioned their API configuration",
					evidence: "Our API runs on port 8080",
					importance: 0.7,
					importance_reasoning: "Useful for future tasks",
					affected_config_files: ["domain-knowledge.md", "strategies/task-patterns.md"],
				},
			],
			implicit_signals: {
				user_satisfaction: 0.8,
				user_satisfaction_evidence: "User seemed happy",
				agent_performance: 0.7,
				agent_performance_evidence: "Task completed",
			},
			meta: {
				total_user_messages: 3,
				total_corrections: 0,
				tools_used: ["Read"],
				primary_task_type: "configuration",
			},
		};

		const observations = toSessionObservations(judgeResult);
		expect(observations).toHaveLength(1);
		expect(observations[0].affected_files).toEqual(["domain-knowledge.md", "strategies/task-patterns.md"]);
		expect(observations[0].type).toBe("domain_fact");
	});

	test("sets affected_files to undefined when empty", () => {
		const judgeResult: ObservationExtractionResultType = {
			session_summary: "Test session",
			session_outcome: "success",
			observations: [
				{
					type: "preference_stated",
					summary: "User prefers tabs",
					detail: "Formatting preference",
					evidence: "I prefer tabs",
					importance: 0.5,
					importance_reasoning: "Style preference",
					affected_config_files: [],
				},
			],
			implicit_signals: {
				user_satisfaction: 0.8,
				user_satisfaction_evidence: "OK",
				agent_performance: 0.7,
				agent_performance_evidence: "OK",
			},
			meta: {
				total_user_messages: 1,
				total_corrections: 0,
				tools_used: [],
				primary_task_type: "general",
			},
		};

		const observations = toSessionObservations(judgeResult);
		expect(observations[0].affected_files).toBeUndefined();
	});
});
