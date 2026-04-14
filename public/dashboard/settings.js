// Settings tab: curated form over the agent's settings.json, grouped by
// section, with a diff preview before save. Follows Stripe API settings
// panel pacing: per-section forms, per-field tooltips, bottom save bar.
//
// Module contract: registers with PhantomDashboard via
// registerRoute('settings'). mount(container, arg, ctx) is called on hash
// change. ctx provides esc, api, toast, openModal, navigate, setBreadcrumb,
// registerDirtyChecker.

(function () {
	// Sections group whitelisted fields for the form UI. Any safe field
	// documented in research 06 can land here; the Zod whitelist on the
	// server is authoritative.
	var SECTIONS = [
		{
			key: "permissions",
			title: "Permissions",
			help: "Control which tool calls the agent can run without asking. Deny wins over allow.",
			fields: [
				{ key: "permissions.allow", label: "Allow rules", kind: "chips", help: "Permission rules granting tool access. Example: Bash(git:*), WebFetch(domain:github.com)." },
				{ key: "permissions.deny", label: "Deny rules", kind: "chips", help: "Permission rules blocking tool access. Checked before allow." },
				{ key: "permissions.ask", label: "Ask rules", kind: "chips", help: "Permission rules that always prompt for confirmation." },
				{ key: "permissions.defaultMode", label: "Default mode", kind: "select", options: ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk"], help: "Default permission mode when Claude Code needs access. bypassPermissions grants the agent unrestricted access. dontAsk denies anything not pre-approved.", warning: true },
				{ key: "permissions.additionalDirectories", label: "Additional directories", kind: "chips", help: "Extra project directories the agent can read and write outside the main cwd." },
				{ key: "permissions.disableBypassPermissionsMode", label: "Lock out bypassPermissions", kind: "lockToggle", help: "Lock the agent out of permissionMode: bypassPermissions. Once set, cannot be unset via the dashboard without editing settings.json directly.", warning: true },
			],
		},
		{
			key: "model",
			title: "Model",
			help: "Which model runs and at what effort. Changing this affects quality and cost.",
			fields: [
				{ key: "model", label: "Model override", kind: "input", help: "Set a model here to override the default for every query in this scope. Cost may change significantly.", warning: true },
				{ key: "effortLevel", label: "Effort", kind: "select", options: ["", "low", "medium", "high"], help: "Persisted effort level for supported models." },
			],
		},
		{
			key: "mcp",
			title: "MCP servers",
			help: "External MCP servers the agent is allowed to use.",
			fields: [
				{ key: "enabledMcpjsonServers", label: "Enabled MCP servers", kind: "chips", help: "Approved MCP servers from .mcp.json." },
				{ key: "disabledMcpjsonServers", label: "Disabled MCP servers", kind: "chips", help: "Rejected MCP servers from .mcp.json." },
				{ key: "enableAllProjectMcpServers", label: "Enable all project MCP servers", kind: "toggle", help: "Automatically approve every MCP server in .mcp.json. Only turn on if you trust the project.", warning: true },
			],
		},
		{
			key: "hooks-security",
			title: "Hooks security",
			help: "Global guardrails on the hooks editor in the Hooks tab.",
			fields: [
				{ key: "disableAllHooks", label: "Disable all hooks", kind: "toggle", help: "Globally disable every hook. Use to debug hook regressions.", warning: true },
				{ key: "defaultShell", label: "Default shell", kind: "select", options: ["", "bash", "powershell"], help: "Default shell interpreter for command hooks." },
				{ key: "allowedHttpHookUrls", label: "Allowed HTTP hook URLs", kind: "chips", help: "URL patterns HTTP hooks may target. Supports * wildcard." },
				{ key: "httpHookAllowedEnvVars", label: "Allowed env vars for HTTP hook headers", kind: "chips", help: "Env var names HTTP hooks may interpolate into headers." },
			],
		},
		{
			key: "memory",
			title: "Memory",
			help: "Automatic memory reading and background consolidation.",
			fields: [
				{ key: "autoMemoryEnabled", label: "Auto-memory enabled", kind: "toggle", help: "Enable auto-memory read and write for this project." },
				{ key: "autoDreamEnabled", label: "Auto-dream enabled", kind: "toggle", help: "Background memory consolidation runs between sessions." },
				{ key: "claudeMdExcludes", label: "CLAUDE.md exclude globs", kind: "chips", help: "Glob patterns or absolute paths of CLAUDE.md files to exclude from loading." },
			],
		},
		{
			key: "session",
			title: "Session",
			help: "Transcript retention and git attribution.",
			fields: [
				{ key: "cleanupPeriodDays", label: "Cleanup period (days)", kind: "number", min: 0, max: 3650, help: "Days to retain chat transcripts. 0 disables session persistence and deletes existing transcripts on startup." },
				{ key: "respectGitignore", label: "Respect .gitignore", kind: "toggle", help: "File picker honors .gitignore patterns." },
				{ key: "includeCoAuthoredBy", label: "Include co-authored-by", kind: "toggle", help: "Add co-authored-by line on commits." },
				{ key: "includeGitInstructions", label: "Include git instructions", kind: "toggle", help: "Include built-in commit and PR workflow in the system prompt." },
			],
		},
		{
			key: "ui",
			title: "UI and output",
			help: "Thinking display, spinner tips, output style.",
			fields: [
				{ key: "alwaysThinkingEnabled", label: "Thinking enabled", kind: "toggle", help: "When off, thinking is disabled on supported models." },
				{ key: "showThinkingSummaries", label: "Show thinking summaries", kind: "toggle", help: "Surface thinking summaries in the transcript view." },
				{ key: "fastMode", label: "Fast mode", kind: "toggle" },
				{ key: "prefersReducedMotion", label: "Prefer reduced motion", kind: "toggle" },
				{ key: "outputStyle", label: "Output style", kind: "input" },
				{ key: "language", label: "Language", kind: "input" },
			],
		},
		{
			key: "updates",
			title: "Updates",
			help: "Auto-update channel for the CLI.",
			fields: [
				{ key: "autoUpdatesChannel", label: "Update channel", kind: "select", options: ["", "latest", "stable"] },
				{ key: "minimumVersion", label: "Minimum version", kind: "input" },
			],
		},
	];

	var state = {
		current: {},
		whitelist: [],
		denylist: [],
		draft: {},
		// A parallel set of dot-separated paths the user has actively
		// interacted with in this session. We track touched state so that
		// "user cleared a field to empty" is distinguishable from "user has
		// not touched this field yet", without collapsing empty arrays and
		// empty strings into the same absent-key bucket.
		touched: {},
		loading: true,
		initialized: false,
	};
	var ctx = null;
	var root = null;

	function esc(s) { return ctx.esc(s); }

	function getNested(obj, path) {
		var parts = path.split(".");
		var cur = obj;
		for (var i = 0; i < parts.length; i++) {
			if (cur == null || typeof cur !== "object") return undefined;
			cur = cur[parts[i]];
		}
		return cur;
	}

	// Writes the draft at `path` as an explicit value, even when empty. We
	// store empty strings and empty arrays so the dirty comparator can see
	// "user cleared this" versus "user never touched this". setNested also
	// flips the touched bit for this path.
	function setNested(obj, path, value) {
		var parts = path.split(".");
		var cur = obj;
		for (var i = 0; i < parts.length - 1; i++) {
			if (cur[parts[i]] == null || typeof cur[parts[i]] !== "object") cur[parts[i]] = {};
			cur = cur[parts[i]];
		}
		cur[parts[parts.length - 1]] = value;
		state.touched[path] = true;
	}

	function draftValue(path) {
		// Touched paths may legitimately hold "" or []; return the stored
		// empty state. Untouched paths fall back to the on-disk value.
		if (state.touched[path]) {
			return getNested(state.draft, path);
		}
		var v = getNested(state.draft, path);
		if (v !== undefined) return v;
		return getNested(state.current, path);
	}

	// Structural deep equality. Mirrors the server-side comparator so the
	// dirty badge stays in sync with the server's dirty detection on save.
	function deepEqual(a, b) {
		if (a === b) return true;
		if (a == null || b == null) return a === b;
		if (typeof a !== typeof b) return false;
		if (Array.isArray(a) || Array.isArray(b)) {
			if (!Array.isArray(a) || !Array.isArray(b)) return false;
			if (a.length !== b.length) return false;
			for (var i = 0; i < a.length; i++) {
				if (!deepEqual(a[i], b[i])) return false;
			}
			return true;
		}
		if (typeof a === "object") {
			var ak = Object.keys(a);
			var bk = Object.keys(b);
			if (ak.length !== bk.length) return false;
			for (var j = 0; j < ak.length; j++) {
				var k = ak[j];
				if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
				if (!deepEqual(a[k], b[k])) return false;
			}
			return true;
		}
		return false;
	}

	function isDirty() {
		return dirtyKeys().length > 0;
	}

	// Returns the list of top-level dirty keys in the draft. A key is
	// dirty if any touched path under it differs structurally from the
	// on-disk value.
	function dirtyKeys() {
		var topLevelTouched = {};
		Object.keys(state.touched).forEach(function (path) {
			topLevelTouched[path.split(".")[0]] = true;
		});
		var dirty = [];
		Object.keys(topLevelTouched).forEach(function (k) {
			var draftV = state.draft[k];
			var currentV = state.current[k];
			if (!deepEqual(draftV, currentV)) dirty.push(k);
		});
		return dirty;
	}

	function renderHeader() {
		var dirty = dirtyKeys();
		var badge = dirty.length > 0
			? '<span class="dash-source-chip dash-source-chip-agent">' + dirty.length + ' dirty</span>'
			: '';
		return (
			'<div class="dash-header">' +
			'<p class="dash-header-eyebrow">Settings</p>' +
			'<h1 class="dash-header-title">Settings ' + badge + '</h1>' +
			'<p class="dash-header-lead">Curated form over ~/.claude/settings.json. Unsafe fields like apiKeyHelper and modelOverrides are deliberately hidden. Every change is audited and saved diff-based: fields you do not touch stay byte-for-byte identical on disk.</p>' +
			'</div>'
		);
	}

	function renderChips(path, values, placeholder) {
		var arr = Array.isArray(values) ? values : [];
		var chips = arr.map(function (v, i) {
			return '<span class="dash-chip"><span>' + esc(v) + '</span><button type="button" data-chip-remove="' + esc(path) + ':' + i + '" aria-label="Remove ' + esc(v) + '">&times;</button></span>';
		}).join("");
		return (
			'<div class="dash-chips" data-chips-for="' + esc(path) + '">' +
			chips +
			'<input type="text" data-chip-input-for="' + esc(path) + '" placeholder="' + esc(placeholder || "") + '">' +
			'</div>'
		);
	}

	function renderField(f) {
		var v = draftValue(f.key);
		var warningBadge = f.warning ? ' <span class="dash-source-chip dash-source-chip-agent">review</span>' : '';
		var tip = f.help ? ' <span class="dash-field-tip" tabindex="0" data-tip="' + esc(f.help) + '">?</span>' : '';
		var control = "";
		if (f.kind === "toggle") {
			control = (
				'<label class="dash-toggle">' +
				'<input type="checkbox" data-setting-path="' + esc(f.key) + '" ' + (v === true ? 'checked' : '') + '>' +
				'<span class="dash-toggle-track"></span>' +
				'<span>' + (v === true ? 'on' : 'off') + '</span>' +
				'</label>'
			);
		} else if (f.kind === "lockToggle") {
			// One-way lock: the persisted value is the literal string
			// "disable"; the field cannot be unset through the dashboard
			// once set. Reflect that in the UI by disabling the control
			// once the on-disk value is "disable".
			var locked = v === "disable";
			control = (
				'<label class="dash-toggle">' +
				'<input type="checkbox" data-setting-lock="' + esc(f.key) + '" ' + (locked ? 'checked disabled' : '') + '>' +
				'<span class="dash-toggle-track"></span>' +
				'<span>' + (locked ? 'locked' : 'unlocked') + '</span>' +
				'</label>'
			);
		} else if (f.kind === "select") {
			control = '<select class="dash-select" data-setting-path="' + esc(f.key) + '">';
			f.options.forEach(function (opt) {
				var label = opt || '(unset)';
				control += '<option value="' + esc(opt) + '"' + (v === opt || (v == null && opt === "") ? ' selected' : '') + '>' + esc(label) + '</option>';
			});
			control += '</select>';
		} else if (f.kind === "number") {
			control = '<input class="dash-input" type="number" data-setting-path="' + esc(f.key) + '" value="' + esc(v != null ? String(v) : "") + '"' + (f.min != null ? ' min="' + f.min + '"' : '') + (f.max != null ? ' max="' + f.max + '"' : '') + '>';
		} else if (f.kind === "chips") {
			control = renderChips(f.key, v, "add and press enter");
		} else {
			control = '<input class="dash-input" type="text" data-setting-path="' + esc(f.key) + '" value="' + esc(v != null ? String(v) : "") + '">';
		}
		return (
			'<div class="dash-field">' +
			'<label class="dash-field-label">' + esc(f.label) + warningBadge + tip + '</label>' +
			control +
			'</div>'
		);
	}

	function renderSection(sec) {
		return (
			'<section class="dash-settings-section">' +
			'<header>' +
			'<h2 class="dash-hook-event-title">' + esc(sec.title) + '</h2>' +
			'<p class="dash-hook-event-summary">' + esc(sec.help || "") + '</p>' +
			'</header>' +
			'<div class="dash-form">' +
			sec.fields.map(renderField).join("") +
			'</div>' +
			'</section>'
		);
	}

	function renderSaveBar() {
		var dirty = dirtyKeys();
		var disabled = dirty.length === 0;
		var msg = dirty.length === 0
			? "No unsaved changes."
			: dirty.length === 1
				? "1 field will be written on save."
				: dirty.length + " fields will be written on save.";
		return (
			'<div class="dash-save-bar">' +
			'<div class="dash-save-bar-status">' + esc(msg) + '</div>' +
			'<div class="dash-save-bar-actions">' +
			'<button class="dash-btn dash-btn-ghost" id="settings-revert-btn"' + (disabled ? ' disabled' : '') + '>Discard changes</button>' +
			'<button class="dash-btn dash-btn-primary" id="settings-save-btn"' + (disabled ? ' disabled' : '') + '>Save</button>' +
			'</div>' +
			'</div>'
		);
	}

	function render() {
		if (state.loading) {
			root.innerHTML = renderHeader() + '<div class="dash-empty"><p class="dash-empty-body">Loading settings...</p></div>';
			return;
		}
		root.innerHTML = (
			renderHeader() +
			SECTIONS.map(renderSection).join("") +
			renderSaveBar()
		);
		wireFields();
		var saveBtn = document.getElementById("settings-save-btn");
		if (saveBtn) saveBtn.addEventListener("click", saveSettings);
		var revertBtn = document.getElementById("settings-revert-btn");
		if (revertBtn) revertBtn.addEventListener("click", function () {
			state.draft = {};
			state.touched = {};
			render();
		});
		ctx.setBreadcrumb("Settings");
	}

	function wireFields() {
		document.querySelectorAll("[data-setting-path]").forEach(function (el) {
			var path = el.getAttribute("data-setting-path");
			if (el.type === "checkbox") {
				el.addEventListener("change", function () { setNested(state.draft, path, el.checked); render(); });
			} else if (el.tagName === "SELECT") {
				el.addEventListener("change", function () {
					// Empty option means "unset this field"; map to
					// undefined which the server-side whitelist
					// schema treats as "not submitted".
					setNested(state.draft, path, el.value === "" ? undefined : el.value);
					render();
				});
			} else if (el.type === "number") {
				el.addEventListener("input", function () {
					var raw = el.value.trim();
					if (raw === "") { setNested(state.draft, path, undefined); return; }
					var n = parseInt(raw, 10);
					if (!Number.isFinite(n)) return;
					setNested(state.draft, path, n);
				});
				el.addEventListener("blur", render);
			} else {
				el.addEventListener("input", function () {
					// Persist the raw trimmed value, including the empty
					// string. The parallel touched set keeps dirty
					// detection working for "I just cleared this".
					setNested(state.draft, path, el.value.trim());
				});
				el.addEventListener("blur", render);
			}
		});
		document.querySelectorAll("[data-setting-lock]").forEach(function (el) {
			// One-way lock: once the operator enables it, we persist the
			// literal string "disable" and the control is disabled on
			// re-render. There is no "turn it back off" path from the UI.
			var path = el.getAttribute("data-setting-lock");
			el.addEventListener("change", function () {
				if (!el.checked) return;
				var go = window.confirm("This lock cannot be undone from the dashboard. Continue?");
				if (!go) { el.checked = false; return; }
				setNested(state.draft, path, "disable");
				render();
			});
		});
		document.querySelectorAll("[data-chip-input-for]").forEach(function (input) {
			var path = input.getAttribute("data-chip-input-for");
			input.addEventListener("keydown", function (e) {
				if (e.key === "Enter" || e.key === ",") {
					e.preventDefault();
					var v = input.value.trim().replace(/,$/, "");
					if (!v) return;
					var arr = (draftValue(path) || []).slice();
					if (arr.indexOf(v) < 0) arr.push(v);
					setNested(state.draft, path, arr);
					render();
				}
			});
		});
		document.querySelectorAll("[data-chip-remove]").forEach(function (btn) {
			var parts = btn.getAttribute("data-chip-remove").split(":");
			var path = parts[0];
			var idx = parseInt(parts[1], 10);
			btn.addEventListener("click", function () {
				var arr = (draftValue(path) || []).slice();
				arr.splice(idx, 1);
				// Persist the emptied array explicitly via setNested so
				// the user can save "I cleared the last chip" as an
				// empty array rather than reverting to on-disk.
				setNested(state.draft, path, arr);
				render();
			});
		});
	}

	function saveSettings() {
		var dirty = dirtyKeys();
		if (dirty.length === 0) return;
		var payload = {};
		dirty.forEach(function (k) { payload[k] = state.draft[k]; });
		var saveBtn = document.getElementById("settings-save-btn");
		if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Saving"; }
		ctx.api("PUT", "/ui/api/settings", payload).then(function (res) {
			state.current = res.current || state.current;
			state.draft = {};
			state.touched = {};
			ctx.toast("success", "Settings saved", "The agent picks this up on its next message.");
			render();
		}).catch(function (err) {
			ctx.toast("error", "Save failed", err.message || String(err));
			if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Save"; }
		});
	}

	function loadSettings() {
		state.loading = true;
		render();
		return ctx.api("GET", "/ui/api/settings").then(function (res) {
			state.current = res.current || {};
			state.whitelist = res.whitelist || [];
			state.denylist = res.denylist || [];
			state.draft = {};
			state.touched = {};
			state.loading = false;
			render();
		}).catch(function (err) {
			state.loading = false;
			ctx.toast("error", "Failed to load settings", err.message || String(err));
			render();
		});
	}

	function mount(container, _arg, dashCtx) {
		ctx = dashCtx;
		root = container;
		ctx.setBreadcrumb("Settings");
		if (!state.initialized) {
			ctx.registerDirtyChecker(isDirty);
			state.initialized = true;
		}
		return loadSettings();
	}

	window.PhantomDashboard.registerRoute("settings", { mount: mount });
})();
