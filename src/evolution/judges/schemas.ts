// zod/v4 required: judge-query.ts uses z.toJSONSchema (v4 only)
import { z } from "zod/v4";

// -- Observation Extraction --

export const ObservationType = z.enum([
	"explicit_correction",
	"implicit_correction",
	"preference_stated",
	"preference_inferred",
	"error_occurred",
	"error_recovered",
	"task_succeeded",
	"task_failed",
	"domain_fact_learned",
	"workflow_pattern",
	"tool_usage_insight",
	"user_sentiment_signal",
]);

export const Observation = z.object({
	type: ObservationType,
	summary: z.string().describe("One sentence describing the observation."),
	detail: z.string().describe("Full context including what happened before and after."),
	evidence: z.string().describe("Direct quote from the session supporting this observation."),
	importance: z
		.number()
		.min(0)
		.max(1)
		.describe("How important is this for future sessions? 0.1 = trivial, 0.5 = moderate, 0.9 = critical."),
	importance_reasoning: z.string().describe("Why this level of importance?"),
	affected_config_files: z
		.array(z.string())
		.describe(
			"Which config files should change? Options: persona.md, user-profile.md, " +
				"domain-knowledge.md, strategies/task-patterns.md, strategies/tool-preferences.md, " +
				"strategies/error-recovery.md",
		),
});

export const ObservationExtractionResult = z.object({
	session_summary: z.string().describe("2-3 sentence summary of the overall session."),
	session_outcome: z.enum(["success", "partial_success", "failure", "abandoned"]),
	observations: z.array(Observation),
	implicit_signals: z.object({
		user_satisfaction: z
			.number()
			.min(0)
			.max(1)
			.describe("Estimated user satisfaction. 0 = frustrated, 0.5 = neutral, 1 = delighted."),
		user_satisfaction_evidence: z.string(),
		agent_performance: z
			.number()
			.min(0)
			.max(1)
			.describe("How well did the agent perform? 0 = terrible, 0.5 = adequate, 1 = excellent."),
		agent_performance_evidence: z.string(),
	}),
	meta: z.object({
		total_user_messages: z.number(),
		total_corrections: z.number(),
		tools_used: z.array(z.string()),
		primary_task_type: z.string(),
	}),
});

export type ObservationExtractionResultType = z.infer<typeof ObservationExtractionResult>;

// -- Safety Gate --

export const SafetyCategory = z.enum([
	"self_preservation",
	"scope_creep",
	"manipulation",
	"permission_escalation",
	"evolution_tampering",
	"safety_removal",
	"deception",
	"autonomy_expansion",
]);

export const SafetyFlag = z.object({
	category: SafetyCategory,
	severity: z.enum(["critical", "warning", "info"]),
	evidence: z.string().describe("Exact quote from the proposed change that triggered this flag."),
	reasoning: z.string().describe("Why this text is concerning in this context."),
	false_positive_likelihood: z
		.number()
		.min(0)
		.max(1)
		.describe("How likely is this a false positive? Consider the full context."),
});

export const SafetyGateResult = z.object({
	overall_reasoning: z.string().describe("Step-by-step analysis through a safety lens."),
	flags: z.array(SafetyFlag),
	verdict: z.enum(["pass", "fail"]),
	confidence: z.number().min(0).max(1),
	recommendation: z.string().describe("If failing, what needs to change. If passing, why flagged items are OK."),
});

export type SafetyGateResultType = z.infer<typeof SafetyGateResult>;

// -- Constitution Gate --

export const ConstitutionGateResult = z.object({
	reasoning: z.string().describe("Step-by-step analysis against each constitutional principle."),
	violated_principles: z.array(
		z.object({
			principle: z.string(),
			evidence: z.string(),
			severity: z.enum(["critical", "warning"]),
			reasoning: z.string(),
		}),
	),
	verdict: z.enum(["pass", "fail"]),
	confidence: z.number().min(0).max(1),
});

export type ConstitutionGateResultType = z.infer<typeof ConstitutionGateResult>;

// -- Regression Gate --

