// Hooks tab: visual rule builder for the 26 Claude Agent SDK hook events.
//
// Module contract: registers with PhantomDashboard via registerRoute('hooks').
// mount(container, arg, ctx) is called on hash change. ctx provides esc, api,
// toast, openModal, navigate, setBreadcrumb, registerDirtyChecker.
//
// The hooks tab is the breakthrough surface of PR3. No Claude Code product has
// a visual hooks rule builder; this is the first one. The design takes after
// Linear Automations: a three-column flow (trigger, matcher, action) with a
// type-specific form for the action column and a live JSON preview pane.
//
// State model is a single closure-scoped object; no framework. Every edit
// mutates state.draftHook and schedules a re-render of the preview pane.

(function () {
	var HOOK_EVENTS = [
		"PreToolUse", "PostToolUse", "PostToolUseFailure", "Notification",
		"UserPromptSubmit", "SessionStart", "SessionEnd", "Stop", "StopFailure",
		"SubagentStart", "SubagentStop", "PreCompact", "PostCompact",
		"PermissionRequest", "Setup", "TeammateIdle", "TaskCreated", "TaskCompleted",
		"Elicitation", "ElicitationResult", "ConfigChange",
		"WorktreeCreate", "WorktreeRemove", "InstructionsLoaded",
		"CwdChanged", "FileChanged",
	];

	var EVENTS_WITH_MATCHER = {
		PreToolUse: "Tool name (e.g. Bash, Write, Edit)",
		PostToolUse: "Tool name",
		PostToolUseFailure: "Tool name",
		SubagentStart: "Subagent name",
		SubagentStop: "Subagent name",
		Elicitation: "MCP server name",
		ElicitationResult: "MCP server name",
		ConfigChange: "Settings source (user_settings, project_settings, local_settings, policy_settings, skills)",
		InstructionsLoaded: "Memory type or load reason",
		FileChanged: "Filename glob (e.g. .envrc|.env)",
	};

	var EVENT_SUMMARIES = {
		PreToolUse: "Fires before a tool call is dispatched. Exit 2 blocks the call.",
		PostToolUse: "Fires after a tool call succeeds.",
		PostToolUseFailure: "Fires after a tool call throws.",
		Notification: "Fires on user-facing notifications.",
		UserPromptSubmit: "Fires when the user hits enter. Exit 2 blocks the send.",
		SessionStart: "Fires when a new session starts.",
		SessionEnd: "Fires when a session ends normally.",
		Stop: "Fires when the agent voluntarily stops.",
		StopFailure: "Fires when the agent crashes out.",
		SubagentStart: "Fires when a subagent is invoked via the Task tool.",
		SubagentStop: "Fires when a subagent finishes.",
		PreCompact: "Fires before the transcript is auto-compacted.",
		PostCompact: "Fires after compaction.",
		PermissionRequest: "Fires when the CLI asks to approve a dangerous op.",
		Setup: "Fires once on first-time setup.",
		TeammateIdle: "Fires when a team channel teammate stops sending.",
		TaskCreated: "Fires when a background task is scheduled.",
		TaskCompleted: "Fires when a background task completes.",
		Elicitation: "Fires when an MCP server requests user input.",
		ElicitationResult: "Fires after the user answers an elicitation.",
		ConfigChange: "Fires when any settings source mutates.",
		WorktreeCreate: "Fires when a git worktree is created.",
		WorktreeRemove: "Fires when a git worktree is removed.",
		InstructionsLoaded: "Fires when a CLAUDE.md or rules file loads.",
		CwdChanged: "Fires when the working directory changes.",
		FileChanged: "Fires when a watched file changes.",
	};

	var HOOK_TYPES = [
		{ value: "command", label: "Shell command", help: "Run a shell command. Exit code 2 blocks the event." },
		{ value: "prompt", label: "LLM prompt", help: "Evaluate the hook input with a prompt on a small, fast model." },
		{ value: "agent", label: "Agent verifier", help: "Run a full subagent that decides whether to approve." },
		{ value: "http", label: "HTTP POST", help: "POST the hook input JSON to a URL." },
	];

	var state = {
		slice: {},
		total: 0,
		allowedHttpHookUrls: null,
		trustAccepted: false,
		trustByType: { command: false, prompt: false, agent: false, http: false },
		auditEntries: [],
		loading: false,
		initialized: false,
		editing: null, // null | { mode: 'new' | 'edit', event, groupIndex, hookIndex, draft }
	};
	var ctx = null;
	var root = null;

	function esc(s) { return ctx.esc(s); }

	function blankDraft() {
		// Defer to defaultDefinition so the blank-draft shape matches the
		// shape produced after a type switch. Without this parity, flipping
		// type=http then back to type=command produced a different key set
		// than the initial snapshot, so the dirty checker fired on an
		// otherwise no-op exploration.
		return {
			event: "PreToolUse",
			matcher: "",
			definition: defaultDefinition("command"),
		};
	}

	// Per-hook-type trust scoping: accepting the trust modal for command
	// hooks does not satisfy the modal for http hooks. Http has a very
	// different risk profile (network egress, env var interpolation)
	// and users should opt in to that separately.
	function isTrustedFor(hookType) {
		if (!hookType) return false;
		return !!(state.trustByType && state.trustByType[hookType]);
	}

	function renderHeader() {
		var subtitle = state.total === 0
			? "No hooks installed. Add a rule below to react to any of 26 events."
			: state.total + " hook" + (state.total === 1 ? "" : "s") + " installed across the agent's event surface.";
		return (
			'<div class="dash-header">' +
			'<p class="dash-header-eyebrow">Hooks</p>' +
			'<h1 class="dash-header-title">Hooks</h1>' +
			'<p class="dash-header-lead">' + esc(subtitle) + '</p>' +
			'<div class="dash-header-actions">' +
			'<button class="dash-btn dash-btn-primary" id="hooks-new-btn">Add rule</button>' +
			'<button class="dash-btn dash-btn-ghost" id="hooks-audit-btn">View audit</button>' +
			'</div>' +
			'</div>'
		);
	}

	function renderHookCard(event, groupIndex, matcher, hookIndex, def) {
		var typeBadge = '<span class="dash-source-chip dash-source-chip-user">' + esc(def.type) + '</span>';
		var matcherChip = matcher ? '<span class="dash-source-chip dash-source-chip-agent">matcher: ' + esc(matcher) + '</span>' : "";
		var titleForType = {
			command: def.command,
			prompt: def.prompt,
			agent: def.prompt,
			http: def.url,
		}[def.type] || "";
		return (
			'<article class="dash-list-card">' +
			'<div class="dash-list-card-row">' +
			'<h3 class="dash-list-card-title">' + esc(event) + '</h3>' +
			typeBadge +
			'</div>' +
			'<p class="dash-list-card-desc">' + esc(String(titleForType).slice(0, 140)) + '</p>' +
			'<div class="dash-list-card-meta">' +
			matcherChip +
			(def.once ? '<span class="dash-source-chip dash-source-chip-user">once</span>' : "") +
			(def.async ? '<span class="dash-source-chip dash-source-chip-user">async</span>' : "") +
			'<button class="dash-btn dash-btn-ghost dash-btn-sm" data-hook-edit="' + esc(event) + '/' + groupIndex + '/' + hookIndex + '">Edit</button>' +
			'<button class="dash-btn dash-btn-ghost dash-btn-sm" data-hook-delete="' + esc(event) + '/' + groupIndex + '/' + hookIndex + '">Delete</button>' +
			'</div>' +
			'</article>'
		);
	}

	function renderHookList() {
		var eventsWithHooks = Object.keys(state.slice).filter(function (ev) { return (state.slice[ev] || []).length > 0; });
		if (eventsWithHooks.length === 0) {
			return (
				'<div class="dash-empty">' +
				'<svg class="dash-empty-icon" fill="none" viewBox="0 0 24 24" stroke-width="1.2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244"/></svg>' +
				'<h3 class="dash-empty-title">No hooks yet</h3>' +
				'<p class="dash-empty-body">Add a rule to run a command before every Bash call, format files after an edit, or fire a webhook on task completion. Every install runs through a trust modal on first use.</p>' +
				'<button class="dash-btn dash-btn-primary" id="hooks-new-btn-empty">Add the first rule</button>' +
				'</div>'
			);
		}
		var sections = [];
		eventsWithHooks.forEach(function (ev) {
			var cards = [];
			(state.slice[ev] || []).forEach(function (group, gi) {
				(group.hooks || []).forEach(function (def, hi) {
					cards.push(renderHookCard(ev, gi, group.matcher, hi, def));
				});
			});
			sections.push(
				'<section class="dash-hook-event-section">' +
				'<header class="dash-hook-event-header">' +
				'<h2 class="dash-hook-event-title">' + esc(ev) + '</h2>' +
				'<p class="dash-hook-event-summary">' + esc(EVENT_SUMMARIES[ev] || "") + '</p>' +
				'</header>' +
				'<div class="dash-hook-event-cards">' + cards.join("") + '</div>' +
				'</section>'
			);
		});
		return sections.join("");
	}

	function renderPreview() {
		if (!state.editing) return "";
		var preview = {};
		var ev = state.editing.draft.event;
		preview[ev] = [
			{
				matcher: state.editing.draft.matcher || undefined,
				hooks: [cleanDefinition(state.editing.draft.definition)],
			},
		];
		if (!preview[ev][0].matcher) delete preview[ev][0].matcher;
		return JSON.stringify(preview, null, 2);
	}

	function cleanDefinition(def) {
		var out = {};
		Object.keys(def).forEach(function (k) {
			var v = def[k];
			if (v === "" || v === null || v === undefined) return;
			if (v === false && (k === "once" || k === "async" || k === "asyncRewake")) return;
			out[k] = v;
		});
		return out;
	}

	function renderTypeOptions(current) {
		return HOOK_TYPES.map(function (t) {
			return '<option value="' + t.value + '"' + (current === t.value ? " selected" : "") + '>' + esc(t.label) + '</option>';
		}).join("");
	}

	function renderEventOptions(current) {
		return HOOK_EVENTS.map(function (ev) {
			return '<option value="' + ev + '"' + (current === ev ? " selected" : "") + '>' + esc(ev) + '</option>';
		}).join("");
	}

	function renderActionForm(def) {
		var t = def.type;
		var parts = [];
		if (t === "command") {
			parts.push(
				'<div class="dash-field">' +
				'<label class="dash-field-label" for="hook-command">Command</label>' +
				'<textarea class="dash-textarea" id="hook-command" placeholder="echo about to run bash">' + esc(def.command || "") + '</textarea>' +
				'<div class="dash-field-hint">Runs in bash by default. Exit code 2 blocks the event.</div>' +
				'</div>' +
				'<div class="dash-form-grid">' +
				'<div class="dash-field"><label class="dash-field-label" for="hook-timeout">Timeout (s)</label><input class="dash-input" id="hook-timeout" type="number" min="1" max="3600" value="' + (def.timeout || 30) + '"></div>' +
				'<div class="dash-field"><label class="dash-field-label" for="hook-shell">Shell</label><select class="dash-select" id="hook-shell"><option value="">default (bash)</option><option value="bash"' + (def.shell === "bash" ? " selected" : "") + '>bash</option><option value="powershell"' + (def.shell === "powershell" ? " selected" : "") + '>powershell</option></select></div>' +
				'</div>' +
				'<div class="dash-form-grid">' +
				'<label class="dash-toggle"><input type="checkbox" id="hook-once"' + (def.once ? " checked" : "") + '><span class="dash-toggle-track"></span><span>Run once then remove</span></label>' +
				'<label class="dash-toggle"><input type="checkbox" id="hook-async"' + (def.async ? " checked" : "") + '><span class="dash-toggle-track"></span><span>Run async (non-blocking)</span></label>' +
				'<label class="dash-toggle"><input type="checkbox" id="hook-async-rewake"' + (def.asyncRewake ? " checked" : "") + '><span class="dash-toggle-track"></span><span>Async rewake (notify on completion)</span></label>' +
				'</div>'
			);
		} else if (t === "prompt" || t === "agent") {
			parts.push(
				'<div class="dash-field">' +
				'<label class="dash-field-label" for="hook-prompt">Prompt</label>' +
				'<textarea class="dash-textarea dash-textarea-tall" id="hook-prompt" placeholder="Evaluate whether this tool call is safe. Use $ARGUMENTS for the hook input JSON.">' + esc(def.prompt || "") + '</textarea>' +
				'<div class="dash-field-hint">$ARGUMENTS is replaced with the hook input JSON. Under 4000 chars.</div>' +
				'</div>' +
				'<div class="dash-form-grid">' +
				'<div class="dash-field"><label class="dash-field-label" for="hook-timeout">Timeout (s)</label><input class="dash-input" id="hook-timeout" type="number" min="1" max="3600" value="' + (def.timeout || 60) + '"></div>' +
				'<div class="dash-field"><label class="dash-field-label" for="hook-model">Model</label><input class="dash-input" id="hook-model" placeholder="claude-sonnet-4-6" value="' + esc(def.model || "") + '"></div>' +
				'</div>' +
				'<label class="dash-toggle"><input type="checkbox" id="hook-once"' + (def.once ? " checked" : "") + '><span class="dash-toggle-track"></span><span>Run once then remove</span></label>'
			);
		} else if (t === "http") {
			var envVarsJson = JSON.stringify(def.allowedEnvVars || [])
				.replace(/&/g, "&amp;")
				.replace(/</g, "&lt;")
				.replace(/>/g, "&gt;")
				.replace(/"/g, "&quot;")
				.replace(/'/g, "&#39;");
			var envChips = (def.allowedEnvVars || []).map(function (v, i) {
				return '<span class="dash-chip"><span>' + esc(v) + '</span><button type="button" data-hook-env-remove="' + i + '" aria-label="Remove ' + esc(v) + '">&times;</button></span>';
			}).join("");
			parts.push(
				'<div class="dash-field">' +
				'<label class="dash-field-label" for="hook-url">URL</label>' +
				'<input class="dash-input" id="hook-url" placeholder="https://hooks.example.com/event" value="' + esc(def.url || "") + '">' +
				'<div class="dash-field-hint">Must match an allowed HTTP hook URL pattern in settings.json. Patterns are anchored full-string; append * to allow query strings.</div>' +
				'</div>' +
				'<div class="dash-field">' +
				'<label class="dash-field-label" for="hook-headers">Headers (one per line, key: value)</label>' +
				'<textarea class="dash-textarea" id="hook-headers" placeholder="X-Source: phantom">' + esc(headersToText(def.headers)) + '</textarea>' +
				'</div>' +
				'<div class="dash-field">' +
				'<label class="dash-field-label" for="hook-allowed-env">Allowed env vars</label>' +
				'<div class="dash-chips" id="hook-allowed-env" data-env-vars="' + envVarsJson + '">' +
				envChips +
				'<input type="text" id="hook-allowed-env-input" placeholder="RESEND_API_KEY, PHANTOM_NAME">' +
				'</div>' +
				'<div class="dash-field-hint">Env var names HTTP hooks may interpolate into headers. Must match [A-Z_][A-Z0-9_]*.</div>' +
				'</div>' +
				'<div class="dash-field"><label class="dash-field-label" for="hook-timeout">Timeout (s)</label><input class="dash-input" id="hook-timeout" type="number" min="1" max="3600" value="' + (def.timeout || 10) + '"></div>'
			);
		}
		return parts.join("");
	}

	function headersToText(headers) {
		if (!headers) return "";
		return Object.keys(headers).map(function (k) { return k + ": " + headers[k]; }).join("\n");
	}

	function parseHeadersText(text) {
		if (!text) return null;
		var lines = text.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
		var out = {};
		for (var i = 0; i < lines.length; i++) {
			var idx = lines[i].indexOf(":");
			if (idx < 0) continue;
			out[lines[i].slice(0, idx).trim()] = lines[i].slice(idx + 1).trim();
		}
		return Object.keys(out).length > 0 ? out : null;
	}

	function renderBuilder() {
		if (!state.editing) return "";
		var draft = state.editing.draft;
		var matcherSupported = Object.prototype.hasOwnProperty.call(EVENTS_WITH_MATCHER, draft.event);
		var matcherPlaceholder = EVENTS_WITH_MATCHER[draft.event] || "";
		return (
			'<div class="dash-hook-builder" id="hook-builder">' +
			'<header class="dash-hook-builder-header">' +
			'<h2 class="dash-hook-builder-title">' + (state.editing.mode === "new" ? "New rule" : "Edit rule") + '</h2>' +
			'<div class="dash-editor-actions">' +
			'<button class="dash-btn dash-btn-ghost dash-btn-sm" id="hook-cancel-btn">Cancel</button>' +
			'<button class="dash-btn dash-btn-primary dash-btn-sm" id="hook-save-btn" disabled>Save rule</button>' +
			'</div>' +
			'</header>' +

			'<div class="dash-hook-columns">' +

			'<section class="dash-hook-column">' +
			'<div class="dash-hook-column-eyebrow">1. Trigger</div>' +
			'<h3 class="dash-hook-column-title">When</h3>' +
			'<select class="dash-select" id="hook-event">' + renderEventOptions(draft.event) + '</select>' +
			'<p class="dash-hook-column-help">' + esc(EVENT_SUMMARIES[draft.event] || "") + '</p>' +
			'</section>' +

			'<section class="dash-hook-column">' +
			'<div class="dash-hook-column-eyebrow">2. Matcher</div>' +
			'<h3 class="dash-hook-column-title">For which</h3>' +
			(matcherSupported
				? '<input class="dash-input" id="hook-matcher" placeholder="' + esc(matcherPlaceholder) + '" value="' + esc(draft.matcher || "") + '"><p class="dash-hook-column-help">Leave blank to match every invocation. Supports literal names and regex patterns the CLI interprets.</p>'
				: '<div class="dash-hook-column-disabled">This event does not accept a matcher. Leave blank.</div>'
			) +
			'</section>' +

			'<section class="dash-hook-column">' +
			'<div class="dash-hook-column-eyebrow">3. Action</div>' +
			'<h3 class="dash-hook-column-title">Do</h3>' +
			'<select class="dash-select" id="hook-type">' + renderTypeOptions(draft.definition.type) + '</select>' +
			'<div id="hook-action-form" class="dash-hook-action-form">' + renderActionForm(draft.definition) + '</div>' +
			'</section>' +

			'</div>' +

			'<details class="dash-hook-preview">' +
			'<summary class="dash-hook-preview-summary">Preview settings.json slice</summary>' +
			'<pre class="dash-hook-preview-code">' + esc(renderPreview()) + '</pre>' +
			'</details>' +

			'</div>'
		);
	}

	function render() {
		var body = state.editing
			? renderBuilder()
			: '<div class="dash-hook-list">' + renderHookList() + '</div>';
		root.innerHTML = renderHeader() + body;
		wireEvents();
		if (state.editing) {
			wireBuilder();
			updateSaveEnabled();
		}
		ctx.setBreadcrumb("Hooks");
	}

	function wireEvents() {
		var newBtn = document.getElementById("hooks-new-btn");
		if (newBtn) newBtn.addEventListener("click", startNewRule);
		var newBtnEmpty = document.getElementById("hooks-new-btn-empty");
		if (newBtnEmpty) newBtnEmpty.addEventListener("click", startNewRule);
		var auditBtn = document.getElementById("hooks-audit-btn");
		if (auditBtn) auditBtn.addEventListener("click", showAuditPanel);

		document.querySelectorAll("[data-hook-edit]").forEach(function (btn) {
			btn.addEventListener("click", function () {
				var coords = btn.getAttribute("data-hook-edit").split("/");
				startEditRule(coords[0], parseInt(coords[1], 10), parseInt(coords[2], 10));
			});
		});
		document.querySelectorAll("[data-hook-delete]").forEach(function (btn) {
			btn.addEventListener("click", function () {
				var coords = btn.getAttribute("data-hook-delete").split("/");
				confirmDelete(coords[0], parseInt(coords[1], 10), parseInt(coords[2], 10));
			});
		});
	}

	function wireBuilder() {
		var eventSel = document.getElementById("hook-event");
		var matcherInput = document.getElementById("hook-matcher");
		var typeSel = document.getElementById("hook-type");

		if (eventSel) eventSel.addEventListener("change", function () {
			state.editing.draft.event = eventSel.value;
			if (!Object.prototype.hasOwnProperty.call(EVENTS_WITH_MATCHER, eventSel.value)) {
				state.editing.draft.matcher = "";
			}
			render();
		});
		if (matcherInput) matcherInput.addEventListener("input", function () {
			state.editing.draft.matcher = matcherInput.value;
			updatePreview();
			updateSaveEnabled();
		});
		if (typeSel) typeSel.addEventListener("change", function () {
			var newType = typeSel.value;
			state.editing.draft.definition = defaultDefinition(newType);
			// Reset the dirty baseline to the post-switch draft. Switching
			// type is a deliberate schema change, not an unsaved edit; the
			// operator has not typed anything meaningful yet. Without this
			// reset the nav-confirm modal fires every time the operator
			// explores the type dropdown.
			state.editing.initialDraft = JSON.stringify(state.editing.draft);
			render();
		});
		wireActionFields();

		var saveBtn = document.getElementById("hook-save-btn");
		if (saveBtn) saveBtn.addEventListener("click", saveRule);
		var cancelBtn = document.getElementById("hook-cancel-btn");
		if (cancelBtn) cancelBtn.addEventListener("click", function () {
			state.editing = null;
			render();
		});
	}

	function wireActionFields() {
		var def = state.editing.draft.definition;
		var t = def.type;
		if (t === "command") {
			bindInput("hook-command", function (v) { def.command = v; });
			bindInput("hook-timeout", function (v) { def.timeout = v ? parseInt(v, 10) : undefined; });
			bindSelect("hook-shell", function (v) { def.shell = v || undefined; });
			bindCheckbox("hook-once", function (v) { def.once = v; });
			bindCheckbox("hook-async", function (v) { def.async = v; });
			bindCheckbox("hook-async-rewake", function (v) { def.asyncRewake = v; });
		} else if (t === "prompt" || t === "agent") {
			bindInput("hook-prompt", function (v) { def.prompt = v; });
			bindInput("hook-timeout", function (v) { def.timeout = v ? parseInt(v, 10) : undefined; });
			bindInput("hook-model", function (v) { def.model = v || undefined; });
			bindCheckbox("hook-once", function (v) { def.once = v; });
		} else if (t === "http") {
			bindInput("hook-url", function (v) { def.url = v; });
			bindInput("hook-headers", function (v) { def.headers = parseHeadersText(v); });
			bindInput("hook-timeout", function (v) { def.timeout = v ? parseInt(v, 10) : undefined; });
			wireHookEnvVarsChips(def);
		}
	}

	function wireHookEnvVarsChips(def) {
		var container = document.getElementById("hook-allowed-env");
		var input = document.getElementById("hook-allowed-env-input");
		if (!container || !input) return;
		function items() { try { return JSON.parse(container.getAttribute("data-env-vars") || "[]"); } catch (_) { return []; } }
		function save(next) {
			container.setAttribute("data-env-vars", JSON.stringify(next));
			def.allowedEnvVars = next.length > 0 ? next : undefined;
			updatePreview();
			updateSaveEnabled();
		}
		input.addEventListener("keydown", function (e) {
			if (e.key === "Enter" || e.key === ",") {
				e.preventDefault();
				var v = input.value.trim().replace(/,$/, "");
				if (!v) return;
				if (!/^[A-Z_][A-Z0-9_]*$/.test(v)) {
					ctx.toast("error", "Invalid env var name", "Env var names must match [A-Z_][A-Z0-9_]*.");
					return;
				}
				var existing = items();
				if (existing.indexOf(v) < 0) existing.push(v);
				input.value = "";
				save(existing);
				// Re-render to show the new chip.
				render();
			}
		});
		container.querySelectorAll("[data-hook-env-remove]").forEach(function (btn) {
			btn.addEventListener("click", function () {
				var idx = parseInt(btn.getAttribute("data-hook-env-remove"), 10);
				var existing = items();
				existing.splice(idx, 1);
				save(existing);
				render();
			});
		});
	}

	function bindInput(id, setter) {
		var el = document.getElementById(id);
		if (!el) return;
		el.addEventListener("input", function () { setter(el.value); updatePreview(); updateSaveEnabled(); });
	}
	function bindSelect(id, setter) {
		var el = document.getElementById(id);
		if (!el) return;
		el.addEventListener("change", function () { setter(el.value); updatePreview(); updateSaveEnabled(); });
	}
	function bindCheckbox(id, setter) {
		var el = document.getElementById(id);
		if (!el) return;
		el.addEventListener("change", function () { setter(el.checked); updatePreview(); updateSaveEnabled(); });
	}

	function updatePreview() {
		var pre = document.querySelector(".dash-hook-preview-code");
		if (pre) pre.textContent = renderPreview();
	}

	function defaultDefinition(type) {
		if (type === "command") return { type: "command", command: "", timeout: 30, once: false, async: false };
		if (type === "prompt") return { type: "prompt", prompt: "", timeout: 60, once: false };
		if (type === "agent") return { type: "agent", prompt: "", timeout: 60, once: false };
		if (type === "http") return { type: "http", url: "", headers: null, timeout: 10 };
		return { type: "command", command: "" };
	}

	function validateDraft() {
		if (!state.editing) return false;
		var d = state.editing.draft;
		if (!d.event) return false;
		if (d.definition.type === "command" && (!d.definition.command || !d.definition.command.trim())) return false;
		if ((d.definition.type === "prompt" || d.definition.type === "agent") && (!d.definition.prompt || !d.definition.prompt.trim())) return false;
		if (d.definition.type === "http") {
			if (!d.definition.url) return false;
			try { new URL(d.definition.url); } catch (_) { return false; }
		}
		return true;
	}

	function updateSaveEnabled() {
		var btn = document.getElementById("hook-save-btn");
		if (btn) btn.disabled = !validateDraft();
	}

	function startNewRule() {
		// The trust modal scopes to the draft's current hook type. A
		// user who already accepted for command hooks still sees it for
		// their first http hook because http is a different risk
		// profile. Type check happens again at save time so a type
		// switch inside the builder gets caught.
		var draft = blankDraft();
		state.editing = { mode: "new", draft: draft, initialDraft: JSON.stringify(draft) };
		render();
	}

	function startEditRule(event, groupIndex, hookIndex) {
		var group = (state.slice[event] || [])[groupIndex];
		if (!group) return;
		var def = (group.hooks || [])[hookIndex];
		if (!def) return;
		var draft = { event: event, matcher: group.matcher || "", definition: JSON.parse(JSON.stringify(def)) };
		state.editing = {
			mode: "edit",
			event: event,
			groupIndex: groupIndex,
			hookIndex: hookIndex,
			draft: draft,
			initialDraft: JSON.stringify(draft),
		};
		render();
	}

	function saveRule() {
		if (!validateDraft()) return;
		var d = state.editing.draft;
		var cleaned = cleanDefinition(d.definition);
		cleaned.type = d.definition.type;

		// Fire the trust modal the first time the operator installs a
		// given hook type. The check is per-type so accepting command
		// hooks does not silently cover http, agent, or prompt.
		if (!isTrustedFor(d.definition.type)) {
			showTrustModal(d.definition.type, function () { saveRule(); });
			return;
		}

		var promise;
		if (state.editing.mode === "new") {
			promise = ctx.api("POST", "/ui/api/hooks", {
				event: d.event,
				matcher: d.matcher || undefined,
				definition: cleaned,
			});
		} else {
			// Detect whether the operator changed the event or the
			// matcher while in edit mode. If so, we route through the
			// relocate path so the hook moves atomically between
			// coordinates. Otherwise the existing in-place update
			// route does the right thing.
			var origEvent = state.editing.event;
			var origMatcherRaw = (state.slice[origEvent] || [])[state.editing.groupIndex];
			var origMatcher = origMatcherRaw ? (origMatcherRaw.matcher || "") : "";
			var draftMatcher = d.matcher || "";
			var isRelocate = d.event !== origEvent || draftMatcher !== origMatcher;
			var putBody = { definition: cleaned };
			if (isRelocate) {
				putBody.to = { event: d.event, matcher: draftMatcher || undefined };
			}
			promise = ctx.api(
				"PUT",
				"/ui/api/hooks/" + encodeURIComponent(origEvent) + "/" + state.editing.groupIndex + "/" + state.editing.hookIndex,
				putBody,
			);
		}

		promise.then(function (res) {
			state.slice = res.slice || {};
			recomputeTotal();
			state.editing = null;
			ctx.toast("success", "Rule saved", "Takes effect on the agent's next message.");
			return loadList();
		}).catch(function (err) {
			ctx.toast("error", "Save failed", err.message || String(err));
		});
	}

	function confirmDelete(event, groupIndex, hookIndex) {
		ctx.openModal({
			title: "Delete hook?",
			body: "Remove this " + event + " hook. It stops firing on the agent's next message.",
			actions: [
				{ label: "Cancel", className: "dash-btn-ghost", onClick: function () {} },
				{
					label: "Delete",
					className: "dash-btn-danger",
					onClick: function () {
						return ctx.api("DELETE", "/ui/api/hooks/" + encodeURIComponent(event) + "/" + groupIndex + "/" + hookIndex)
							.then(function (res) {
								state.slice = res.slice || {};
								recomputeTotal();
								ctx.toast("success", "Deleted", "Hook removed.");
								return loadList();
							})
							.catch(function (err) {
								ctx.toast("error", "Delete failed", err.message || String(err));
								return false;
							});
					},
				},
			],
		});
	}

	function showTrustModal(hookType, onAccept) {
		var perType = {
			command: "Command hooks run arbitrary shell commands under the agent user. Treat the command line as production code.",
			prompt: "Prompt hooks run a small model call on the hook input. No tool calls, no side effects, but cost is real.",
			agent: "Agent hooks run a full subagent that can decide to approve or deny. The subagent has tool access.",
			http: "HTTP hooks POST the hook input JSON to an allowlisted URL. Env vars listed in allowedEnvVars are substituted into headers. Network egress leaves the machine.",
		};
		var typeLabel = hookType.charAt(0).toUpperCase() + hookType.slice(1);
		var body = document.createElement("div");
		body.innerHTML = (
			'<p style="font-size:13px; line-height:1.55; margin:0 0 var(--space-3);">Trust for ' + esc(typeLabel) + ' hooks has not been accepted on this machine yet. Read this before you continue:</p>' +
			'<ul style="font-size:13px; line-height:1.6; padding-left:var(--space-4); margin:0 0 var(--space-4);">' +
			'<li>' + esc(perType[hookType] || "") + '</li>' +
			'<li>Every hook you install is audited. You can delete any hook at any time.</li>' +
			'<li>The agent itself can add or remove hooks via its Write tool. The dashboard captures dashboard-originated edits only.</li>' +
			'<li>Accepting trust for one type does not accept it for the other types. Each type has a different risk profile.</li>' +
			'</ul>' +
			'<p style="font-size:13px; line-height:1.55; margin:0;">By clicking Accept, you acknowledge that ' + esc(hookType) + ' hook execution power is real and you are taking responsibility for what you install.</p>'
		);
		ctx.openModal({
			title: "Before you install " + hookType + " hooks",
			body: body,
			actions: [
				{ label: "Cancel", className: "dash-btn-ghost", onClick: function () {} },
				{
					label: "Accept and continue",
					className: "dash-btn-primary",
					onClick: function () {
						return ctx.api("POST", "/ui/api/hooks/trust", { hook_type: hookType })
							.then(function () {
								if (!state.trustByType) state.trustByType = {};
								state.trustByType[hookType] = true;
								state.trustAccepted = true;
								onAccept();
							})
							.catch(function (err) {
								ctx.toast("error", "Could not record trust", err.message || String(err));
								return false;
							});
					},
				},
			],
		});
	}

	function showAuditPanel() {
		ctx.api("GET", "/ui/api/hooks/audit").then(function (res) {
			var entries = res.entries || [];
			var body = document.createElement("div");
			body.style.maxHeight = "60vh";
			body.style.overflowY = "auto";
			body.innerHTML = entries.length === 0
				? '<p>No audit entries yet.</p>'
				: entries.map(function (e) {
					return (
						'<div class="dash-audit-row">' +
						'<div class="dash-audit-row-top">' +
						'<span class="phantom-mono">' + esc(e.created_at) + '</span>' +
						' <strong>' + esc(e.action) + '</strong>' +
						' on <strong>' + esc(e.event) + '</strong>' +
						(e.matcher ? ' (matcher: ' + esc(e.matcher) + ')' : '') +
						'</div>' +
						(e.hook_type ? '<div class="dash-audit-row-body">type: ' + esc(e.hook_type) + '</div>' : '') +
						'</div>'
					);
				}).join("");
			ctx.openModal({
				title: "Hooks audit",
				body: body,
				actions: [{ label: "Close", className: "dash-btn-ghost", onClick: function () {} }],
			});
		}).catch(function (err) {
			ctx.toast("error", "Failed to load audit", err.message || String(err));
		});
	}

	function recomputeTotal() {
		var total = 0;
		Object.values(state.slice).forEach(function (groups) {
			(groups || []).forEach(function (g) { total += (g.hooks || []).length; });
		});
		state.total = total;
	}

	function loadList() {
		return ctx.api("GET", "/ui/api/hooks").then(function (res) {
			state.slice = res.slice || {};
			state.total = res.total || 0;
			state.allowedHttpHookUrls = res.allowed_http_hook_urls;
			state.trustAccepted = !!res.trust_accepted;
			state.trustByType = res.trust_by_type || {
				command: false,
				prompt: false,
				agent: false,
				http: false,
			};
			render();
		}).catch(function (err) {
			ctx.toast("error", "Failed to load hooks", err.message || String(err));
		});
	}

	function mount(container, _arg, dashCtx) {
		ctx = dashCtx;
		root = container;
		ctx.setBreadcrumb("Hooks");
		if (!state.initialized) {
			ctx.registerDirtyChecker(function () {
				if (state.editing == null) return false;
				// Compare current draft to the initial snapshot taken on
				// modal open. Opening "Edit" without typing is not dirty.
				return JSON.stringify(state.editing.draft) !== state.editing.initialDraft;
			});
			state.initialized = true;
		}
		return loadList();
	}

	window.PhantomDashboard.registerRoute("hooks", { mount: mount });
})();
