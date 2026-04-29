// Skills tab: list, search, editor, save, create, delete.
//
// Module contract: registers with PhantomDashboard via registerRoute('skills', module).
// mount(container, arg, ctx) is called on hash change. ctx has esc, api, toast,
// openModal, navigate, setBreadcrumb, registerDirtyChecker.

(function () {
	var state = {
		skills: [],
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

	function esc(s) { return ctx.esc(s); }

	function isDirty() {
		if (!state.currentDetail) return false;
		var currentBody = (document.getElementById("skill-body") || {}).value;
		if (currentBody == null) return false;
		var fm = collectFrontmatter();
		if (!fm.ok) return false;
		return currentBody !== state.lastLoadedBody ||
			!ctx.deepEqual(fm.value, state.lastLoadedFrontmatter);
	}

	function collectFrontmatter() {
		var nameEl = document.getElementById("skill-field-name");
		var descEl = document.getElementById("skill-field-description");
		var whenEl = document.getElementById("skill-field-when");
		var argHintEl = document.getElementById("skill-field-arghint");
		var contextEl = document.getElementById("skill-field-context");
		var disableEl = document.getElementById("skill-field-disable");
		var toolsEl = document.getElementById("skill-field-tools");
		if (!nameEl) return { ok: false };

		// Baseline-merge: start from the server-returned frontmatter so
		// pass-through fields like x-phantom-source survive a round trip
		// and any future schema additions preserve without a client change.
		var fm = {};
		if (state.lastLoadedFrontmatter && typeof state.lastLoadedFrontmatter === "object") {
			Object.keys(state.lastLoadedFrontmatter).forEach(function (k) {
				fm[k] = state.lastLoadedFrontmatter[k];
			});
		}

		fm.name = nameEl.value.trim();
		fm.description = (descEl.value || "").trim();
		fm.when_to_use = (whenEl.value || "").trim();

		var tools = toolsEl ? JSON.parse(toolsEl.getAttribute("data-tools") || "[]") : [];
		if (tools.length > 0) fm["allowed-tools"] = tools;
		else delete fm["allowed-tools"];

		var argHint = (argHintEl.value || "").trim();
		if (argHint) fm["argument-hint"] = argHint;
		else delete fm["argument-hint"];

		var contextValue = contextEl.value || "";
		if (contextValue) fm.context = contextValue;
		else delete fm.context;

		if (disableEl && disableEl.checked) fm["disable-model-invocation"] = true;
		else delete fm["disable-model-invocation"];

		return { ok: true, value: fm };
	}

	function renderHeader() {
		return (
			'<div class="dash-header">' +
			'<p class="dash-header-eyebrow">Skills</p>' +
			'<h1 class="dash-header-title">Skills</h1>' +
			'<p class="dash-header-lead">Markdown files the agent reads at the start of every message. Write instructions, procedures, or triggers. Saved skills are live on the next turn.</p>' +
			'<div class="dash-header-actions">' +
			'<button class="dash-btn dash-btn-primary" id="skill-new-btn">New skill</button>' +
			'<a href="/ui/_components.html" class="dash-btn dash-btn-ghost">Design vocabulary</a>' +
			'</div>' +
			'</div>'
		);
	}

	function renderListCard(skill) {
		var source = skill.source || "user";
		var label = source === "built-in" ? "built in" : source === "agent" ? "agent" : "you";
		var sourceClass = source === "built-in" ? "dash-source-chip-built-in" : source === "agent" ? "dash-source-chip-agent" : "dash-source-chip-user";
		var isSelected = state.selectedName === skill.name ? ' aria-current="page"' : "";
		var disablePill = skill.disable_model_invocation ? '<span class="dash-source-chip dash-source-chip-user">user only</span>' : "";
		return (
			'<a href="#/skills/' + encodeURIComponent(skill.name) + '" class="dash-list-card"' + isSelected + '>' +
			'<div class="dash-list-card-row">' +
			'<h3 class="dash-list-card-title">' + esc(skill.name) + '</h3>' +
			'<span class="dash-source-chip ' + sourceClass + '">' + label + '</span>' +
			'</div>' +
			'<p class="dash-list-card-desc">' + esc(skill.description || "") + '</p>' +
			'<div class="dash-list-card-meta">' +
			disablePill +
			'<span>' + (skill.size ? (skill.size + " B") : "") + '</span>' +
			'</div>' +
			'</a>'
		);
	}

	function filteredSkills() {
		var q = (state.search || "").trim().toLowerCase();
		if (!q) return state.skills;
		return state.skills.filter(function (s) {
			return (s.name || "").toLowerCase().indexOf(q) >= 0 ||
				(s.description || "").toLowerCase().indexOf(q) >= 0 ||
				(s.when_to_use || "").toLowerCase().indexOf(q) >= 0;
		});
	}

	function renderListColumn() {
		var list = filteredSkills();
		var built = list.filter(function (s) { return s.source === "built-in"; });
		var user = list.filter(function (s) { return s.source !== "built-in"; });

		var parts = [];
		parts.push('<div class="dash-list-search">');
		parts.push('<svg fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"/></svg>');
		parts.push('<input type="search" id="skill-search" placeholder="Search skills" value="' + esc(state.search) + '">');
		parts.push('</div>');

		if (state.skills.length === 0) {
			parts.push(renderEmptyList());
		} else {
			if (built.length > 0) {
				parts.push('<p class="dash-list-group-label">Built in</p>');
				built.forEach(function (s) { parts.push(renderListCard(s)); });
			}
			if (user.length > 0) {
				parts.push('<p class="dash-list-group-label">Yours</p>');
				user.forEach(function (s) { parts.push(renderListCard(s)); });
			}
			if (list.length === 0) {
				parts.push('<div class="dash-empty" style="padding:var(--space-6) var(--space-4);"><p class="dash-empty-body">No skills match "' + esc(state.search) + '".</p></div>');
			}
		}
		return '<aside class="dash-list">' + parts.join("") + '</aside>';
	}

	function renderEmptyList() {
		return (
			'<div class="dash-empty">' +
			'<svg class="dash-empty-icon" fill="none" viewBox="0 0 24 24" stroke-width="1.2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25"/></svg>' +
			'<h3 class="dash-empty-title">No skills yet</h3>' +
			'<p class="dash-empty-body">Start from a built-in like <span class="phantom-mono">mirror</span>, or write one from scratch. The agent picks up new skills on its next message.</p>' +
			'<button class="dash-btn dash-btn-primary" id="skill-new-btn-empty">New skill</button>' +
			'</div>'
		);
	}

	function renderEditor() {
		if (!state.currentDetail) {
			return (
				'<div class="dash-editor">' +
				'<div class="dash-empty" style="border:none;">' +
				'<svg class="dash-empty-icon" fill="none" viewBox="0 0 24 24" stroke-width="1.2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 17.25 21 12m0 0-5.25-5.25M21 12H3"/></svg>' +
				'<h3 class="dash-empty-title">Pick a skill</h3>' +
				'<p class="dash-empty-body">Select a skill from the left to view or edit it. Or create a new one from the button above.</p>' +
				'</div>' +
				'</div>'
			);
		}

		var d = state.currentDetail;
		var fm = d.frontmatter;
		var tools = fm["allowed-tools"] || [];
		var allowedToolsJson = JSON.stringify(tools).replace(/'/g, "&#39;");

		return (
			'<section class="dash-editor" aria-labelledby="skill-editor-title">' +
			'<header class="dash-editor-header">' +
			'<div class="dash-editor-title-wrap">' +
			'<h2 class="dash-editor-title" id="skill-editor-title">' + esc(d.name) + ' <span class="dash-dirty-dot" id="skill-dirty-dot" data-dirty="false" aria-label="unsaved changes"></span></h2>' +
			'<p class="dash-editor-subtitle">' + esc(d.path) + '</p>' +
			'</div>' +
			'<div class="dash-editor-actions">' +
			(d.source === "built-in" ? "" : '<button class="dash-btn dash-btn-ghost dash-btn-sm" id="skill-delete-btn">Delete</button>') +
			'<button class="dash-btn dash-btn-primary dash-btn-sm" id="skill-save-btn" disabled>Save</button>' +
			'</div>' +
			'</header>' +

			'<div class="dash-form">' +
			'<div class="dash-form-grid">' +
			renderField("name", "Name", "skill-field-name", '<input class="dash-input" id="skill-field-name" value="' + esc(fm.name) + '" ' + (d.source === "built-in" ? "readonly" : "") + '>', "Lowercase letters, digits, and hyphens. Matches the folder name under .claude/skills/.") +
			renderField("context", "Context", "skill-field-context", renderContextSelect(fm.context), "inline runs in the current conversation. fork spawns a subagent with its own turn limit.") +
			'</div>' +

			renderField("description", "Description", "skill-field-description", '<input class="dash-input" id="skill-field-description" value="' + esc(fm.description) + '">', "One sentence. Appears in the list and in the model's system reminder.") +

			renderField("when_to_use", "When to use", "skill-field-when", '<textarea class="dash-textarea" id="skill-field-when" style="min-height:80px;">' + esc(fm.when_to_use) + '</textarea>', "Trigger phrases and conditions. The model reads this to decide when to invoke the skill.") +

			renderField("allowed-tools", "Allowed tools", "skill-field-tools", renderToolsChips(tools, allowedToolsJson), "Fully qualified tool names. Leave empty for full access.") +

			'<div class="dash-form-grid">' +
			renderField("argument-hint", "Argument hint", "skill-field-arghint", '<input class="dash-input" id="skill-field-arghint" value="' + esc(fm["argument-hint"] || "") + '" placeholder="[topic]">', "Optional. Shown after the skill name when the user types /skill.") +
			renderDisableField(fm["disable-model-invocation"]) +
			'</div>' +

			renderField("body", "SKILL.md body", "skill-body", '<textarea class="dash-textarea dash-textarea-tall" id="skill-body" spellcheck="false">' + esc(d.body) + '</textarea>', "Markdown. Goal, Steps (each with a success criterion), and Rules. Saved atomically.") +

			'<div class="dash-lint" id="skill-lint"></div>' +
			'</div>' +
			'</section>'
		);
	}

	function renderContextSelect(current) {
		var options = [
			{ value: "", label: "(default)" },
			{ value: "inline", label: "inline" },
			{ value: "fork", label: "fork (subagent)" },
		];
		var html = '<select class="dash-select" id="skill-field-context">';
		options.forEach(function (opt) {
			html += '<option value="' + opt.value + '"' + (current === opt.value ? " selected" : "") + '>' + esc(opt.label) + '</option>';
		});
		html += "</select>";
		return html;
	}

	function renderDisableField(current) {
		return (
			'<div class="dash-field">' +
			'<span class="dash-field-label">User-invoke only <span class="dash-field-tip" tabindex="0" data-tip="Block the model from auto-invoking this skill. Only users can call it via /name. Recommended for dangerous or irreversible workflows.">?</span></span>' +
			'<label class="dash-toggle">' +
			'<input type="checkbox" id="skill-field-disable"' + (current === true ? " checked" : "") + '>' +
			'<span class="dash-toggle-track"></span>' +
			'<span>Disable model invocation</span>' +
			'</label>' +
			'</div>'
		);
	}

	function renderField(id, label, inputId, control, hint) {
		var tip = hint ? ' <span class="dash-field-tip" tabindex="0" data-tip="' + esc(hint) + '">?</span>' : "";
		return (
			'<div class="dash-field">' +
			'<label class="dash-field-label" for="' + inputId + '">' + esc(label) + tip + '</label>' +
			control +
			'</div>'
		);
	}

	function renderToolsChips(tools, allowedToolsJson) {
		var chips = tools.map(function (t, i) {
			return '<span class="dash-chip"><span>' + esc(t) + '</span><button type="button" data-tool-remove="' + i + '" aria-label="Remove ' + esc(t) + '">&times;</button></span>';
		}).join("");
		return (
			'<div class="dash-chips" id="skill-field-tools" data-tools=\'' + allowedToolsJson + '\'>' +
			chips +
			'<input type="text" id="skill-field-tools-input" placeholder="mcp__phantom-reflective__phantom_memory_search" list="skill-tool-suggestions">' +
			'<datalist id="skill-tool-suggestions">' +
			'<option value="Read"><option value="Write"><option value="Edit"><option value="Glob"><option value="Grep"><option value="Bash">' +
			'<option value="WebSearch"><option value="WebFetch">' +
			'<option value="mcp__phantom-reflective__phantom_memory_search">' +
			'<option value="mcp__phantom-reflective__phantom_list_sessions">' +
			'<option value="mcp__phantom-scheduler__phantom_schedule">' +
			'</datalist>' +
			'</div>'
		);
	}

	function renderLint(hints) {
		var lint = document.getElementById("skill-lint");
		if (!lint) return;
		lint.innerHTML = hints.map(function (h) {
			return '<div class="dash-lint-hint" data-level="' + esc(h.level) + '"><span class="dash-lint-dot"></span><span>' + esc(h.message) + '</span></div>';
		}).join("");
	}

	function wireSearch() {
		var search = document.getElementById("skill-search");
		if (!search) return;
		search.addEventListener("input", function () {
			state.search = search.value || "";
			var listCol = document.getElementById("skills-list-col");
			if (!listCol) return;
			var newList = renderListColumn();
			var wrapper = document.createElement("div");
			wrapper.innerHTML = newList;
			// Replace children inside listCol with the new aside content
			listCol.innerHTML = wrapper.firstChild.innerHTML;
			wireSearch();
			wireListClicks();
		});
	}

	function wireListClicks() {
		// Intercept link clicks inside list column so hash changes are processed
		// through the dashboard navigate helper (respects unsaved changes).
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
		var container = document.getElementById("skill-field-tools");
		var input = document.getElementById("skill-field-tools-input");
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
			'<div id="skills-list-col">' + listHtml + '</div>' +
			'<div id="skills-editor-col">' + editorHtml + '</div>' +
			'</div>'
		);

		if (rewireList) {
			wireSearch();
			wireListClicks();
			var newBtn = document.getElementById("skill-new-btn");
			if (newBtn) newBtn.addEventListener("click", openNewSkillModal);
			var newBtnEmpty = document.getElementById("skill-new-btn-empty");
			if (newBtnEmpty) newBtnEmpty.addEventListener("click", openNewSkillModal);
		}

		wireToolChips();

		var bodyEl = document.getElementById("skill-body");
		var nameEl = document.getElementById("skill-field-name");
		var descEl = document.getElementById("skill-field-description");
		var whenEl = document.getElementById("skill-field-when");
		var argHintEl = document.getElementById("skill-field-arghint");
		var contextEl = document.getElementById("skill-field-context");
		var disableEl = document.getElementById("skill-field-disable");
		[bodyEl, descEl, whenEl, argHintEl].forEach(function (el) {
			if (el) el.addEventListener("input", updateDirtyState);
		});
		if (contextEl) contextEl.addEventListener("change", updateDirtyState);
		if (disableEl) disableEl.addEventListener("change", updateDirtyState);

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
					saveSkill();
				}
			});
		}
		if (nameEl) nameEl.addEventListener("input", updateDirtyState);

		var saveBtn = document.getElementById("skill-save-btn");
		if (saveBtn) saveBtn.addEventListener("click", saveSkill);
		var deleteBtn = document.getElementById("skill-delete-btn");
		if (deleteBtn) deleteBtn.addEventListener("click", confirmDelete);

		if (state.currentDetail) {
			renderLint(state.currentDetail.lint || []);
			updateDirtyState();
			ctx.setBreadcrumb(state.currentDetail.name);
		} else {
			ctx.setBreadcrumb("Skills");
		}
	}

	function updateDirtyState() {
		var dot = document.getElementById("skill-dirty-dot");
		var save = document.getElementById("skill-save-btn");
		var dirty = isDirty();
		if (dot) dot.setAttribute("data-dirty", dirty ? "true" : "false");
		if (save) save.disabled = !dirty;
	}

	function openNewSkillModal() {
		var body = document.createElement("div");
		body.innerHTML = (
			'<p style="font-size:13px; line-height:1.55; color:color-mix(in oklab, var(--color-base-content) 68%, transparent); margin:0 0 var(--space-4);">Pick a starting point. You can rename and edit everything after.</p>' +
			'<div class="dash-form">' +
			'<div class="dash-field">' +
			'<label class="dash-field-label" for="new-skill-name">Skill name</label>' +
			'<input class="dash-input" id="new-skill-name" placeholder="my-new-skill" autocomplete="off">' +
			'<div class="dash-field-hint">Lowercase letters, digits, and hyphens.</div>' +
			'</div>' +
			'<div class="dash-field" style="margin-top:var(--space-3);">' +
			'<label class="dash-field-label">Template</label>' +
			'<select class="dash-select" id="new-skill-template">' +
			'<option value="blank">Blank</option>' +
			'<option value="mirror">Duplicate mirror</option>' +
			'<option value="thread">Duplicate thread</option>' +
			'</select>' +
			'</div>' +
			'</div>'
		);
		var modal = ctx.openModal({
			title: "New skill",
			body: body,
			actions: [
				{ label: "Cancel", className: "dash-btn-ghost", onClick: function () {} },
				{
					label: "Create",
					className: "dash-btn-primary",
					onClick: function () {
						var name = document.getElementById("new-skill-name").value.trim();
						if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) {
							ctx.toast("error", "Invalid name", "Use lowercase letters, digits, and hyphens. Start with a letter.");
							return false;
						}
						var template = document.getElementById("new-skill-template").value;
						return createNewSkill(name, template).then(function (ok) {
							return ok !== false;
						});
					},
				},
			],
		});
		return modal;
	}

	function templateSkill(name, template) {
		if (template === "mirror") {
			var mirror = state.skills.filter(function (s) { return s.name === "mirror"; })[0];
			if (mirror) {
				return ctx.api("GET", "/ui/api/skills/mirror").then(function (res) {
					var fm = Object.assign({}, res.skill.frontmatter, { name: name, description: name + " (copied from mirror)" });
					return { frontmatter: fm, body: res.skill.body };
				});
			}
		}
		if (template === "thread") {
			return ctx.api("GET", "/ui/api/skills/thread").then(function (res) {
				var fm = Object.assign({}, res.skill.frontmatter, { name: name, description: name + " (copied from thread)" });
				return { frontmatter: fm, body: res.skill.body };
			});
		}
		return Promise.resolve({
			frontmatter: {
				name: name,
				description: "A new skill",
				when_to_use: "Describe when the agent should invoke this skill. Include specific trigger phrases.",
			},
			body: "# " + name + "\n\n## Goal\n\nDescribe what this skill accomplishes.\n\n## Steps\n\n### 1. Step name\n\nWhat the agent does.\n\n**Success criteria**: How the agent knows the step is complete.\n\n## Rules\n\n- Things the agent should never do.\n",
		});
	}

	function createNewSkill(name, template) {
		return templateSkill(name, template).then(function (seed) {
			return ctx.api("POST", "/ui/api/skills", { frontmatter: seed.frontmatter, body: seed.body }).then(function (res) {
				ctx.toast("success", "Skill created", "Your agent picks this up on its next message.");
				return loadList().then(function () {
					ctx.navigate("#/skills/" + encodeURIComponent(res.skill.name));
				});
			});
		}).catch(function (err) {
			ctx.toast("error", "Failed to create skill", err.message || String(err));
			return false;
		});
	}

	function saveSkill() {
		if (!state.currentDetail) return;
		var body = document.getElementById("skill-body").value;
		var fm = collectFrontmatter();
		if (!fm.ok) return;
		var saveBtn = document.getElementById("skill-save-btn");
		if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Saving"; }
		var name = state.currentDetail.name;
		ctx.api("PUT", "/ui/api/skills/" + encodeURIComponent(name), { frontmatter: fm.value, body: body })
			.then(function (res) {
				state.currentDetail = res.skill;
				state.lastLoadedBody = res.skill.body;
				state.lastLoadedFrontmatter = res.skill.frontmatter;
				renderLint(res.skill.lint || []);
				if (saveBtn) { saveBtn.textContent = "Save"; }
				updateDirtyState();
				ctx.toast("success", "Saved", "Your agent picks this up on its next message.");
				// Refresh list so mtime ordering updates
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
			body: "This removes the SKILL.md file from /home/phantom/.claude/skills/" + name + "/. You can re-create it later.",
			actions: [
				{ label: "Cancel", className: "dash-btn-ghost", onClick: function () {} },
				{
					label: "Delete",
					className: "dash-btn-danger",
					onClick: function () {
						return ctx.api("DELETE", "/ui/api/skills/" + encodeURIComponent(name))
							.then(function () {
								state.currentDetail = null;
								state.lastLoadedBody = "";
								state.lastLoadedFrontmatter = null;
								state.selectedName = null;
								ctx.toast("success", "Deleted", name + " removed.");
								return loadList().then(function () {
									ctx.navigate("#/skills");
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
		return ctx.api("GET", "/ui/api/skills").then(function (res) {
			state.skills = res.skills || [];
			state.errors = res.errors || [];
			render(true);
			if (state.errors.length > 0) {
				state.errors.forEach(function (e) {
					ctx.toast("error", "Skill parse error: " + e.name, e.error);
				});
			}
		}).catch(function (err) {
			ctx.toast("error", "Failed to load skills", err.message || String(err));
		});
	}

	function loadDetail(name) {
		return ctx.api("GET", "/ui/api/skills/" + encodeURIComponent(name)).then(function (res) {
			state.currentDetail = res.skill;
			state.lastLoadedBody = res.skill.body;
			state.lastLoadedFrontmatter = res.skill.frontmatter;
			state.selectedName = name;
			render(true);
		}).catch(function (err) {
			if (err.status === 404) {
				ctx.toast("error", "Skill not found", name);
				ctx.navigate("#/skills");
				return;
			}
			ctx.toast("error", "Failed to load skill", err.message || String(err));
		});
	}

	function mount(container, arg, dashCtx) {
		ctx = dashCtx;
		root = container;
		ctx.setBreadcrumb("Skills");
		if (!state.initialized) {
			ctx.registerDirtyChecker(isDirty);
			state.initialized = true;
		}
		return loadList().then(function () {
			if (arg) {
				return loadDetail(arg);
			}
			// Default: if any skills exist, open the first
			if (state.skills.length > 0 && !state.selectedName) {
				var first = state.skills[0].name;
				return loadDetail(first);
			}
		});
	}

	window.PhantomDashboard.registerRoute("skills", { mount: mount });
})();
