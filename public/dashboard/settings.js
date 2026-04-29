// Settings tab: operator-tunable phantom.yaml surface grouped into six
// sections (identity, model + cost, evolution, channels, memory, permissions),
// with a bottom audit drawer. Backed by GET/PUT /ui/api/phantom-config.
//
// Module contract: registers with PhantomDashboard via registerRoute('settings').
// mount(container, arg, ctx) receives the shell context (esc, api, toast,
// openModal, navigate, setBreadcrumb, registerDirtyChecker, deepEqual).
//
// Cardinal Rule: the Save flow is a boring form POST. Nothing on this page
// classifies, detects, or parses natural language. Operator types; we POST.

(function () {
	var MODEL_CHOICES = [
		{ value: "claude-opus-4-7", label: "claude-opus-4-7 (flagship, highest cost)" },
		{ value: "claude-sonnet-4-7", label: "claude-sonnet-4-7 (balanced, default for most deployments)" },
		{ value: "claude-haiku-4-5", label: "claude-haiku-4-5 (fastest, lowest cost)" },
	];
	var EFFORT_CHOICES = ["low", "medium", "high", "max"];
	var PERMISSION_MODES = [
		{ value: "default", label: "default (prompt the user)" },
		{ value: "acceptEdits", label: "acceptEdits (auto-accept file edits)" },
		{ value: "bypassPermissions", label: "bypassPermissions (agent proceeds without prompting)" },
	];
	var REFLECTION_CHOICES = [
		{ value: "auto", label: "auto (enable when an SDK credential is present)" },
		{ value: "always", label: "always on" },
		{ value: "never", label: "always off" },
	];
	var CADENCE_PRESETS = [30, 60, 180, 360, 1440];

	// Section metadata. Order matters; this is the render order.
	var SECTIONS = [
		{
			key: "identity",
			title: "Identity",
			help: "Agent name, role, and public URL. Identity changes take effect on restart.",
			saveLabel: "Save (restart required)",
		},
		{
			key: "model_cost",
			title: "Model and cost",
			help: "Which model the agent uses, how hard it thinks, and the ceiling on spend. Restart required for changes to take effect.",
			saveLabel: "Save (restart required)",
		},
		{
			key: "evolution",
			title: "Evolution",
			help: "Cadence of the self-evolution reflection loop. Saved to phantom.yaml; restart required for the running engine to pick up new values.",
			saveLabel: "Save (restart required)",
		},
		{
			key: "channels",
			title: "Channels",
			help: "Pause or resume each channel without removing its credentials. Secrets live in .env and channels.yaml, not here. Restart required.",
			saveLabel: "Save (restart required)",
		},
		{
			key: "memory",
			title: "Memory",
			help: "Qdrant and Ollama endpoints plus per-query context limits. Restart required for changes to take effect.",
			saveLabel: "Save (restart required)",
		},
		{
			key: "permissions",
			title: "Permissions",
			help: "Tool access control: default policy, allow list, deny list. Live on the next message.",
			saveLabel: "Save",
		},
	];

	var state = {
		loading: true,
		initialized: false,
		error: null,
		full: null,
		sections: makeEmptySections(),
		audit: { entries: null, loading: false, error: null, expanded: false, loaded: false },
		lastModifiedAt: null,
		lastModifiedBy: null,
		avatar: {
			// URL used by the <img>. Bumped with ?v=<cacheBust> after upload so
			// the browser cache does not show the prior image. Starts as null
			// until the first probe resolves.
			url: null,
			probing: false,
			uploading: false,
			resetting: false,
			cacheBust: 0,
			lastError: null,
			// Tracks whether the HEAD probe has ever succeeded this session.
			// Drives the visibility of the Reset button.
			exists: null,
			displayName: "",
		},
	};
	var ctx = null;
	var root = null;

	function makeEmptySections() {
		var map = {};
		SECTIONS.forEach(function (s) {
			map[s.key] = { draft: null, initial: null, errors: {}, saving: false };
		});
		return map;
	}

	function esc(s) { return ctx.esc(s); }

	// ----- data shape conversion ------------------------------------------
	// Split the full UI config into the six editable section drafts. Each
	// draft is a shallow copy so mutating one does not echo into another.

	function splitFullIntoSections(full) {
		return {
			identity: {
				name: full.name || "",
				role: full.role || "",
				public_url: full.public_url || "",
				domain: full.domain || "",
			},
			model_cost: {
				model: full.model || "",
				effort: full.effort || "max",
				judge_model: full.judge_model || "",
				max_budget_usd: typeof full.max_budget_usd === "number" ? full.max_budget_usd : 0,
				timeout_minutes: typeof full.timeout_minutes === "number" ? full.timeout_minutes : 240,
			},
			evolution: {
				reflection_enabled: (full.evolution && full.evolution.reflection_enabled) || "auto",
				cadence_minutes: full.evolution ? full.evolution.cadence_minutes : 180,
				demand_trigger_depth: full.evolution ? full.evolution.demand_trigger_depth : 5,
			},
			channels: {
				slack: !!(full.channels && full.channels.slack && full.channels.slack.enabled),
				telegram: !!(full.channels && full.channels.telegram && full.channels.telegram.enabled),
				email: !!(full.channels && full.channels.email && full.channels.email.enabled),
				webhook: !!(full.channels && full.channels.webhook && full.channels.webhook.enabled),
			},
			memory: {
				qdrant_url: (full.memory && full.memory.qdrant_url) || "",
				ollama_url: (full.memory && full.memory.ollama_url) || "",
				embedding_model: (full.memory && full.memory.embedding_model) || "",
				episode_limit: full.memory ? full.memory.episode_limit : 10,
				fact_limit: full.memory ? full.memory.fact_limit : 20,
				procedure_limit: full.memory ? full.memory.procedure_limit : 5,
			},
			permissions: {
				default_mode: (full.permissions && full.permissions.default_mode) || "bypassPermissions",
				allow: (full.permissions && Array.isArray(full.permissions.allow)) ? full.permissions.allow.slice() : [],
				deny: (full.permissions && Array.isArray(full.permissions.deny)) ? full.permissions.deny.slice() : [],
			},
		};
	}

	// Translate a section's draft into the PUT payload slice the backend expects.
	function draftToPutPayload(sectionKey, draft) {
		if (sectionKey === "identity") {
			return {
				name: draft.name.trim(),
				role: draft.role.trim(),
				public_url: draft.public_url.trim() ? draft.public_url.trim() : null,
				domain: draft.domain.trim() ? draft.domain.trim() : null,
			};
		}
		if (sectionKey === "model_cost") {
			return {
				model: draft.model.trim(),
				effort: draft.effort,
				judge_model: draft.judge_model.trim() ? draft.judge_model.trim() : null,
				max_budget_usd: Number(draft.max_budget_usd),
				timeout_minutes: Number(draft.timeout_minutes),
			};
		}
		if (sectionKey === "evolution") {
			return {
				evolution: {
					reflection_enabled: draft.reflection_enabled,
					cadence_minutes: Number(draft.cadence_minutes),
					demand_trigger_depth: Number(draft.demand_trigger_depth),
				},
			};
		}
		if (sectionKey === "channels") {
			return {
				channels: {
					slack: { enabled: !!draft.slack },
					telegram: { enabled: !!draft.telegram },
					email: { enabled: !!draft.email },
					webhook: { enabled: !!draft.webhook },
				},
			};
		}
		if (sectionKey === "memory") {
			return {
				memory: {
					qdrant_url: draft.qdrant_url.trim(),
					ollama_url: draft.ollama_url.trim(),
					embedding_model: draft.embedding_model.trim(),
					episode_limit: Number(draft.episode_limit),
					fact_limit: Number(draft.fact_limit),
					procedure_limit: Number(draft.procedure_limit),
				},
			};
		}
		if (sectionKey === "permissions") {
			return {
				permissions: {
					default_mode: draft.default_mode,
					allow: draft.allow.slice(),
					deny: draft.deny.slice(),
				},
			};
		}
		return {};
	}

	// ----- dirty tracking -------------------------------------------------

	function isSectionDirty(sectionKey) {
		var s = state.sections[sectionKey];
		if (!s || !s.initial || !s.draft) return false;
		return !ctx.deepEqual(s.initial, s.draft);
	}

	function isAnyDirty() {
		for (var i = 0; i < SECTIONS.length; i++) {
			if (isSectionDirty(SECTIONS[i].key)) return true;
		}
		return false;
	}

	// ----- render primitives ---------------------------------------------

	function renderHeader() {
		var lastMod = "";
		if (state.lastModifiedAt) {
			lastMod = ' <span class="dash-source-chip dash-source-chip-user">last edit ' + esc(state.lastModifiedAt) + '</span>';
		}
		var dirty = isAnyDirty();
		var dirtyBadge = dirty ? ' <span class="dash-source-chip dash-source-chip-agent">unsaved</span>' : "";
		return (
			'<div class="dash-header">' +
			'<p class="dash-header-eyebrow">Settings</p>' +
			'<h1 class="dash-header-title">Settings' + dirtyBadge + lastMod + '</h1>' +
			'<p class="dash-header-lead">Operator-facing configuration over <code>config/phantom.yaml</code>. Identity, cost, evolution cadence, channels, memory, and tool permissions. Secrets stay in <code>.env</code>.</p>' +
			'</div>'
		);
	}

	function fieldBlock(labelHtml, controlHtml, hintHtml, errorId) {
		return (
			'<div class="dash-field">' +
			'<label class="dash-field-label">' + labelHtml + '</label>' +
			controlHtml +
			(hintHtml ? '<p class="dash-field-hint">' + hintHtml + '</p>' : "") +
			'<div class="dash-field-error" role="alert" id="' + errorId + '" hidden></div>' +
			'</div>'
		);
	}

	function selectHtml(path, value, options, sectionKey) {
		var opts = options.map(function (o) {
			var v = typeof o === "string" ? o : o.value;
			var l = typeof o === "string" ? o : o.label;
			var sel = v === value ? " selected" : "";
			return '<option value="' + esc(v) + '"' + sel + '>' + esc(l) + '</option>';
		}).join("");
		return '<select class="dash-select" data-section="' + esc(sectionKey) + '" data-path="' + esc(path) + '">' + opts + '</select>';
	}

	function textInputHtml(path, value, sectionKey, placeholder, type) {
		var t = type || "text";
		return (
			'<input class="dash-input" type="' + t + '" data-section="' + esc(sectionKey) + '" data-path="' + esc(path) + '"' +
			' value="' + esc(value == null ? "" : String(value)) + '"' +
			(placeholder ? ' placeholder="' + esc(placeholder) + '"' : "") +
			'>'
		);
	}

	function numberInputHtml(path, value, sectionKey, min, max, step) {
		return (
			'<input class="dash-input" type="number" data-section="' + esc(sectionKey) + '" data-path="' + esc(path) + '"' +
			' value="' + esc(value == null ? "" : String(value)) + '"' +
			(min != null ? ' min="' + min + '"' : "") +
			(max != null ? ' max="' + max + '"' : "") +
			(step != null ? ' step="' + step + '"' : "") +
			'>'
		);
	}

	function toggleHtml(path, value, sectionKey, label, disabled) {
		return (
			'<label class="dash-toggle">' +
			'<input type="checkbox" data-section="' + esc(sectionKey) + '" data-path="' + esc(path) + '"' +
			(value ? " checked" : "") +
			(disabled ? " disabled" : "") +
			'>' +
			'<span class="dash-toggle-track"></span>' +
			'<span>' + esc(label) + '</span>' +
			'</label>'
		);
	}

	function chipsHtml(path, values, sectionKey, placeholder) {
		var arr = Array.isArray(values) ? values : [];
		var chips = arr.map(function (v, i) {
			return (
				'<span class="dash-chip"><span>' + esc(v) + '</span>' +
				'<button type="button" data-chip-remove="' + esc(sectionKey) + ':' + esc(path) + ':' + i + '" aria-label="Remove ' + esc(v) + '">&times;</button>' +
				'</span>'
			);
		}).join("");
		return (
			'<div class="dash-chips" data-chips-for="' + esc(sectionKey) + ':' + esc(path) + '">' +
			chips +
			'<input type="text" data-chip-input-for="' + esc(sectionKey) + ':' + esc(path) + '" placeholder="' + esc(placeholder || "") + '">' +
			'</div>'
		);
	}

	function roleOptions() {
		// Role list is limited; two ship today. Future roles get added by the
		// registry and will show up through a separate fetch.
		return [
			{ value: "swe", label: "Software Engineer (swe)" },
			{ value: "base", label: "Base (base)" },
		];
	}

	// ----- section renderers --------------------------------------------

	function renderIdentity() {
		var d = state.sections.identity.draft;
		var errs = state.sections.identity.errors;
		return (
			'<div class="dash-form">' +
			fieldBlock(
				'Agent name',
				textInputHtml("name", d.name, "identity", "phantom"),
				'The agent\u2019s display name. Appears in email headers, Slack, PWA manifest.',
				"err-identity-name"
			) +
			fieldBlock(
				'Role',
				selectHtml("role", d.role, roleOptions(), "identity"),
				'The role template that drives the agent\u2019s prompt and onboarding questions.',
				"err-identity-role"
			) +
			fieldBlock(
				'Public URL',
				textInputHtml("public_url", d.public_url, "identity", "https://me.ghostwright.dev"),
				'Fully qualified base URL. Overrides the subdomain-based derivation.',
				"err-identity-public_url"
			) +
			fieldBlock(
				'Subdomain root',
				textInputHtml("domain", d.domain, "identity", "ghostwright.dev"),
				'When Public URL is empty, the server derives <code>https://{name}.{domain}</code> at boot.',
				"err-identity-domain"
			) +
			'</div>'
		) + renderInlineErrors("identity", errs);
	}

	function renderModelCost() {
		var d = state.sections.model_cost.draft;
		var errs = state.sections.model_cost.errors;
		// If the stored model is not in the known list, render a free-form input.
		var known = MODEL_CHOICES.some(function (c) { return c.value === d.model; });
		var modelControl = known
			? selectHtml("model", d.model, MODEL_CHOICES.concat([{ value: d.model === "" ? "claude-opus-4-7" : d.model, label: "Custom: type in the override field" }]), "model_cost")
			: textInputHtml("model", d.model, "model_cost", "claude-opus-4-7");
		var judgeChoices = [{ value: "", label: "Same as main agent" }].concat(MODEL_CHOICES);
		return (
			'<div class="dash-form">' +
			fieldBlock(
				'Model',
				modelControl,
				'Claude model id the agent runs. Unknown values fall back to a free-form input.',
				"err-model_cost-model"
			) +
			fieldBlock(
				'Effort',
				selectHtml("effort", d.effort, EFFORT_CHOICES, "model_cost"),
				'SDK effort knob. <code>max</code> is the default; <code>low</code> is the cheapest.',
				"err-model_cost-effort"
			) +
			fieldBlock(
				'Judge model',
				selectHtml("judge_model", d.judge_model || "", judgeChoices, "model_cost"),
				'Model used by evolution judges. A cheaper judge model lets Phantom evolve often without spending Opus dollars.',
				"err-model_cost-judge_model"
			) +
			fieldBlock(
				'Max budget (USD)',
				numberInputHtml("max_budget_usd", d.max_budget_usd, "model_cost", 0, 100000, "0.01"),
				'Safety ceiling per session, in US dollars. <code>0</code> means unlimited.',
				"err-model_cost-max_budget_usd"
			) +
			fieldBlock(
				'Timeout (minutes)',
				numberInputHtml("timeout_minutes", d.timeout_minutes, "model_cost", 1, 1440, "1"),
				'Ceiling on individual query duration before the runtime aborts.',
				"err-model_cost-timeout_minutes"
			) +
			'</div>'
		) + renderInlineErrors("model_cost", errs);
	}

	function renderEvolution() {
		var d = state.sections.evolution.draft;
		var errs = state.sections.evolution.errors;
		var presetChips = CADENCE_PRESETS.map(function (p) {
			var active = Number(d.cadence_minutes) === p ? " aria-current=\"true\"" : "";
			return '<button type="button" class="dash-btn dash-btn-chip" data-cadence-preset="' + p + '"' + active + '>' + p + ' min</button>';
		}).join(" ");
		return (
			'<div class="dash-form">' +
			fieldBlock(
				'Reflection',
				selectHtml("reflection_enabled", d.reflection_enabled, REFLECTION_CHOICES, "evolution"),
				'Whether the reflection subprocess runs between sessions. Requires restart.',
				"err-evolution-reflection_enabled"
			) +
			fieldBlock(
				'Cadence (minutes)',
				numberInputHtml("cadence_minutes", d.cadence_minutes, "evolution", 1, 10080, "1") +
					'<div style="margin-top: var(--space-2); display: flex; flex-wrap: wrap; gap: 6px;">' + presetChips + '</div>',
				'How often the evolution queue drains and reflection runs. Saves to <code>phantom-config/meta/evolution.json</code>; restart required for the running cadence to pick up the new value.',
				"err-evolution-cadence_minutes"
			) +
			fieldBlock(
				'Demand trigger depth',
				numberInputHtml("demand_trigger_depth", d.demand_trigger_depth, "evolution", 1, 1000, "1"),
				'When this many sessions queue up, an immediate drain fires instead of waiting for the cadence window.',
				"err-evolution-demand_trigger_depth"
			) +
			'</div>'
		) + renderInlineErrors("evolution", errs);
	}

	function renderChannels() {
		var d = state.sections.channels.draft;
		var errs = state.sections.channels.errors;
		// Every toggle is a simple on/off; the inline hint tells the user
		// where to configure secrets (`.env`, `channels.yaml`).
		return (
			'<div class="dash-form">' +
			fieldBlock(
				'Slack',
				toggleHtml("slack", d.slack, "channels", d.slack ? "on" : "off"),
				'Tokens: <code>SLACK_BOT_TOKEN</code>, <code>SLACK_APP_TOKEN</code> in <code>.env</code>. Owner user id in <code>channels.yaml</code>.',
				"err-channels-slack"
			) +
			fieldBlock(
				'Telegram',
				toggleHtml("telegram", d.telegram, "channels", d.telegram ? "on" : "off"),
				'Token: <code>TELEGRAM_BOT_TOKEN</code> in <code>.env</code>.',
				"err-channels-telegram"
			) +
			fieldBlock(
				'Email',
				toggleHtml("email", d.email, "channels", d.email ? "on" : "off"),
				'IMAP + SMTP credentials in <code>channels.yaml</code>, mapped from <code>.env</code>.',
				"err-channels-email"
			) +
			fieldBlock(
				'Webhook',
				toggleHtml("webhook", d.webhook, "channels", d.webhook ? "on" : "off"),
				'Shared secret in <code>channels.yaml</code>, mapped from <code>.env</code>.',
				"err-channels-webhook"
			) +
			'</div>'
		) + renderInlineErrors("channels", errs);
	}

	function renderMemory() {
		var d = state.sections.memory.draft;
		var errs = state.sections.memory.errors;
		return (
			'<div class="dash-form">' +
			fieldBlock(
				'Qdrant URL',
				textInputHtml("qdrant_url", d.qdrant_url, "memory", "http://localhost:6333"),
				'Vector store endpoint. Must be reachable from the agent container.',
				"err-memory-qdrant_url"
			) +
			fieldBlock(
				'Ollama URL',
				textInputHtml("ollama_url", d.ollama_url, "memory", "http://localhost:11434"),
				'Embedding service endpoint.',
				"err-memory-ollama_url"
			) +
			fieldBlock(
				'Embedding model',
				textInputHtml("embedding_model", d.embedding_model, "memory", "nomic-embed-text"),
				'Ollama model id used for embeddings.',
				"err-memory-embedding_model"
			) +
			fieldBlock(
				'Episodes per query',
				numberInputHtml("episode_limit", d.episode_limit, "memory", 1, 500, "1"),
				'Maximum episodic memories retrieved into each query\u2019s context.',
				"err-memory-episode_limit"
			) +
			fieldBlock(
				'Facts per query',
				numberInputHtml("fact_limit", d.fact_limit, "memory", 1, 1000, "1"),
				'Maximum semantic facts retrieved per query.',
				"err-memory-fact_limit"
			) +
			fieldBlock(
				'Procedures per query',
				numberInputHtml("procedure_limit", d.procedure_limit, "memory", 1, 500, "1"),
				'Maximum procedural memories retrieved per query.',
				"err-memory-procedure_limit"
			) +
			'</div>'
		) + renderInlineErrors("memory", errs);
	}

	function renderPermissions() {
		var d = state.sections.permissions.draft;
		var errs = state.sections.permissions.errors;
		return (
			'<div class="dash-form">' +
			fieldBlock(
				'Default mode',
				selectHtml("default_mode", d.default_mode, PERMISSION_MODES, "permissions"),
				'Policy when no allow/deny rule matches. <code>bypassPermissions</code> is the Phantom default.',
				"err-permissions-default_mode"
			) +
			fieldBlock(
				'Allow',
				chipsHtml("allow", d.allow, "permissions", "add and press enter, e.g. Bash(git:*)"),
				'Patterns matching tool invocations that should proceed without prompting.',
				"err-permissions-allow"
			) +
			fieldBlock(
				'Deny',
				chipsHtml("deny", d.deny, "permissions", "add and press enter, e.g. Bash(rm:*)"),
				'Patterns that are always blocked, even when the allow list matches.',
				"err-permissions-deny"
			) +
			'</div>'
		) + renderInlineErrors("permissions", errs);
	}

	function renderInlineErrors(sectionKey, errors) {
		// Top-level errors that do not map to a specific field render below
		// the form. Per-field errors render inside fieldBlock error slots.
		if (!errors || !errors.__global) return "";
		return '<p class="dash-field-error" role="alert" style="margin-top: var(--space-2);">' + esc(errors.__global) + '</p>';
	}

	function sectionBodyHtml(sectionKey) {
		if (sectionKey === "identity") return renderIdentity();
		if (sectionKey === "model_cost") return renderModelCost();
		if (sectionKey === "evolution") return renderEvolution();
		if (sectionKey === "channels") return renderChannels();
		if (sectionKey === "memory") return renderMemory();
		if (sectionKey === "permissions") return renderPermissions();
		return "";
	}

	// ----- Identity > Avatar custom card --------------------------------
	// The avatar is operator-visual state (not a phantom.yaml key) so it has
	// its own upload/delete endpoint at /ui/api/identity/avatar. This card
	// renders as a preamble to the six-section form. It owns its cacheBust
	// counter so the preview img swaps instantly after a successful POST.

	function avatarInitialLetter() {
		var d = state.avatar.displayName || (state.sections.identity.draft && state.sections.identity.draft.name) || "P";
		var s = String(d).trim();
		if (!s) return "P";
		return s.charAt(0).toUpperCase();
	}

	function avatarPreviewHtml() {
		var a = state.avatar;
		var letter = avatarInitialLetter();
		var url = a.url ? a.url + (a.cacheBust ? "?v=" + a.cacheBust : "") : null;
		var hidden = a.exists === false;
		var imgDisplay = hidden ? "none" : "block";
		var letterDisplay = hidden ? "inline-flex" : "none";
		var img = '<img id="dash-avatar-img" class="dash-avatar-preview"' +
			' src="' + esc(url || "/ui/avatar") + '"' +
			' alt=""' +
			' style="display:' + imgDisplay + '">';
		var fallback = '<span id="dash-avatar-letter" class="dash-avatar-preview-letter"' +
			' style="display:' + letterDisplay + '">' + esc(letter) + '</span>';
		return '<div class="dash-avatar-preview-wrap">' + img + fallback + '</div>';
	}

	function avatarActionsHtml() {
		var a = state.avatar;
		var uploadLabel = a.uploading ? "Uploading..." : "Choose image";
		var resetLabel = a.resetting ? "Removing..." : "Reset to letter";
		var resetBtn = a.exists
			? '<button type="button" id="dash-avatar-reset" class="dash-btn dash-btn-ghost"' +
				(a.resetting || a.uploading ? " disabled" : "") +
				">" + esc(resetLabel) + "</button>"
			: "";
		return (
			'<div class="dash-identity-actions">' +
			'<button type="button" id="dash-avatar-choose" class="dash-btn dash-btn-primary"' +
				(a.uploading ? " disabled" : "") +
				">" + esc(uploadLabel) + "</button>" +
			'<input type="file" id="dash-avatar-file" accept="image/png,image/jpeg,image/webp" hidden>' +
			resetBtn +
			"</div>"
		);
	}

	function avatarCardHtml() {
		var a = state.avatar;
		var errorBlock = a.lastError
			? '<div class="dash-field-error" role="alert" style="display:block;margin-top:var(--space-2);">' + esc(a.lastError) + "</div>"
			: "";
		return (
			'<section class="dash-settings-section" data-section-root="brand_avatar">' +
			"<header>" +
			'<h2 class="dash-hook-event-title">Identity</h2>' +
			'<p class="dash-hook-event-summary">Upload a logo and it replaces the first-letter badge on the landing, dashboard, chat, login, and every page your agent generates. Stored as a single file on disk; served with a 5-minute cache.</p>' +
			"</header>" +
			'<div class="dash-identity-card">' +
			avatarPreviewHtml() +
			'<div>' +
			'<div id="dash-avatar-drop" class="dash-avatar-drop" tabindex="0" role="button" aria-label="Drop an image here or choose a file"><strong>Drop an image</strong> here, or choose one. PNG, JPEG, or WebP, up to 2 MB. We scale it to 256x256 before upload.</div>' +
			avatarActionsHtml() +
			errorBlock +
			'<div class="dash-identity-guidance">' +
			'<p>Your image appears in the navbar, chat header, sidebar, push notifications, the PWA home-screen icon, and the browser favicon.</p>' +
			'<p class="dash-identity-slack">To change the Slack avatar, edit the icon in your Slack app settings at <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer noopener">api.slack.com/apps</a>.</p>' +
			'<p>If you installed the chat as a PWA, the home-screen icon may cache. Re-install or wait for the OS to refresh.</p>' +
			"</div>" +
			"</div>" +
			"</div>" +
			"</section>"
		);
	}

	function probeAvatar() {
		if (state.avatar.probing) return;
		state.avatar.probing = true;
		fetch("/ui/avatar", { method: "GET", credentials: "same-origin", cache: "no-store" })
			.then(function (r) {
				state.avatar.probing = false;
				state.avatar.exists = r.ok;
				state.avatar.url = r.ok ? "/ui/avatar" : null;
				render();
			})
			.catch(function () {
				state.avatar.probing = false;
				state.avatar.exists = false;
				render();
			});
	}

	function resizeToBlob(file) {
		// cover-fit to 256x256, encode as PNG (preserves transparency).
		return createImageBitmap(file).then(function (bitmap) {
			var canvas = document.createElement("canvas");
			canvas.width = 256; canvas.height = 256;
			var ctx2d = canvas.getContext("2d");
			if (!ctx2d) throw new Error("Canvas 2d context unavailable");
			var ratio = Math.max(256 / bitmap.width, 256 / bitmap.height);
			var w = bitmap.width * ratio;
			var h = bitmap.height * ratio;
			ctx2d.clearRect(0, 0, 256, 256);
			ctx2d.drawImage(bitmap, (256 - w) / 2, (256 - h) / 2, w, h);
			return new Promise(function (resolve, reject) {
				canvas.toBlob(function (blob) { blob ? resolve(blob) : reject(new Error("Canvas encode failed")); }, "image/png", 0.92);
			});
		});
	}

	function postAvatarBlob(blob) {
		var form = new FormData();
		form.append("file", blob, "avatar.png");
		return fetch("/ui/api/identity/avatar", {
			method: "POST",
			credentials: "same-origin",
			body: form,
		}).then(function (res) {
			if (!res.ok) {
				return res.json().then(function (body) {
					throw new Error((body && body.error) || ("Upload failed (" + res.status + ")"));
				}, function () {
					throw new Error("Upload failed (" + res.status + ")");
				});
			}
			return res.json();
		});
	}

	function beginUpload(file) {
		if (!file) return;
		if (state.avatar.uploading) return;
		state.avatar.lastError = null;
		// Client-side size guard matches the server cap (2MB at content-length).
		if (file.size > 2 * 1024 * 1024) {
			state.avatar.lastError = "Image is larger than 2 MB. Please choose a smaller file.";
			render();
			return;
		}
		var allowed = ["image/png", "image/jpeg", "image/webp"];
		if (allowed.indexOf(file.type) < 0) {
			state.avatar.lastError = "Unsupported image type. Use PNG, JPEG, or WebP.";
			render();
			return;
		}
		state.avatar.uploading = true;
		render();
		resizeToBlob(file)
			.then(postAvatarBlob)
			.then(function () {
				state.avatar.uploading = false;
				state.avatar.exists = true;
				state.avatar.url = "/ui/avatar";
				state.avatar.cacheBust = state.avatar.cacheBust + 1;
				state.avatar.lastError = null;
				ctx.toast("success", "Avatar updated", "Your logo is live across every surface.");
				// Repaint surrounding navbar in-place by notifying the IIFE.
				try {
					window.dispatchEvent(new CustomEvent("phantom:avatar-updated", { detail: { url: "/ui/avatar" } }));
				} catch (e) {}
				render();
			})
			.catch(function (err) {
				state.avatar.uploading = false;
				state.avatar.lastError = (err && err.message) || String(err);
				render();
			});
	}

	function askResetAvatar() {
		var body = document.createElement("div");
		var p = document.createElement("p");
		p.style.margin = "0 0 var(--space-2)";
		p.textContent = "Remove the uploaded avatar and fall back to the letter badge?";
		var info = document.createElement("p");
		info.className = "phantom-muted";
		info.style.margin = "0";
		info.style.fontSize = "12px";
		info.textContent = "You can upload a new image any time.";
		body.appendChild(p);
		body.appendChild(info);
		ctx.openModal({
			title: "Reset avatar?",
			body: body,
			actions: [
				{ label: "Keep avatar", className: "dash-btn-ghost" },
				{
					label: "Reset",
					className: "dash-btn-danger",
					onClick: function () { confirmResetAvatar(); return true; },
				},
			],
		});
	}

	function confirmResetAvatar() {
		if (state.avatar.resetting) return;
		state.avatar.resetting = true;
		render();
		fetch("/ui/api/identity/avatar", { method: "DELETE", credentials: "same-origin" })
			.then(function (res) {
				state.avatar.resetting = false;
				if (!res.ok && res.status !== 204) {
					throw new Error("Reset failed (" + res.status + ")");
				}
				state.avatar.exists = false;
				state.avatar.url = null;
				state.avatar.cacheBust = state.avatar.cacheBust + 1;
				ctx.toast("success", "Avatar removed", "The letter badge is showing again everywhere.");
				try {
					window.dispatchEvent(new CustomEvent("phantom:avatar-updated", { detail: { url: null } }));
				} catch (e) {}
				render();
			})
			.catch(function (err) {
				state.avatar.resetting = false;
				state.avatar.lastError = (err && err.message) || String(err);
				render();
			});
	}

	function wireAvatarCard() {
		var chooseBtn = document.getElementById("dash-avatar-choose");
		var fileInput = document.getElementById("dash-avatar-file");
		var resetBtn = document.getElementById("dash-avatar-reset");
		var drop = document.getElementById("dash-avatar-drop");
		var img = document.getElementById("dash-avatar-img");
		var letter = document.getElementById("dash-avatar-letter");

		if (chooseBtn && fileInput) {
			chooseBtn.addEventListener("click", function () { fileInput.click(); });
			fileInput.addEventListener("change", function () {
				var f = fileInput.files && fileInput.files[0];
				if (f) beginUpload(f);
				fileInput.value = "";
			});
		}
		if (resetBtn) {
			resetBtn.addEventListener("click", function () { askResetAvatar(); });
		}
		if (drop) {
			drop.addEventListener("dragenter", function (e) { e.preventDefault(); drop.setAttribute("data-drag", "true"); });
			drop.addEventListener("dragover", function (e) { e.preventDefault(); drop.setAttribute("data-drag", "true"); });
			drop.addEventListener("dragleave", function () { drop.removeAttribute("data-drag"); });
			drop.addEventListener("drop", function (e) {
				e.preventDefault();
				drop.removeAttribute("data-drag");
				var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
				if (f) beginUpload(f);
			});
			drop.addEventListener("keydown", function (e) {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					if (fileInput) fileInput.click();
				}
			});
			drop.addEventListener("click", function () { if (fileInput) fileInput.click(); });
		}
		if (img) {
			img.addEventListener("load", function () {
				state.avatar.exists = true;
				if (letter) letter.style.display = "none";
				img.style.display = "block";
			});
			img.addEventListener("error", function () {
				state.avatar.exists = false;
				img.style.display = "none";
				if (letter) letter.style.display = "inline-flex";
			});
		}
	}

	function renderSection(meta) {
		var sec = state.sections[meta.key];
		var dirty = isSectionDirty(meta.key);
		var saving = sec.saving;
		var dirtyBadge = dirty ? '<span class="dash-source-chip dash-source-chip-agent">dirty</span>' : "";
		var saveBtn = '<button class="dash-btn dash-btn-primary" data-save-section="' + esc(meta.key) + '"' +
			(dirty && !saving ? "" : " disabled") + '>' +
			(saving ? "Saving..." : esc(meta.saveLabel)) +
			'</button>';
		var discardBtn = '<button class="dash-btn dash-btn-ghost" data-discard-section="' + esc(meta.key) + '"' +
			(dirty && !saving ? "" : " disabled") + '>Discard</button>';
		return (
			'<section class="dash-settings-section" data-section-root="' + esc(meta.key) + '">' +
			'<header>' +
			'<h2 class="dash-hook-event-title">' + esc(meta.title) + ' ' + dirtyBadge + '</h2>' +
			'<p class="dash-hook-event-summary">' + meta.help + '</p>' +
			'</header>' +
			sectionBodyHtml(meta.key) +
			'<div class="dash-settings-section-actions">' + discardBtn + saveBtn + '</div>' +
			'</section>'
		);
	}

	function renderAuditDrawer() {
		var a = state.audit;
		var rows;
		if (a.loading) rows = '<p class="dash-empty-body">Loading history...</p>';
		else if (a.error) rows = '<p class="dash-field-error" role="alert">' + esc(a.error) + '</p>';
		else if (!a.loaded) rows = '<p class="dash-empty-body">Expand to load recent changes.</p>';
		else if (!a.entries || a.entries.length === 0) rows = '<p class="dash-empty-body">No audit rows yet. Save any section to create one.</p>';
		else rows = a.entries.map(renderAuditRow).join("");
		return (
			'<details class="dash-settings-history" id="settings-audit-details" ' +
			(a.expanded ? "open" : "") + '>' +
			'<summary><h2 class="dash-hook-event-title">Change history</h2></summary>' +
			'<div class="dash-audit-list" id="settings-audit-list">' + rows + '</div>' +
			'</details>'
		);
	}

	function renderAuditRow(entry) {
		var when = entry.created_at || "";
		var who = entry.actor || "user";
		var section = entry.section || "legacy";
		var field = entry.field || "";
		var before = entry.previous_value == null ? "null" : truncateJson(entry.previous_value);
		var after = entry.new_value == null ? "null" : truncateJson(entry.new_value);
		return (
			'<div class="dash-audit-row">' +
			'<div class="dash-audit-row-top">' +
			'<span class="dash-source-chip dash-source-chip-user">' + esc(section) + '</span> ' +
			'<strong>' + esc(field) + '</strong> ' +
			'<span class="phantom-muted">&middot; ' + esc(when) + ' by ' + esc(who) + '</span>' +
			'</div>' +
			'<div class="dash-audit-row-body"><span data-audit-diff>' + esc(before) + ' \u2192 ' + esc(after) + '</span></div>' +
			'</div>'
		);
	}

	function truncateJson(value) {
		if (value == null) return "null";
		if (typeof value === "string" && value.length > 200) return value.slice(0, 200) + "...";
		return String(value);
	}

	// ----- main render ----------------------------------------------------

	function render() {
		if (state.loading) {
			root.innerHTML = renderHeader() + '<div class="dash-empty"><p class="dash-empty-body">Loading settings...</p></div>';
			return;
		}
		if (state.error) {
			root.innerHTML = (
				renderHeader() +
				'<div class="dash-empty"><p class="dash-empty-title">Failed to load</p><p class="dash-empty-body">' +
				esc(state.error) + '</p></div>'
			);
			return;
		}
		root.innerHTML =
			renderHeader() + avatarCardHtml() + SECTIONS.map(renderSection).join("") + renderAuditDrawer();
		wireInputs();
		wireButtons();
		wireAuditDrawer();
		wireAvatarCard();
		// Keep the preview's displayName in sync with the "Agent name" field so
		// the letter fallback reflects typed-but-unsaved edits.
		state.avatar.displayName = (state.sections.identity.draft && state.sections.identity.draft.name) || state.avatar.displayName || "";
		ctx.setBreadcrumb("Settings");
	}

	// ----- input wiring --------------------------------------------------

	function setDraftValue(sectionKey, path, value) {
		var draft = state.sections[sectionKey].draft;
		if (draft == null) return;
		draft[path] = value;
	}

	function wireInputs() {
		var els = document.querySelectorAll("[data-section][data-path]");
		for (var i = 0; i < els.length; i++) {
			(function (el) {
				var sectionKey = el.getAttribute("data-section");
				var path = el.getAttribute("data-path");
				if (el.type === "checkbox") {
					el.addEventListener("change", function () {
						setDraftValue(sectionKey, path, el.checked);
						render();
					});
				} else if (el.tagName === "SELECT") {
					el.addEventListener("change", function () {
						setDraftValue(sectionKey, path, el.value);
						render();
					});
				} else if (el.type === "number") {
					el.addEventListener("input", function () {
						var raw = el.value;
						if (raw === "") { setDraftValue(sectionKey, path, ""); return; }
						var n = Number(raw);
						if (!Number.isFinite(n)) return;
						setDraftValue(sectionKey, path, n);
					});
					el.addEventListener("blur", render);
				} else {
					// Text input. Persist raw value including empty.
					el.addEventListener("input", function () {
						setDraftValue(sectionKey, path, el.value);
					});
					el.addEventListener("blur", render);
				}
			})(els[i]);
		}

		// Chip inputs
		var chipInputs = document.querySelectorAll("[data-chip-input-for]");
		for (var j = 0; j < chipInputs.length; j++) {
			(function (input) {
				var parts = input.getAttribute("data-chip-input-for").split(":");
				var sectionKey = parts[0];
				var path = parts[1];
				input.addEventListener("keydown", function (e) {
					if (e.key === "Enter" || e.key === ",") {
						e.preventDefault();
						var v = input.value.trim().replace(/,$/, "");
						if (!v) return;
						var draft = state.sections[sectionKey].draft;
						var arr = Array.isArray(draft[path]) ? draft[path].slice() : [];
						if (arr.indexOf(v) < 0) arr.push(v);
						draft[path] = arr;
						render();
					}
				});
			})(chipInputs[j]);
		}

		var chipRemoves = document.querySelectorAll("[data-chip-remove]");
		for (var k = 0; k < chipRemoves.length; k++) {
			(function (btn) {
				var parts = btn.getAttribute("data-chip-remove").split(":");
				var sectionKey = parts[0];
				var path = parts[1];
				var idx = parseInt(parts[2], 10);
				btn.addEventListener("click", function () {
					var draft = state.sections[sectionKey].draft;
					var arr = Array.isArray(draft[path]) ? draft[path].slice() : [];
					if (idx >= 0 && idx < arr.length) arr.splice(idx, 1);
					draft[path] = arr;
					render();
				});
			})(chipRemoves[k]);
		}
	}

	function wireButtons() {
		var saveButtons = document.querySelectorAll("[data-save-section]");
		for (var i = 0; i < saveButtons.length; i++) {
			(function (btn) {
				var key = btn.getAttribute("data-save-section");
				btn.addEventListener("click", function () { saveSection(key); });
			})(saveButtons[i]);
		}
		var discardButtons = document.querySelectorAll("[data-discard-section]");
		for (var j = 0; j < discardButtons.length; j++) {
			(function (btn) {
				var key = btn.getAttribute("data-discard-section");
				btn.addEventListener("click", function () { askDiscard(key); });
			})(discardButtons[j]);
		}
		var cadenceButtons = document.querySelectorAll("[data-cadence-preset]");
		for (var k = 0; k < cadenceButtons.length; k++) {
			(function (btn) {
				btn.addEventListener("click", function () {
					var n = parseInt(btn.getAttribute("data-cadence-preset"), 10);
					state.sections.evolution.draft.cadence_minutes = n;
					render();
				});
			})(cadenceButtons[k]);
		}
	}

	// ----- save / discard -----------------------------------------------

	function clearErrors(sectionKey) {
		state.sections[sectionKey].errors = {};
	}

	function applyServerError(sectionKey, errBody) {
		var msg = (errBody && errBody.message) || (errBody && errBody.toString && errBody.toString()) || "Save failed";
		var field = (errBody && errBody.field) || null;
		var errs = {};
		if (field) {
			// field looks like "memory.qdrant_url" or "max_budget_usd". Normalize
			// to a simple error map keyed by local field name.
			var localKey = field.indexOf(".") >= 0 ? field.slice(field.lastIndexOf(".") + 1) : field;
			errs[localKey] = msg;
		} else {
			errs.__global = msg;
		}
		state.sections[sectionKey].errors = errs;
	}

	function saveSection(sectionKey) {
		var sec = state.sections[sectionKey];
		if (!sec || !isSectionDirty(sectionKey) || sec.saving) return;
		sec.saving = true;
		clearErrors(sectionKey);
		render();
		var payload = draftToPutPayload(sectionKey, sec.draft);
		ctx.api("PUT", "/ui/api/phantom-config", payload)
			.then(function (res) {
				sec.saving = false;
				if (res && res.config) {
					hydrate(res.config, { last_modified_at: new Date().toISOString(), last_modified_by: "user" });
				}
				ctx.toast("success", "Saved", SECTIONS.find(function (m) { return m.key === sectionKey; }).title + " updated.");
				// Refresh audit drawer if it has been expanded at least once.
				if (state.audit.loaded) loadAudit();
				render();
			})
			.catch(function (err) {
				sec.saving = false;
				applyServerError(sectionKey, { message: err && err.message, field: err && err.field });
				// Best effort: if the error came from fetch JSON, attempt to
				// pull the field path out of the message.
				ctx.toast("error", "Save failed", (err && err.message) || String(err));
				render();
				// Scroll the first errored field into view.
				requestAnimationFrame(function () {
					var errSlot = document.querySelector('[data-section-root="' + sectionKey + '"] .dash-field-error:not([hidden])');
					if (errSlot && errSlot.scrollIntoView) errSlot.scrollIntoView({ behavior: "smooth", block: "center" });
				});
			});
	}

	function askDiscard(sectionKey) {
		var meta = SECTIONS.find(function (m) { return m.key === sectionKey; });
		if (!meta) return;
		var body = document.createElement("div");
		var p = document.createElement("p");
		p.style.margin = "0 0 var(--space-2)";
		p.textContent = "Discard your unsaved changes in " + meta.title + "?";
		var info = document.createElement("p");
		info.className = "phantom-muted";
		info.style.margin = "0";
		info.style.fontSize = "12px";
		info.textContent = "The form returns to the last saved state. No audit row is written.";
		body.appendChild(p);
		body.appendChild(info);
		ctx.openModal({
			title: "Discard changes?",
			body: body,
			actions: [
				{ label: "Keep editing", className: "dash-btn-ghost" },
				{
					label: "Discard",
					className: "dash-btn-danger",
					onClick: function () { discardSection(sectionKey); return true; },
				},
			],
		});
	}

	function discardSection(sectionKey) {
		var sec = state.sections[sectionKey];
		if (!sec || !sec.initial) return;
		sec.draft = deepClone(sec.initial);
		sec.errors = {};
		render();
	}

	function deepClone(value) {
		if (value == null || typeof value !== "object") return value;
		if (Array.isArray(value)) return value.map(deepClone);
		var out = {};
		Object.keys(value).forEach(function (k) { out[k] = deepClone(value[k]); });
		return out;
	}

	// ----- audit drawer --------------------------------------------------

	function wireAuditDrawer() {
		var details = document.getElementById("settings-audit-details");
		if (!details) return;
		details.addEventListener("toggle", function () {
			state.audit.expanded = details.open;
			if (details.open && !state.audit.loaded && !state.audit.loading) {
				loadAudit();
			}
		});
	}

	function loadAudit() {
		state.audit.loading = true;
		state.audit.error = null;
		render();
		ctx.api("GET", "/ui/api/phantom-config/audit?limit=20")
			.then(function (res) {
				state.audit.loading = false;
				state.audit.entries = (res && res.entries) || [];
				state.audit.loaded = true;
				render();
			})
			.catch(function (err) {
				state.audit.loading = false;
				state.audit.error = (err && err.message) || String(err);
				render();
			});
	}

	// ----- load + mount --------------------------------------------------

	function hydrate(full, audit) {
		state.full = full;
		state.lastModifiedAt = (audit && audit.last_modified_at) || state.lastModifiedAt;
		state.lastModifiedBy = (audit && audit.last_modified_by) || state.lastModifiedBy;
		var splits = splitFullIntoSections(full);
		SECTIONS.forEach(function (meta) {
			state.sections[meta.key].initial = deepClone(splits[meta.key]);
			state.sections[meta.key].draft = deepClone(splits[meta.key]);
			state.sections[meta.key].errors = {};
			state.sections[meta.key].saving = false;
		});
	}

	function loadSettings() {
		state.loading = true;
		state.error = null;
		render();
		return ctx.api("GET", "/ui/api/phantom-config")
			.then(function (res) {
				if (!res || !res.config) throw new Error("Missing config in response");
				hydrate(res.config, res.audit || {});
				state.avatar.displayName = res.config.name || "";
				state.loading = false;
				render();
				probeAvatar();
			})
			.catch(function (err) {
				state.loading = false;
				state.error = (err && err.message) || String(err);
				render();
			});
	}

	function mount(container, _arg, dashCtx) {
		ctx = dashCtx;
		root = container;
		ctx.setBreadcrumb("Settings");
		if (!state.initialized) {
			ctx.registerDirtyChecker(isAnyDirty);
			state.initialized = true;
		}
		return loadSettings();
	}

	window.PhantomDashboard.registerRoute("settings", { mount: mount });
})();