export const GoldenCaseJudgment = z.object({
	case_id: z.string(),
	reasoning: z
		.string()
		.describe("Think through whether the proposed change could alter agent behavior for this test case."),
	verdict: z.enum(["pass", "fail", "uncertain"]),
	confidence: z.number().min(0).max(1),
	risk_description: z.string().optional().describe("If fail or uncertain, the specific regression risk."),
});

export const RegressionGateResult = z.object({
	overall_reasoning: z.string().describe("High-level assessment of how the change interacts with the golden suite."),
	per_case_results: z.array(GoldenCaseJudgment),
	overall_verdict: z.enum(["pass", "fail"]),
	overall_confidence: z.number().min(0).max(1),
	suggestions: z.string().optional().describe("If failing, how the change could be modified to pass."),
});

export type RegressionGateResultType = z.infer<typeof RegressionGateResult>;

// -- Consolidation --

export const ExtractedFact = z.object({
	natural_language: z.string().describe("The fact expressed in clear natural language."),
	subject: z.string(),
	predicate: z.string(),
	object: z.string(),
	category: z.enum(["user_preference", "domain_knowledge", "team", "codebase", "process", "tool"]),
	confidence: z
		.number()
		.min(0)
		.max(1)
		.describe("How confident this is a real, stable fact? 0.3 = possibly, 0.6 = likely, 0.9 = certain."),
	evidence: z.string().describe("Quote from the session supporting this fact."),
	is_update: z.boolean().describe("Does this update or contradict a previously known fact?"),
	contradicted_fact: z.string().optional().describe("If is_update=true, the previous fact being updated."),
});

export const DetectedProcedure = z.object({
	name: z.string().describe("Short name for the procedure."),
	description: z.string().describe("What this procedure accomplishes."),
	trigger: z.string().describe("When should this procedure be used?"),
	steps: z.array(z.string()).describe("Ordered list of steps."),
	confidence: z.number().min(0).max(1),
	evidence: z.string(),
});

export const ConsolidationJudgeResult = z.object({
	reasoning: z.string().describe("Walk through the session identifying key moments for memory extraction."),
	extracted_facts: z.array(ExtractedFact),
	detected_procedures: z.array(DetectedProcedure),
	episode_importance: z
		.number()
		.min(0)
		.max(1)
		.describe("Overall importance for long-term memory. 0.1 = routine. 0.5 = useful. 0.9 = critical."),
	episode_importance_reasoning: z.string(),
	contradiction_alerts: z.array(
		z.object({
			new_fact: z.string(),
			existing_fact: z.string(),
			resolution: z.enum(["new_supersedes", "existing_preserved", "needs_human_review"]),
			reasoning: z.string(),
		}),
	),
	key_takeaways: z.array(z.string()).describe("3-5 bullet points summarizing what was learned."),
});

export type ConsolidationJudgeResultType = z.infer<typeof ConsolidationJudgeResult>;

// -- Quality Assessment --

export const QualityDimension = z.object({
	dimension: z.string(),
	score: z.number().min(0).max(1),
	reasoning: z.string(),
	evidence: z.string(),
});

export const QualityAssessmentResult = z.object({
	overall_reasoning: z.string().describe("Holistic assessment of the session quality."),
	goal_accomplished: z.object({
		verdict: z.enum(["yes", "partially", "no"]),
		reasoning: z.string(),
	}),
	dimensions: z
		.array(QualityDimension)
		.describe("Score each: accuracy, helpfulness, efficiency, communication_style, tool_usage, error_handling."),
	errors_or_misconceptions: z.array(
		z.object({
			description: z.string(),
			severity: z.enum(["minor", "moderate", "major"]),
			evidence: z.string(),
		}),
	),
	overall_score: z
		.number()
		.min(0)
		.max(1)
		.describe("Composite quality score. 0.3 = poor, 0.5 = adequate, 0.7 = good, 0.9 = excellent."),
	regression_signal: z.boolean().describe("Is quality notably worse than expected from current config?"),
	regression_reasoning: z.string().optional(),
});

export type QualityAssessmentResultType = z.infer<typeof QualityAssessmentResult>;
