export const MIGRATIONS: string[] = [
	`CREATE TABLE IF NOT EXISTS sessions (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		session_key TEXT UNIQUE NOT NULL,
		sdk_session_id TEXT,
		channel_id TEXT NOT NULL,
		conversation_id TEXT NOT NULL,
		status TEXT NOT NULL DEFAULT 'active',
		total_cost_usd REAL NOT NULL DEFAULT 0,
		input_tokens INTEGER NOT NULL DEFAULT 0,
		output_tokens INTEGER NOT NULL DEFAULT 0,
		turn_count INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		last_active_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`,

	`CREATE TABLE IF NOT EXISTS cost_events (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		session_key TEXT NOT NULL,
		cost_usd REAL NOT NULL,
		input_tokens INTEGER NOT NULL,
		output_tokens INTEGER NOT NULL,
		model TEXT NOT NULL,
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		FOREIGN KEY (session_key) REFERENCES sessions(session_key)
	)`,

	`CREATE TABLE IF NOT EXISTS onboarding_state (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		status TEXT NOT NULL DEFAULT 'pending',
		started_at TEXT,
		completed_at TEXT
	)`,

	`CREATE TABLE IF NOT EXISTS dynamic_tools (
		name TEXT PRIMARY KEY,
		description TEXT NOT NULL,
		input_schema TEXT NOT NULL,
		handler_type TEXT NOT NULL DEFAULT 'shell',
		handler_code TEXT,
		handler_path TEXT,
		registered_at TEXT NOT NULL DEFAULT (datetime('now')),
		registered_by TEXT
	)`,

	`CREATE TABLE IF NOT EXISTS scheduled_jobs (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		description TEXT,
		enabled INTEGER NOT NULL DEFAULT 1,
		schedule_kind TEXT NOT NULL,
		schedule_value TEXT NOT NULL,
		task TEXT NOT NULL,
		delivery_channel TEXT DEFAULT 'slack',
		delivery_target TEXT DEFAULT 'owner',
		status TEXT NOT NULL DEFAULT 'active',
		last_run_at TEXT,
		last_run_status TEXT,
		last_run_duration_ms INTEGER,
		last_run_error TEXT,
		next_run_at TEXT,
		run_count INTEGER NOT NULL DEFAULT 0,
		consecutive_errors INTEGER NOT NULL DEFAULT 0,
		delete_after_run INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		created_by TEXT DEFAULT 'agent',
		updated_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`,

	`CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_next_run ON scheduled_jobs(next_run_at) WHERE enabled = 1 AND status = 'active'`,

	// Security P0: remove inline dynamic tools (eval-equivalent via new Function)
	`DELETE FROM dynamic_tools WHERE handler_type = 'inline'`,

	`CREATE TABLE IF NOT EXISTS secrets (
		name TEXT PRIMARY KEY,
		encrypted_value TEXT NOT NULL,
		iv TEXT NOT NULL,
		auth_tag TEXT NOT NULL,
		field_type TEXT NOT NULL DEFAULT 'password',
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		updated_at TEXT NOT NULL DEFAULT (datetime('now')),
		last_accessed_at TEXT,
		access_count INTEGER NOT NULL DEFAULT 0
	)`,

	`CREATE TABLE IF NOT EXISTS secret_requests (
		request_id TEXT PRIMARY KEY,
		fields_json TEXT NOT NULL,
		purpose TEXT NOT NULL,
		notify_channel TEXT,
		notify_channel_id TEXT,
		notify_thread TEXT,
		magic_token_hash TEXT NOT NULL,
		status TEXT NOT NULL DEFAULT 'pending',
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		expires_at TEXT NOT NULL,
		completed_at TEXT
	)`,

	`CREATE TABLE IF NOT EXISTS loops (
		id TEXT PRIMARY KEY,
		goal TEXT NOT NULL,
		workspace_dir TEXT NOT NULL,
		state_file TEXT NOT NULL,
		success_command TEXT,
		max_iterations INTEGER NOT NULL,
		max_cost_usd REAL NOT NULL,
		status TEXT NOT NULL,
		iteration_count INTEGER NOT NULL DEFAULT 0,
		total_cost_usd REAL NOT NULL DEFAULT 0,
		channel_id TEXT,
		conversation_id TEXT,
		status_message_ts TEXT,
		interrupt_requested INTEGER NOT NULL DEFAULT 0,
		last_error TEXT,
		started_at TEXT NOT NULL DEFAULT (datetime('now')),
		last_tick_at TEXT,
		finished_at TEXT
	)`,

	"CREATE INDEX IF NOT EXISTS idx_loops_status ON loops(status)",

	// Track the operator's originating Slack message so the loop runner can
	// drive a reaction ladder on it (hourglass → cycle → terminal emoji).
	// Appended, never inserted mid-array: existing deployments have already
	// applied migrations 0–10, so the new column must land at index 11.
	"ALTER TABLE loops ADD COLUMN trigger_message_ts TEXT",

	"ALTER TABLE loops ADD COLUMN checkpoint_interval INTEGER",

	// Per-tick wall-clock cap (ms). Default 1_800_000 = 30 minutes matches
	// LOOP_DEFAULT_MAX_TICK_DURATION_MS in src/loop/types.ts. Backfilled by
	// the DEFAULT clause for existing rows so the runner never sees NULL.
	"ALTER TABLE loops ADD COLUMN max_tick_duration_ms INTEGER NOT NULL DEFAULT 1800000",
];
