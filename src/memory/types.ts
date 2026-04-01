export type EpisodeType = "task" | "subtask" | "interaction" | "error" | "observation";
export type EpisodeOutcome = "success" | "failure" | "partial" | "abandoned";

export type Episode = {
	id: string;
	type: EpisodeType;
	summary: string;
	detail: string;
	parent_id: string | null;
	session_id: string;
	user_id: string;
	tools_used: string[];
	files_touched: string[];
	outcome: EpisodeOutcome;
	outcome_detail: string;
	lessons: string[];
	started_at: string;
	ended_at: string;
	duration_seconds: number;
	importance: number;
	access_count: number;
	last_accessed_at: string;
	decay_rate: number;
};

export type FactCategory = "user_preference" | "domain_knowledge" | "team" | "codebase" | "process" | "tool";

export type SemanticFact = {
	id: string;
	subject: string;
	predicate: string;
	object: string;
	natural_language: string;
	source_episode_ids: string[];
	confidence: number;
	valid_from: string;
	valid_until: string | null;
	version: number;
	previous_version_id: string | null;
	category: FactCategory;
	tags: string[];
};

export type ProcedureStep = {
	order: number;
	action: string;
	tool: string | null;
	expected_outcome: string;
	error_handling: string | null;
	decision_point: boolean;
};

export type Procedure = {
	id: string;
	name: string;
	description: string;
	trigger: string;
	steps: ProcedureStep[];
	preconditions: string[];
	postconditions: string[];
	parameters: Record<string, { type: string; description: string; required: boolean }>;
	source_episode_ids: string[];
	success_count: number;
	failure_count: number;
	last_used_at: string;
	confidence: number;
	version: number;
};

export type RecallOptions = {
	limit?: number;
	minScore?: number;
	strategy?: "recency" | "similarity" | "temporal" | "metadata";
	timeRange?: { from: Date; to: Date };
	filters?: Record<string, unknown>;
};

export type ConsolidationResult = {
	episodesCreated: number;
	factsExtracted: number;
	proceduresDetected: number;
	durationMs: number;
};

export type MemoryHealth = {
	clawmem: boolean;
	configured: boolean;
};
