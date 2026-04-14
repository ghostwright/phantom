// Subagents tab: list, search, editor, save, create, delete.
//
// Module contract: registers with PhantomDashboard via
// registerRoute('subagents', module). Inherits the list-plus-editor pattern
// from skills.js since subagents are structurally similar (markdown files
// with YAML frontmatter), with three meaningful differences:
//   1. Files are flat (<root>/<name>.md) not directory-per-name.
//   2. Frontmatter uses AgentDefinition fields (tools, model, effort, color).
//   3. There is no disable-model-invocation toggle.

(function () {
	var state = {
		subagents: [],
		errors: [],
		selectedName: null,
		currentDetail: null,
		lastLoadedBody: "",
		lastLoadedFrontmatter: null,
		search: "",
		initialized: false,
	};
	var ctx = null;
	var root = null;

	var MODEL_OPTIONS = [
		{ value: "", label: "(inherit from parent)" },
		{ value: "inherit", label: "inherit" },
		{ value: "opus", label: "opus" },
		{ value: "sonnet", label: "sonnet" },
		{ value: "haiku", label: "haiku" },
	];
	var EFFORT_OPTIONS = [
		{ value: "", label: "(unset)" },
		{ value: "low", label: "low" },
		{ value: "medium", label: "medium" },
		{ value: "high", label: "high" },
	];
	var COLOR_OPTIONS = ["", "red", "orange", "yellow", "green", "cyan", "blue", "purple", "magenta", "white", "gray"];

	function esc(s) { return ctx.esc(s); }

	function isDirty() {
		if (!state.currentDetail) return false;
		var currentBody = (document.getElementById("subagent-body") || {}).value;
		if (currentBody == null) return false;
		var fm = collectFrontmatter();
		if (!fm.ok) return false;
		return currentBody !== state.lastLoadedBody ||
			JSON.stringify(fm.value) !== JSON.stringify(state.lastLoadedFrontmatter);
	}

	function collectFrontmatter() {
		var nameEl = document.getElementById("subagent-field-name");
		var descEl = document.getElementById("subagent-field-description");
		var modelEl = document.getElementById("subagent-field-model");
		var effortEl = document.getElementById("subagent-field-effort");
		var colorEl = document.getElementById("subagent-field-color");
		var memoryEl = document.getElementById("subagent-field-memory");
		var toolsEl = document.getElementById("subagent-field-tools");
		if (!nameEl) return { ok: false };
		var name = nameEl.value.trim();
		var fm = {
			name: name,
			description: (descEl.value || "").trim(),
		};
		var tools = toolsEl ? JSON.parse(toolsEl.getAttribute("data-tools") || "[]") : [];
		if (tools.length > 0) fm.tools = tools;
		if (modelEl && modelEl.value) fm.model = modelEl.value;
		if (effortEl && effortEl.value) fm.effort = effortEl.value;
		if (colorEl && colorEl.value) fm.color = colorEl.value;
		if (memoryEl && memoryEl.value.trim()) fm.memory = memoryEl.value.trim();
		return { ok: true, value: fm };
	}

	function renderHeader() {
		return (
			'<div class="dash-header">' +
			'<p class="dash-header-eyebrow">Subagents</p>' +
			'<h1 class="dash-header-title">Subagents</h1>' +
			'<p class="dash-header-lead">Specialized agents invoked via the Task tool. Each one has its own prompt, tool allowlist, model, and effort. Saved subagents are live on the next message.</p>' +
			'<div class="dash-header-actions">' +
			'<button class="dash-btn dash-btn-primary" id="subagent-new-btn">New subagent</button>' +
			'</div>' +
			'</div>'
		);
	}

	function renderListCard(sub) {
		var isSelected = state.selectedName === sub.name ? ' aria-current="page"' : "";
		var modelChip = sub.model ? '<span class="dash-source-chip dash-source-chip-user">' + esc(sub.model) + '</span>' : "";
		return (
			'<a href="#/subagents/' + encodeURIComponent(sub.name) + '" class="dash-list-card"' + isSelected + '>' +
			'<div class="dash-list-card-row">' +
			'<h3 class="dash-list-card-title">' + esc(sub.name) + '</h3>' +
			modelChip +
			'</div>' +
			'<p class="dash-list-card-desc">' + esc(sub.description || "") + '</p>' +
			'<div class="dash-list-card-meta">' +
			'<span>' + (sub.size ? (sub.size + " B") : "") + '</span>' +
			'</div>' +
			'</a>'
		);
	}

	function filteredSubagents() {
		var q = (state.search || "").trim().toLowerCase();
		if (!q) return state.subagents;
		return state.subagents.filter(function (s) {
			return (s.name || "").toLowerCase().indexOf(q) >= 0 ||
				(s.description || "").toLowerCase().indexOf(q) >= 0;
		});
	}

	function renderEmptyList() {
		return (
			'<div class="dash-empty">' +
			'<svg class="dash-empty-icon" fill="none" viewBox="0 0 24 24" stroke-width="1.2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0 1 12 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 0 1 6 18.719m12 0a5.971 5.971 0 0 0-.941-3.197m0 0A5.995 5.995 0 0 0 12 12.75a5.995 5.995 0 0 0-5.058 2.772m0 0a3 3 0 0 0-4.681 2.72 8.986 8.986 0 0 0 3.74.477m.94-3.197a5.971 5.971 0 0 0-.94 3.197M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-13.5 0a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z"/></svg>' +
			'<h3 class="dash-empty-title">No subagents yet</h3>' +
			'<p class="dash-empty-body">Create a subagent to delegate a specific kind of task. The main agent invokes it via the Task tool.</p>' +
			'<button class="dash-btn dash-btn-primary" id="subagent-new-btn-empty">New subagent</button>' +
			'</div>'
		);
	}

	function renderListColumn() {
		var list = filteredSubagents();
		var parts = [];
		parts.push('<div class="dash-list-search">');
		parts.push('<svg fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"/></svg>');
		parts.push('<input type="search" id="subagent-search" placeholder="Search subagents" value="' + esc(state.search) + '">');
		parts.push('</div>');
		if (state.subagents.length === 0) {
			parts.push(renderEmptyList());
		} else {
			parts.push('<p class="dash-list-group-label">Yours</p>');
			list.forEach(function (s) { parts.push(renderListCard(s)); });
			if (list.length === 0) {
				parts.push('<div class="dash-empty" style="padding:var(--space-6) var(--space-4);"><p class="dash-empty-body">No subagents match "' + esc(state.search) + '".</p></div>');
			}
		}
		return '<aside class="dash-list">' + parts.join("") + '</aside>';
	}

	function renderSelect(id, current, options) {
		var html = '<select class="dash-select" id="' + id + '">';
		options.forEach(function (opt) {
			var val = typeof opt === "string" ? opt : opt.value;
			var lbl = typeof opt === "string" ? (opt || "(unset)") : opt.label;
			html += '<option value="' + esc(val) + '"' + (current === val ? " selected" : "") + '>' + esc(lbl) + '</option>';
		});
		html += "</select>";
		return html;
	}

	function renderField(label, inputId, control, hint) {
		var tip = hint ? ' <span class="dash-field-tip" tabindex="0" data-tip="' + esc(hint) + '">?</span>' : "";
		return (
			'<div class="dash-field">' +
			'<label class="dash-field-label" for="' + inputId + '">' + esc(label) + tip + '</label>' +
			control +
			'</div>'
		);
	}

	function renderToolsChips(tools) {
		var allowedToolsJson = JSON.stringify(tools || []).replace(/'/g, "&#39;");
		var chips = (tools || []).map(function (t, i) {
			return '<span class="dash-chip"><span>' + esc(t) + '</span><button type="button" data-tool-remove="' + i + '" aria-label="Remove ' + esc(t) + '">&times;</button></span>';
		}).join("");
		return (
			'<div class="dash-chips" id="subagent-field-tools" data-tools=\'' + allowedToolsJson + '\'>' +
			chips +
			'<input type="text" id="subagent-field-tools-input" placeholder="Read, Write, Bash, WebFetch" list="subagent-tool-suggestions">' +
			'<datalist id="subagent-tool-suggestions">' +
			'<option value="Read"><option value="Write"><option value="Edit"><option value="Glob"><option value="Grep">' +
			'<option value="Bash"><option value="WebSearch"><option value="WebFetch"><option value="Task">' +
			'</datalist>' +
			'</div>'
		);
	}

	function renderEditor() {
		if (!state.currentDetail) {
			return (
				'<div class="dash-editor">' +
				'<div class="dash-empty" style="border:none;">' +
				'<svg class="dash-empty-icon" fill="none" viewBox="0 0 24 24" stroke-width="1.2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 17.25 21 12m0 0-5.25-5.25M21 12H3"/></svg>' +
				'<h3 class="dash-empty-title">Pick a subagent</h3>' +
				'<p class="dash-empty-body">Select one from the left, or create a new one from the button above.</p>' +
				'</div>' +
				'</div>'
			);
		}
		var d = state.currentDetail;
		var fm = d.frontmatter;
		return (
			'<section class="dash-editor" aria-labelledby="subagent-editor-title">' +
			'<header class="dash-editor-header">' +
			'<div class="dash-editor-title-wrap">' +
			'<h2 class="dash-editor-title" id="subagent-editor-title">' + esc(d.name) + ' <span class="dash-dirty-dot" id="subagent-dirty-dot" data-dirty="false" aria-label="unsaved changes"></span></h2>' +
			'<p class="dash-editor-subtitle">' + esc(d.path) + '</p>' +
			'</div>' +
			'<div class="dash-editor-actions">' +
			'<button class="dash-btn dash-btn-ghost dash-btn-sm" id="subagent-delete-btn">Delete</button>' +
			'<button class="dash-btn dash-btn-primary dash-btn-sm" id="subagent-save-btn" disabled>Save</button>' +
			'</div>' +
			'</header>' +

			'<div class="dash-form">' +
			'<div class="dash-form-grid">' +
			renderField("Name", "subagent-field-name", '<input class="dash-input" id="subagent-field-name" value="' + esc(fm.name) + '" readonly>', "Matches the filename stem under .claude/agents/. Immutable after creation.") +
			renderField("Model", "subagent-field-model", renderSelect("subagent-field-model", fm.model || "", MODEL_OPTIONS), "Alias or full model ID. Leave unset to inherit from the parent agent.") +
			'</div>' +

			renderField("Description", "subagent-field-description", '<input class="dash-input" id="subagent-field-description" value="' + esc(fm.description) + '">', "The Task tool reads this to decide when to invoke. Write it like a mini when_to_use.") +

			'<div class="dash-form-grid">' +
			renderField("Effort", "subagent-field-effort", renderSelect("subagent-field-effort", fm.effort || "", EFFORT_OPTIONS), "Thinking effort for supported models.") +
			renderField("Color", "subagent-field-color", renderSelect("subagent-field-color", fm.color || "", COLOR_OPTIONS), "Display color for the Task tool UI.") +
			'</div>' +

			renderField("Tools", "subagent-field-tools", renderToolsChips(fm.tools), "Allowed tools. Leave empty to inherit everything from the parent.") +

			renderField("Memory", "subagent-field-memory", '<textarea class="dash-textarea" id="subagent-field-memory" style="min-height:60px;">' + esc(fm.memory || "") + '</textarea>', "Free-text memory hint the subagent receives on every invocation.") +

			renderField("Prompt body", "subagent-body", '<textarea class="dash-textarea dash-textarea-tall" id="subagent-body" spellcheck="false">' + esc(d.body) + '</textarea>', "Markdown. The system prompt the subagent runs under. Saved atomically.") +

			'<div class="dash-lint" id="subagent-lint"></div>' +
			'</div>' +
			'</section>'
		);
	}

	function renderLint(hints) {
		var lint = document.getElementById("subagent-lint");
		if (!lint) return;
		lint.innerHTML = hints.map(function (h) {
			return '<div class="dash-lint-hint" data-level="' + esc(h.level) + '"><span class="dash-lint-dot"></span><span>' + esc(h.message) + '</span></div>';
		}).join("");
	}

	function wireSearch() {
		var search = document.getElementById("subagent-search");
		if (!search) return;
		search.addEventListener("input", function () {
			state.search = search.value || "";
			var listCol = document.getElementById("subagents-list-col");
			if (!listCol) return;
			var wrapper = document.createElement("div");
			wrapper.innerHTML = renderListColumn();
			listCol.innerHTML = wrapper.firstChild.innerHTML;
			wireSearch();
			wireListClicks();
		});
	}

	function wireListClicks() {
		var links = document.querySelectorAll(".dash-list-card");
		Array.prototype.forEach.call(links, function (a) {
			a.addEventListener("click", function (e) {
				var href = a.getAttribute("href");
				if (!href) return;
				e.preventDefault();
				ctx.navigate(href);
			});
		});
	}

	function wireToolChips() {
		var container = document.getElementById("subagent-field-tools");
		var input = document.getElementById("subagent-field-tools-input");
		if (!container || !input) return;
		function save(tools) {
			container.setAttribute("data-tools", JSON.stringify(tools));
			render(false);
		}
		function tools() { return JSON.parse(container.getAttribute("data-tools") || "[]"); }
		input.addEventListener("keydown", function (e) {
			if (e.key === "Enter" || e.key === ",") {
				e.preventDefault();
				var value = input.value.trim().replace(/,$/, "");
				if (!value) return;
				var existing = tools();
				if (existing.indexOf(value) < 0) existing.push(value);
				save(existing);
			} else if (e.key === "Backspace" && input.value === "") {
				var existing2 = tools();
				existing2.pop();
				save(existing2);
			}
		});
		input.addEventListener("blur", function () {
			var value = input.value.trim();
			if (value) {
				var existing = tools();
				if (existing.indexOf(value) < 0) existing.push(value);
				input.value = "";
				save(existing);
			}
		});
		container.querySelectorAll("[data-tool-remove]").forEach(function (btn) {
			btn.addEventListener("click", function () {
				var idx = parseInt(btn.getAttribute("data-tool-remove"), 10);
				var existing = tools();
				existing.splice(idx, 1);
				save(existing);
			});
		});
	}

	function render(rewireList) {
		if (rewireList === undefined) rewireList = true;
		var listHtml = renderListColumn();
		var editorHtml = renderEditor();

		root.innerHTML = (
			renderHeader() +
			'<div class="dash-split">' +
			'<div id="subagents-list-col">' + listHtml + '</div>' +
			'<div id="subagents-editor-col">' + editorHtml + '</div>' +
			'</div>'
		);

		if (rewireList) {
			wireSearch();
			wireListClicks();
			var newBtn = document.getElementById("subagent-new-btn");
			if (newBtn) newBtn.addEventListener("click", openNewSubagentModal);
			var newBtnEmpty = document.getElementById("subagent-new-btn-empty");
			if (newBtnEmpty) newBtnEmpty.addEventListener("click", openNewSubagentModal);
		}

		wireToolChips();

		var bodyEl = document.getElementById("subagent-body");
		var descEl = document.getElementById("subagent-field-description");
		var modelEl = document.getElementById("subagent-field-model");
		var effortEl = document.getElementById("subagent-field-effort");
		var colorEl = document.getElementById("subagent-field-color");
		var memoryEl = document.getElementById("subagent-field-memory");
		[bodyEl, descEl, memoryEl].forEach(function (el) {
			if (el) el.addEventListener("input", updateDirtyState);
		});
		[modelEl, effortEl, colorEl].forEach(function (el) {
			if (el) el.addEventListener("change", updateDirtyState);
		});

		if (bodyEl) {
			bodyEl.addEventListener("keydown", function (e) {
				if (e.key === "Tab" && !e.shiftKey) {
					e.preventDefault();
					var start = bodyEl.selectionStart;
					var end = bodyEl.selectionEnd;
					bodyEl.value = bodyEl.value.substring(0, start) + "  " + bodyEl.value.substring(end);
					bodyEl.selectionStart = bodyEl.selectionEnd = start + 2;
					updateDirtyState();
				} else if ((e.metaKey || e.ctrlKey) && e.key === "s") {
					e.preventDefault();
					saveSubagent();
				}
			});
		}

		var saveBtn = document.getElementById("subagent-save-btn");
		if (saveBtn) saveBtn.addEventListener("click", saveSubagent);
		var deleteBtn = document.getElementById("subagent-delete-btn");
		if (deleteBtn) deleteBtn.addEventListener("click", confirmDelete);

		if (state.currentDetail) {
			renderLint(state.currentDetail.lint || []);
			updateDirtyState();
			ctx.setBreadcrumb(state.currentDetail.name);
		} else {
			ctx.setBreadcrumb("Subagents");
		}
	}

	function updateDirtyState() {
		var dot = document.getElementById("subagent-dirty-dot");
		var save = document.getElementById("subagent-save-btn");
		var dirty = isDirty();
		if (dot) dot.setAttribute("data-dirty", dirty ? "true" : "false");
		if (save) save.disabled = !dirty;
	}

	function openNewSubagentModal() {
		var body = document.createElement("div");
		body.innerHTML = (
			'<p style="font-size:13px; line-height:1.55; color:color-mix(in oklab, var(--color-base-content) 68%, transparent); margin:0 0 var(--space-4);">Name it and we will seed a blank prompt. Pick the model and tools after.</p>' +
			'<div class="dash-form">' +
			'<div class="dash-field">' +
			'<label class="dash-field-label" for="new-subagent-name">Subagent name</label>' +
			'<input class="dash-input" id="new-subagent-name" placeholder="research-intern" autocomplete="off">' +
			'<div class="dash-field-hint">Lowercase letters, digits, and hyphens.</div>' +
			'</div>' +
			'<div class="dash-field" style="margin-top:var(--space-3);">' +
			'<label class="dash-field-label" for="new-subagent-description">Short description</label>' +
			'<input class="dash-input" id="new-subagent-description" placeholder="Fetch a paper and summarize it in five bullets.">' +
			'</div>' +
			'</div>'
		);
		ctx.openModal({
			title: "New subagent",
			body: body,
			actions: [
				{ label: "Cancel", className: "dash-btn-ghost", onClick: function () {} },
				{
					label: "Create",
					className: "dash-btn-primary",
					onClick: function () {
						var name = document.getElementById("new-subagent-name").value.trim();
						var desc = document.getElementById("new-subagent-description").value.trim();
						if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) {
							ctx.toast("error", "Invalid name", "Use lowercase letters, digits, and hyphens. Start with a letter.");
							return false;
						}
						if (!desc || desc.length < 10) {
							ctx.toast("error", "Description too short", "Write a full sentence so the Task tool knows when to invoke this subagent.");
							return false;
						}
						return createNewSubagent(name, desc).then(function (ok) {
							return ok !== false;
						});
					},
				},
			],
		});
	}

	function createNewSubagent(name, description) {
		var fm = { name: name, description: description };
		var body = "# " + name + "\n\n## Goal\n\nDescribe what this subagent does.\n\n## Steps\n\n### 1. Step name\n\nWhat it does.\n\n**Success criteria**: How it knows the step is complete.\n";
		return ctx.api("POST", "/ui/api/subagents", { frontmatter: fm, body: body }).then(function (res) {
			ctx.toast("success", "Subagent created", "The main agent picks this up on its next message.");
			return loadList().then(function () {
				ctx.navigate("#/subagents/" + encodeURIComponent(res.subagent.name));
			});
		}).catch(function (err) {
			ctx.toast("error", "Failed to create subagent", err.message || String(err));
			return false;
		});
	}

	function saveSubagent() {
		if (!state.currentDetail) return;
		var body = document.getElementById("subagent-body").value;
		var fm = collectFrontmatter();
		if (!fm.ok) return;
		var saveBtn = document.getElementById("subagent-save-btn");
		if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Saving"; }
		var name = state.currentDetail.name;
		ctx.api("PUT", "/ui/api/subagents/" + encodeURIComponent(name), { frontmatter: fm.value, body: body })
			.then(function (res) {
				state.currentDetail = res.subagent;
				state.lastLoadedBody = res.subagent.body;
				state.lastLoadedFrontmatter = res.subagent.frontmatter;
				renderLint(res.subagent.lint || []);
				if (saveBtn) { saveBtn.textContent = "Save"; }
				updateDirtyState();
				ctx.toast("success", "Saved", "The main agent picks this up on its next message.");
				loadList();
			})
			.catch(function (err) {
				if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Save"; }
				ctx.toast("error", "Save failed", err.message || String(err));
			});
	}

	function confirmDelete() {
		if (!state.currentDetail) return;
		var name = state.currentDetail.name;
		ctx.openModal({
			title: "Delete " + name + "?",
			body: "This removes " + name + ".md from /home/phantom/.claude/agents/. You can re-create it later.",
			actions: [
				{ label: "Cancel", className: "dash-btn-ghost", onClick: function () {} },
				{
					label: "Delete",
					className: "dash-btn-danger",
					onClick: function () {
						return ctx.api("DELETE", "/ui/api/subagents/" + encodeURIComponent(name))
							.then(function () {
								state.currentDetail = null;
								state.lastLoadedBody = "";
								state.lastLoadedFrontmatter = null;
								state.selectedName = null;
								ctx.toast("success", "Deleted", name + " removed.");
								return loadList().then(function () {
									ctx.navigate("#/subagents");
								});
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

	function loadList() {
		return ctx.api("GET", "/ui/api/subagents").then(function (res) {
			state.subagents = res.subagents || [];
			state.errors = res.errors || [];
			render(true);
			if (state.errors.length > 0) {
				state.errors.forEach(function (e) {
					ctx.toast("error", "Subagent parse error: " + e.name, e.error);
				});
			}
		}).catch(function (err) {
			ctx.toast("error", "Failed to load subagents", err.message || String(err));
		});
	}

	function loadDetail(name) {
		return ctx.api("GET", "/ui/api/subagents/" + encodeURIComponent(name)).then(function (res) {
			state.currentDetail = res.subagent;
			state.lastLoadedBody = res.subagent.body;
			state.lastLoadedFrontmatter = res.subagent.frontmatter;
			state.selectedName = name;
			render(true);
		}).catch(function (err) {
			if (err.status === 404) {
				ctx.toast("error", "Subagent not found", name);
				ctx.navigate("#/subagents");
				return;
			}
			ctx.toast("error", "Failed to load subagent", err.message || String(err));
		});
	}

	function mount(container, arg, dashCtx) {
		ctx = dashCtx;
		root = container;
		ctx.setBreadcrumb("Subagents");
		if (!state.initialized) {
			ctx.registerDirtyChecker(isDirty);
			state.initialized = true;
		}
		return loadList().then(function () {
			if (arg) {
				return loadDetail(arg);
			}
			if (state.subagents.length > 0 && !state.selectedName) {
				var first = state.subagents[0].name;
				return loadDetail(first);
			}
		});
	}

	window.PhantomDashboard.registerRoute("subagents", { mount: mount });
})();
