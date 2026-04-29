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

	// Phase 2.5 scheduler hardening: record whether the last delivery attempt
	// actually made it to Slack. null = never delivered, "delivered" = sent,
	// "dropped:<reason>" = skipped at the delivery branch, "error:<reason>" =
	// Slack threw during send. Existing rows keep null on migration.
	"ALTER TABLE scheduled_jobs ADD COLUMN last_delivery_status TEXT",

	// PR1 dashboard: skills editor audit log. Every create/update/delete from
	// the UI API writes a row here so the user can see the history of their
	// skills. Agent-originated edits (via the Write tool) are not captured
	// today; a future PR may add a file-watcher.
	`CREATE TABLE IF NOT EXISTS skill_audit_log (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		skill_name TEXT NOT NULL,
		action TEXT NOT NULL,
		previous_body TEXT,
		new_body TEXT,
		actor TEXT NOT NULL,
		created_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`,

	"CREATE INDEX IF NOT EXISTS idx_skill_audit_log_name ON skill_audit_log(skill_name, id DESC)",

	// PR1 dashboard: memory file editor audit log. Same pattern as skills.
	`CREATE TABLE IF NOT EXISTS memory_file_audit_log (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		file_path TEXT NOT NULL,
		action TEXT NOT NULL,
		previous_content TEXT,
		new_content TEXT,
		actor TEXT NOT NULL,
		created_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`,

	"CREATE INDEX IF NOT EXISTS idx_memory_file_audit_log_path ON memory_file_audit_log(file_path, id DESC)",

	// PR2 dashboard: plugin install audit log. Every install/uninstall from the
	// UI API writes a row here so the operator can see the history of what was
	// enabled or disabled, who did it, and what the marketplace source was at
	// install time. Agent-originated writes to settings.json bypass this path
	// today; a future PR may add a file watcher to capture those.
	`CREATE TABLE IF NOT EXISTS plugin_install_audit_log (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		plugin_name TEXT NOT NULL,
		marketplace TEXT NOT NULL,
		action TEXT NOT NULL,
		source_type TEXT,
		source_url TEXT,
		previous_value TEXT,
		new_value TEXT,
		actor TEXT NOT NULL,
		created_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`,

	"CREATE INDEX IF NOT EXISTS idx_plugin_install_audit_log_plugin ON plugin_install_audit_log(plugin_name, marketplace, id DESC)",

	// PR3 dashboard: subagent editor audit log. Every create/update/delete from
	// the UI API writes a row here. Agent-originated edits via the Write tool
	// bypass this path; a future PR may add a file watcher to capture those.
	`CREATE TABLE IF NOT EXISTS subagent_audit_log (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		subagent_name TEXT NOT NULL,
		action TEXT NOT NULL,
		previous_body TEXT,
		new_body TEXT,
		actor TEXT NOT NULL,
		created_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`,

	"CREATE INDEX IF NOT EXISTS idx_subagent_audit_log_name ON subagent_audit_log(subagent_name, id DESC)",

	// PR3 dashboard: hooks editor audit log. Captures every install, update,
	// uninstall, and first-install trust acceptance via the UI API. Each row
	// stores the full previous and new hooks slice as JSON so a human can
	// diff and recover. Agent-originated Write tool edits bypass this path.
	`CREATE TABLE IF NOT EXISTS hook_audit_log (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		event TEXT NOT NULL,
		matcher TEXT,
		hook_type TEXT,
		action TEXT NOT NULL,
		previous_slice TEXT,
		new_slice TEXT,
		definition_json TEXT,
		actor TEXT NOT NULL,
		created_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`,

	"CREATE INDEX IF NOT EXISTS idx_hook_audit_log_created ON hook_audit_log(id DESC)",

	// PR3 dashboard: curated settings audit log. One row per dirty field per
	// save captures the key, previous JSON value, and new JSON value so a
	// human can diff and recover. Agent-originated Write tool edits to
	// settings.json bypass this path.
	`CREATE TABLE IF NOT EXISTS settings_audit_log (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		field TEXT NOT NULL,
		previous_value TEXT,
		new_value TEXT,
		actor TEXT NOT NULL,
		created_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`,

	"CREATE INDEX IF NOT EXISTS idx_settings_audit_log_field ON settings_audit_log(field, id DESC)",

	// PR3 fix pass: extend the subagent audit log to capture frontmatter
	// changes. An edit that only touches tools or model would otherwise
	// show previous_body == new_body and become invisible in the audit
	// timeline. These columns default to NULL so pre-existing rows remain
	// valid. SQLite ALTER TABLE with a default is idempotent under the
	// _migrations gate.
	"ALTER TABLE subagent_audit_log ADD COLUMN previous_frontmatter_json TEXT",
	"ALTER TABLE subagent_audit_log ADD COLUMN new_frontmatter_json TEXT",

	// Phase 2 evolution cadence: sessions that passed the conditional firing
	// gate wait here until the cadence cron or the demand trigger drains the
	// queue into the batch processor. Rows are removed on successful drain;
	// a crashed drain leaves them in place so the next tick can retry them.
	`CREATE TABLE IF NOT EXISTS evolution_queue (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		session_id TEXT NOT NULL,
		session_key TEXT NOT NULL,
		gate_decision_json TEXT NOT NULL,
		session_summary_json TEXT NOT NULL,
		enqueued_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`,

	"CREATE INDEX IF NOT EXISTS idx_evolution_queue_enqueued_at ON evolution_queue(enqueued_at)",

	// Phase 3 evolution pipeline: bounded retry path for invariant hard
	// failures on the reflection subprocess. Rows are retried up to three
	// times before being moved to `evolution_queue_poison` for manual
	// inspection. Transient crashes (SIGKILL, timeout) do NOT increment
	// retry_count because those are infrastructure issues, not content
	// issues. This is the deliberate asymmetry from the Phase 3 brief.
	"ALTER TABLE evolution_queue ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0",

	`CREATE TABLE IF NOT EXISTS evolution_queue_poison (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		session_id TEXT NOT NULL,
		session_key TEXT NOT NULL,
		gate_decision_json TEXT NOT NULL,
		session_summary_json TEXT NOT NULL,
		original_enqueued_at TEXT NOT NULL,
		poisoned_at TEXT NOT NULL DEFAULT (datetime('now')),
		failure_reason TEXT
	)`,

	// -- Chat Channel Migrations (28-39) --

	`CREATE TABLE IF NOT EXISTS chat_sessions (
		id TEXT PRIMARY KEY,
		owner_user_id TEXT NOT NULL DEFAULT 'owner',
		title TEXT,
		title_is_manual INTEGER NOT NULL DEFAULT 0,
		status TEXT NOT NULL DEFAULT 'active',
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		updated_at TEXT NOT NULL DEFAULT (datetime('now')),
		last_message_at TEXT,
		first_user_message_at TEXT,
		message_count INTEGER NOT NULL DEFAULT 0,
		input_tokens INTEGER NOT NULL DEFAULT 0,
		output_tokens INTEGER NOT NULL DEFAULT 0,
		total_cost_usd REAL NOT NULL DEFAULT 0,
		model TEXT,
		pinned INTEGER NOT NULL DEFAULT 0,
		forked_from_session_id TEXT REFERENCES chat_sessions(id),
		forked_from_message_seq INTEGER,
		deleted_at TEXT,
		metadata_json TEXT
	)`,

	"CREATE INDEX IF NOT EXISTS idx_chat_sessions_owner_last_message ON chat_sessions(owner_user_id, last_message_at DESC)",

	"CREATE INDEX IF NOT EXISTS idx_chat_sessions_status ON chat_sessions(status)",

	`CREATE INDEX IF NOT EXISTS idx_chat_sessions_pinned_last_message ON chat_sessions(owner_user_id, pinned DESC, last_message_at DESC) WHERE status = 'active'`,

	`CREATE TABLE IF NOT EXISTS chat_messages (
		id TEXT PRIMARY KEY,
		session_id TEXT NOT NULL REFERENCES chat_sessions(id),
		seq INTEGER NOT NULL,
		parent_seq INTEGER,
		role TEXT NOT NULL,
		content_json TEXT NOT NULL,
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		completed_at TEXT,
		status TEXT NOT NULL DEFAULT 'committed',
		stop_reason TEXT,
		input_tokens INTEGER,
		output_tokens INTEGER,
		cost_usd REAL,
		model TEXT,
		error_text TEXT,
		UNIQUE(session_id, seq)
	)`,

	"CREATE INDEX IF NOT EXISTS idx_chat_messages_session_seq ON chat_messages(session_id, seq)",

	"CREATE INDEX IF NOT EXISTS idx_chat_messages_session_created ON chat_messages(session_id, created_at)",

	`CREATE TABLE IF NOT EXISTS chat_attachments (
		id TEXT PRIMARY KEY,
		session_id TEXT REFERENCES chat_sessions(id),
		message_id TEXT REFERENCES chat_messages(id),
		kind TEXT NOT NULL,
		filename TEXT,
		mime_type TEXT,
		size_bytes INTEGER,
		storage_path TEXT NOT NULL,
		sha256 TEXT,
		uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
		committed_at TEXT
	)`,

	"CREATE INDEX IF NOT EXISTS idx_chat_attachments_session ON chat_attachments(session_id)",

	"CREATE INDEX IF NOT EXISTS idx_chat_attachments_orphan ON chat_attachments(uploaded_at) WHERE committed_at IS NULL",

	`CREATE TABLE IF NOT EXISTS chat_stream_events (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		session_id TEXT NOT NULL REFERENCES chat_sessions(id),
		message_id TEXT REFERENCES chat_messages(id),
		seq INTEGER NOT NULL,
		event_type TEXT NOT NULL,
		payload_json TEXT NOT NULL,
		created_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`,

	"CREATE INDEX IF NOT EXISTS idx_chat_stream_events_session_seq ON chat_stream_events(session_id, seq)",

	// -- Auth & Notifications Migrations (40-43) --

	`CREATE TABLE IF NOT EXISTS first_run_state (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		email_sent_at TEXT,
		stdout_printed_at TEXT,
		bootstrap_magic_hash TEXT
	)`,

	`CREATE TABLE IF NOT EXISTS chat_push_subscriptions (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		endpoint TEXT NOT NULL,
		p256dh TEXT NOT NULL,
		auth TEXT NOT NULL,
		user_agent TEXT,
		disabled INTEGER NOT NULL DEFAULT 0,
		consecutive_errors INTEGER NOT NULL DEFAULT 0,
		last_success_at TEXT,
		last_error_at TEXT,
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		updated_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`,

	"CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_push_subscriptions_endpoint ON chat_push_subscriptions(endpoint)",

	"CREATE INDEX IF NOT EXISTS idx_chat_push_subscriptions_user ON chat_push_subscriptions(disabled, created_at)",

	// PR4 dashboard: scheduler action audit log. Every create/pause/resume/run/
	// delete from the UI API writes a row here so the operator can see the
	// history of what was scheduled, paused, run, or removed. Agent-originated
	// writes via phantom_schedule bypass this path; a future PR may hook the
	// service layer directly.
	`CREATE TABLE IF NOT EXISTS scheduler_audit_log (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		job_id TEXT NOT NULL,
		job_name TEXT,
		action TEXT NOT NULL,
		previous_status TEXT,
		new_status TEXT,
		actor TEXT NOT NULL,
		detail TEXT,
		created_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`,

	"CREATE INDEX IF NOT EXISTS idx_scheduler_audit_log_job ON scheduler_audit_log(job_id, id DESC)",

	// PR6 dashboard: the Settings page is moving from ~/.claude/settings.json
	// to config/phantom.yaml. Rows written by the new phantom-config endpoint
	// carry a section tag (identity, model_cost, evolution, channels, memory,
	// permissions) so the UI can group history by section without string
	// matching. Existing rows remain NULL for `section`; they render under a
	// "legacy" label in the audit drawer.
	"ALTER TABLE settings_audit_log ADD COLUMN section TEXT",
];
