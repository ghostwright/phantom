export type ConfigTier = "immutable" | "constrained" | "free";

export type DeltaType = "append" | "replace" | "remove";

export type ConfigDelta = {
	file: string;
	type: DeltaType;
	content: string;
	target?: string;
	rationale: string;
	session_ids: string[];
	tier: ConfigTier;
};

export type GateName = "constitution" | "regression" | "size" | "drift" | "safety";

export type GateResult = {
	gate: GateName;
	passed: boolean;
	reason: string;
};

export type ValidationResult = {
	delta: ConfigDelta;
	gates: GateResult[];
	approved: boolean;
};

export type MetricsSnapshot = {
	session_count: number;
	success_rate_7d: number;
	correction_rate_7d: number;
};

export type VersionChange = {
	file: string;
	type: DeltaType;
	content: string;
	rationale: string;
	session_ids: string[];
};

export type EvolutionVersion = {
	version: number;
	parent: number | null;
	timestamp: string;
	changes: VersionChange[];
	metrics_at_change: MetricsSnapshot;
};

export type EvolutionMetrics = {
	session_count: number;
	success_count: number;
	failure_count: number;
	correction_count: number;
	evolution_count: number;
	rollback_count: number;
	last_session_at: string | null;
	last_evolution_at: string | null;
	success_rate_7d: number;
	correction_rate_7d: number;
	sessions_since_consolidation: number;
};

export type ObservationType = "correction" | "preference" | "error" | "success" | "tool_pattern" | "domain_fact";

export type SessionObservation = {
	type: ObservationType;
	content: string;
	context: string;
	confidence: number;
	source_messages: string[];
	affected_files?: string[];
};

export type SessionSummary = {
	session_id: string;
	session_key: string;
	user_id: string;
	user_messages: string[];
	assistant_messages: string[];
	tools_used: string[];
	files_tracked: string[];
	outcome: "success" | "failure" | "partial" | "abandoned";
	cost_usd: number;
	started_at: string;
	ended_at: string;
};

export type CritiqueResult = {
	overall_assessment: string;
	what_worked: string[];
	what_failed: string[];
	corrections_detected: string[];
	suggested_changes: Array<{
		file: string;
		type: DeltaType;
		content: string;
		target?: string;
		rationale: string;
		tier: ConfigTier;
	}>;
};

export type GoldenCase = {
	id: string;
	description: string;
	lesson: string;
	session_id: string;
	created_at: string;
};

export type EvolutionResult = {
	version: number;
	changes_applied: VersionChange[];
	changes_rejected: Array<{ change: VersionChange; reasons: string[] }>;
};

export type EvolutionLogEntry = {
	timestamp: string;
	version: number;
	session_id: string;
	changes_applied: number;
	changes_rejected: number;
	details: VersionChange[];
};

export type EvolvedConfig = {
	constitution: string;
	persona: string;
	userProfile: string;
	domainKnowledge: string;
	strategies: {
		taskPatterns: string;
		toolPreferences: string;
		errorRecovery: string;
	};
	meta: {
		version: number;
		metricsSnapshot: MetricsSnapshot;
	};
};
