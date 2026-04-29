// Phase 3 evolution types. The shape shrank with the 6-judge deletion: we no
// longer carry ConfigDelta, GateName, ValidationResult, CritiqueResult, or
// GoldenCase because the reflection subprocess writes files directly via the
// SDK. SessionSummary and SessionObservation survive because the subprocess
// still consumes the batch file shape and the gate tests still reference the
// observation enum.

export type MetricsSnapshot = {
	session_count: number;
	success_rate_7d: number;
};

export type VersionChange = {
	file: string;
	type: "edit" | "compact" | "new" | "delete";
	summary: string;
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
	evolution_count: number;
	last_session_at: string | null;
	last_evolution_at: string | null;
	success_rate_7d: number;
};

export type ObservationType = "correction" | "preference" | "error" | "success" | "tool_pattern" | "domain_fact";

export type SessionObservation = {
	type: ObservationType;
	content: string;
	context: string;
	confidence: number;
	source_messages: string[];
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

export type EvolutionResult = {
	version: number;
	changes_applied: VersionChange[];
	changes_rejected: Array<{ change: VersionChange; reasons: string[] }>;
};

export type EvolutionLogEntry = {
	timestamp: string;
	version: number;
	drain_id: string;
	session_ids: string[];
	tier: ReflectionTier | "skip";
	status: SubprocessStatus;
	changes_applied: number;
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

// --- Phase 3 reflection subprocess types ---

export type ReflectionTier = "haiku" | "sonnet" | "opus";

// Top-level outcome the subprocess emits in its sentinel. Compaction is a
// per-change annotation on `SubprocessSentinel.changes[].action`, never a
// top-level status.
export type SubprocessStatus = "ok" | "skip" | "escalate";

/**
 * Structured sentinel the reflection subprocess emits on the final line of
 * its last assistant message. The agent owns every judgment in this object;
 * TypeScript only parses and routes.
 */
export type SubprocessSentinel = {
	status: SubprocessStatus;
	target?: ReflectionTier;
	reason?: string;
	changes?: Array<{
		file: string;
		action?: "edit" | "compact" | "new";
		summary?: string;
		expected_shrinkage?: number;
	}>;
};

export type InvariantCode = "I1" | "I2" | "I3" | "I4" | "I5" | "I6" | "I7" | "I8" | "I9";

export type InvariantFailure = {
	check: InvariantCode;
	file?: string;
	message: string;
};

export type InvariantResult = {
	passed: boolean;
	hardFailures: InvariantFailure[];
	softWarnings: InvariantFailure[];
	filesChanged: string[];
	filesByOperation: Record<string, "edit" | "compact" | "new">;
};

/**
 * Reflection drain telemetry. Accumulated into `metrics.json` under
 * `reflection_stats` on every drain, regardless of outcome (success, skip,
 * timeout, crash, escalation cap). The operator reads this block to see the
 * shape of the new pipeline at a glance.
 */
export type ReflectionStats = {
	drains: number;
	stage_haiku_runs: number;
	stage_sonnet_runs: number;
	stage_opus_runs: number;
	escalation_haiku_to_sonnet: number;
	escalation_sonnet_to_opus: number;
	escalation_cap_hit: number;
	status_ok: number;
	status_skip: number;
	status_escalate_cap: number;
	sigkill_before_write: number;
	sigkill_mid_write: number;
	timeout_haiku: number;
	timeout_sonnet: number;
	timeout_opus: number;
	invariant_failed_hard: number;
	invariant_warned_soft: number;
	sentinel_parse_fail: number;
	total_cost_usd: number;
	compactions_performed: number;
	files_touched: Record<string, number>;
};

/**
 * Result the reflection subprocess returns to the batch processor. Carries
 * enough information for the batch processor to mark queue rows processed or
 * failed, record stats, and surface human-readable diagnostics in logs.
 */
export type ReflectionSubprocessResult = {
	drainId: string;
	status: SubprocessStatus;
	tier: ReflectionTier;
	escalatedFromTier: ReflectionTier | null;
	version: number;
	changes: VersionChange[];
	invariantHardFailures: InvariantFailure[];
	invariantSoftWarnings: InvariantFailure[];
	costUsd: number;
	durationMs: number;
	error: string | null;
	/**
	 * When true, the batch processor should increment retry_count on the
	 * queue rows (and move them to the poison pile at count >= 3). When
	 * false, rows either succeed (markProcessed) or stay in the queue for
	 * a next-cycle retry without a retry count bump (transient).
	 */
	incrementRetryOnFailure: boolean;
	statsDelta: Partial<ReflectionStats>;
};
