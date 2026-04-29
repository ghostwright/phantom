// Memory files tab: list, create, edit, delete arbitrary .md files under
// /home/phantom/.claude/ (excluding skills/, plugins/, agents/, settings.json).

(function () {
	var state = {
		files: [],
		selectedPath: null,
		currentFile: null,
		lastLoadedContent: "",
		search: "",
		initialized: false,
	};
	var ctx = null;
	var root = null;

	function esc(s) { return ctx.esc(s); }

	function isDirty() {
		if (!state.currentFile) return false;
		if (state.currentFile.read_only) return false;
		var el = document.getElementById("memfile-body");
		if (!el) return false;
		// HTML spec: textareas strip a single leading newline from their
		// initial value. Normalize the baseline the same way so files that
		// begin with "\n" do not read as dirty on every mount.
		var baseline = state.lastLoadedContent || "";
		if (baseline.charAt(0) === "\n") baseline = baseline.slice(1);
		return el.value !== baseline;
	}

	function filteredFiles() {
		var q = (state.search || "").trim().toLowerCase();
		if (!q) return state.files;
		return state.files.filter(function (f) { return f.path.toLowerCase().indexOf(q) >= 0; });
	}

	function specialDescription(topLevel, path, file) {
		if (file && file.description) return file.description;
		if (path === "CLAUDE.md") return "Your agent's top-level memory. Loaded at the start of every session.";
		if (topLevel === "rules") return "Rule file. Applies conditionally if frontmatter defines paths.";
		if (topLevel === "memory") return "Free-form memory note.";
		if (topLevel === "phantom-config") return "Agent-maintained memory. Read-only in the dashboard.";
		return "Markdown memory file.";
	}

	function renderHeader() {
		return (
			'<div class="dash-header">' +
			'<p class="dash-header-eyebrow">Memory files</p>' +
			'<h1 class="dash-header-title">Memory files</h1>' +
			'<p class="dash-header-lead">Persistent markdown under /home/phantom/.claude/. CLAUDE.md is the top-level memory your agent loads every session. Rules, notes, and free-form markdown live here alongside it.</p>' +
			'<div class="dash-header-actions">' +
			'<button class="dash-btn dash-btn-primary" id="memfile-new-btn">New memory file</button>' +
			'</div>' +
			'</div>'
		);
	}

	function renderListCard(file) {
		var isSelected = state.selectedPath === file.path ? ' aria-current="page"' : "";
		var label = file.path === "CLAUDE.md" ? "top-level" : file.top_level;
		if (file.read_only) label = label + " (read-only)";
		var sizeKb = file.size ? (file.size / 1024).toFixed(1) + " KB" : "";
		return (
			'<a href="#/memory-files/' + encodeURIComponent(file.path) + '" class="dash-list-card"' + isSelected + '>' +
			'<div class="dash-list-card-row">' +
			'<h3 class="dash-list-card-title">' + esc(file.path) + '</h3>' +
			'<span class="dash-source-chip dash-source-chip-user">' + esc(label) + '</span>' +
			'</div>' +
			'<p class="dash-list-card-desc">' + esc(specialDescription(file.top_level, file.path, file)) + '</p>' +
			'<div class="dash-list-card-meta"><span>' + sizeKb + '</span></div>' +
			'</a>'
		);
	}

	function renderListColumn() {
		var list = filteredFiles();
		var parts = [];
		parts.push('<div class="dash-list-search">');
		parts.push('<svg fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"/></svg>');
		parts.push('<input type="search" id="memfile-search" placeholder="Search paths" value="' + esc(state.search) + '">');
		parts.push('</div>');

		if (state.files.length === 0) {
			parts.push(
				'<div class="dash-empty">' +
				'<svg class="dash-empty-icon" fill="none" viewBox="0 0 24 24" stroke-width="1.2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"/></svg>' +
				'<h3 class="dash-empty-title">No memory files yet</h3>' +
				'<p class="dash-empty-body">Create a CLAUDE.md for top-level memory, or drop any markdown under <span class="phantom-mono">memory/</span> or <span class="phantom-mono">rules/</span>.</p>' +
				'<button class="dash-btn dash-btn-primary" id="memfile-new-btn-empty">New memory file</button>' +
				'</div>'
			);
			return '<aside class="dash-list">' + parts.join("") + '</aside>';
		}

		// Group by top-level directory
		var byGroup = {};
		list.forEach(function (f) {
			var key = f.path === "CLAUDE.md" ? "top" : f.top_level;
			if (!byGroup[key]) byGroup[key] = [];
			byGroup[key].push(f);
		});
		var order = ["top", "rules", "memory", "phantom-config"];
		Object.keys(byGroup).forEach(function (k) {
			if (order.indexOf(k) < 0) order.push(k);
		});
		order.forEach(function (k) {
			if (!byGroup[k]) return;
			var label = k === "top" ? "Top level" : k;
			parts.push('<p class="dash-list-group-label">' + esc(label) + "</p>");
			byGroup[k].forEach(function (f) { parts.push(renderListCard(f)); });
		});

		if (list.length === 0) {
			parts.push('<div class="dash-empty" style="padding:var(--space-6) var(--space-4);"><p class="dash-empty-body">No files match "' + esc(state.search) + '".</p></div>');
		}
		return '<aside class="dash-list">' + parts.join("") + '</aside>';
	}

	function renderEditor() {
		if (!state.currentFile) {
			return (
				'<div class="dash-editor">' +
				'<div class="dash-empty" style="border:none;">' +
				'<svg class="dash-empty-icon" fill="none" viewBox="0 0 24 24" stroke-width="1.2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 17.25 21 12m0 0-5.25-5.25M21 12H3"/></svg>' +
				'<h3 class="dash-empty-title">Pick a memory file</h3>' +
				'<p class="dash-empty-body">Select a file from the left to view or edit it, or create a new one from the button above.</p>' +
				'</div>' +
				'</div>'
			);
		}
		var f = state.currentFile;
		var noteHtml = "";
		if (f.path === "CLAUDE.md") {
			noteHtml = '<div class="dash-alert dash-alert-info" style="margin-bottom:var(--space-4);"><span>This is your agent\'s top-level memory. It loads at the start of every conversation.</span></div>';
		} else if (f.read_only) {
			var readOnlyMsg = f.description
				? f.description + '. Read-only in the dashboard: the agent manages this file directly.'
				: 'Read-only in the dashboard: the agent manages this file directly.';
			noteHtml = '<div class="dash-alert dash-alert-info" style="margin-bottom:var(--space-4);"><span>' + esc(readOnlyMsg) + '</span></div>';
		}

		var subtitlePath = f.read_only ? "phantom-config/memory/" + esc(f.path.replace("phantom-config/memory/", "")) : "/home/phantom/.claude/" + esc(f.path);
		var actionsHtml = f.read_only
			? ""
			: '<button class="dash-btn dash-btn-ghost dash-btn-sm" id="memfile-delete-btn">Delete</button>' +
			  '<button class="dash-btn dash-btn-primary dash-btn-sm" id="memfile-save-btn" disabled>Save</button>';
		var textareaAttrs = f.read_only ? ' readonly' : '';
		var hintText = f.read_only
			? 'Markdown. ' + (f.size / 1024).toFixed(1) + ' KB. Read-only view.'
			: 'Markdown. ' + (f.size / 1024).toFixed(1) + ' KB. Saved atomically.';

		return (
			'<section class="dash-editor" aria-labelledby="memfile-editor-title">' +
			'<header class="dash-editor-header">' +
			'<div class="dash-editor-title-wrap">' +
			'<h2 class="dash-editor-title" id="memfile-editor-title">' + esc(f.path) + ' <span class="dash-dirty-dot" id="memfile-dirty-dot" data-dirty="false" aria-label="unsaved changes"></span></h2>' +
			'<p class="dash-editor-subtitle">' + subtitlePath + '</p>' +
			'</div>' +
			'<div class="dash-editor-actions">' +
			actionsHtml +
			'</div>' +
			'</header>' +

			noteHtml +

			'<div class="dash-form">' +
			'<div class="dash-field">' +
			'<label class="dash-field-label" for="memfile-body">Content</label>' +
			'<textarea class="dash-textarea dash-textarea-tall" id="memfile-body" spellcheck="false"' + textareaAttrs + '>' + esc(f.content) + '</textarea>' +
			'<div class="dash-field-hint">' + hintText + '</div>' +
			'</div>' +
			'</div>' +
			'</section>'
		);
	}

	function wireSearch() {
		var search = document.getElementById("memfile-search");
		if (!search) return;
		search.addEventListener("input", function () {
			state.search = search.value || "";
			var col = document.getElementById("memfile-list-col");
			if (!col) return;
			var wrapper = document.createElement("div");
			wrapper.innerHTML = renderListColumn();
			col.innerHTML = wrapper.firstChild.innerHTML;
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

	function updateDirtyState() {
		var dot = document.getElementById("memfile-dirty-dot");
		var save = document.getElementById("memfile-save-btn");
		var dirty = isDirty();
		if (dot) dot.setAttribute("data-dirty", dirty ? "true" : "false");
		if (save) save.disabled = !dirty;
	}

	function render(rewireList) {
		if (rewireList === undefined) rewireList = true;
		var listHtml = renderListColumn();
		var editorHtml = renderEditor();
		root.innerHTML = (
			renderHeader() +
			'<div class="dash-split">' +
			'<div id="memfile-list-col">' + listHtml + '</div>' +
			'<div id="memfile-editor-col">' + editorHtml + '</div>' +
			'</div>'
		);
		if (rewireList) {
			wireSearch();
			wireListClicks();
			var newBtn = document.getElementById("memfile-new-btn");
			if (newBtn) newBtn.addEventListener("click", openNewModal);
			var newBtnEmpty = document.getElementById("memfile-new-btn-empty");
			if (newBtnEmpty) newBtnEmpty.addEventListener("click", openNewModal);
		}
		var bodyEl = document.getElementById("memfile-body");
		if (bodyEl) {
			bodyEl.addEventListener("input", updateDirtyState);
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
					saveFile();
				}
			});
		}
		var saveBtn = document.getElementById("memfile-save-btn");
		if (saveBtn) saveBtn.addEventListener("click", saveFile);
		var deleteBtn = document.getElementById("memfile-delete-btn");
		if (deleteBtn) deleteBtn.addEventListener("click", confirmDelete);

		if (state.currentFile) {
			updateDirtyState();
			ctx.setBreadcrumb(state.currentFile.path);
		} else {
			ctx.setBreadcrumb("Memory files");
		}
	}

	function openNewModal() {
		var body = document.createElement("div");
		body.innerHTML = (
			'<p style="font-size:13px; line-height:1.55; color:color-mix(in oklab, var(--color-base-content) 68%, transparent); margin:0 0 var(--space-4);">Any markdown path under <span class="phantom-mono">.claude/</span>. Subdirectories are created automatically.</p>' +
			'<div class="dash-form">' +
			'<div class="dash-field">' +
			'<label class="dash-field-label" for="new-memfile-path">Path (relative to .claude)</label>' +
			'<input class="dash-input" id="new-memfile-path" placeholder="memory/my-notes.md" autocomplete="off">' +
			'<div class="dash-field-hint">Must end in <span class="phantom-mono">.md</span>. Examples: <span class="phantom-mono">CLAUDE.md</span>, <span class="phantom-mono">rules/no-friday-deploys.md</span>, <span class="phantom-mono">memory/people/cheema.md</span>.</div>' +
			'</div>' +
			'</div>'
		);
		ctx.openModal({
			title: "New memory file",
			body: body,
			actions: [
				{ label: "Cancel", className: "dash-btn-ghost", onClick: function () {} },
				{
					label: "Create",
					className: "dash-btn-primary",
					onClick: function () {
						var path = document.getElementById("new-memfile-path").value.trim();
						if (!path.endsWith(".md")) {
							ctx.toast("error", "Invalid path", "Path must end in .md");
							return false;
						}
						return ctx.api("POST", "/ui/api/memory-files", { path: path, content: "" })
							.then(function (res) {
								ctx.toast("success", "Created", path);
								return loadList().then(function () {
									ctx.navigate("#/memory-files/" + encodeURIComponent(res.file.path));
								});
							})
							.catch(function (err) {
								ctx.toast("error", "Create failed", err.message || String(err));
								return false;
							});
					},
				},
			],
		});
	}

	function saveFile() {
		if (!state.currentFile) return;
		if (state.currentFile.read_only) return;
		var body = document.getElementById("memfile-body").value;
		var saveBtn = document.getElementById("memfile-save-btn");
		if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Saving"; }
		var path = state.currentFile.path;
		// HTML spec strips one leading newline from textarea initial value,
		// so the browser never shows it and `body` here never contains it.
		// Re-prepend if the on-disk baseline had one so the file survives
		// a round trip without silent data loss on the first save.
		var prefix = state.lastLoadedContent && state.lastLoadedContent.charAt(0) === "\n" ? "\n" : "";
		var content = prefix + body;
		ctx.api("PUT", "/ui/api/memory-files/" + encodeURIComponent(path), { content: content })
			.then(function (res) {
				state.currentFile = res.file;
				state.lastLoadedContent = res.file.content;
				if (saveBtn) { saveBtn.textContent = "Save"; }
				updateDirtyState();
				ctx.toast("success", "Saved", "Picked up on your agent's next session.");
				loadList();
			})
			.catch(function (err) {
				if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Save"; }
				ctx.toast("error", "Save failed", err.message || String(err));
			});
	}

	function confirmDelete() {
		if (!state.currentFile) return;
		var path = state.currentFile.path;
		ctx.openModal({
			title: "Delete " + path + "?",
			body: "This removes the file from /home/phantom/.claude/" + path + ". You can re-create it later.",
			actions: [
				{ label: "Cancel", className: "dash-btn-ghost", onClick: function () {} },
				{
					label: "Delete",
					className: "dash-btn-danger",
					onClick: function () {
						return ctx.api("DELETE", "/ui/api/memory-files/" + encodeURIComponent(path))
							.then(function () {
								state.currentFile = null;
								state.lastLoadedContent = "";
								state.selectedPath = null;
								ctx.toast("success", "Deleted", path);
								return loadList().then(function () { ctx.navigate("#/memory-files"); });
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
		return ctx.api("GET", "/ui/api/memory-files").then(function (res) {
			state.files = res.files || [];
			render(true);
		}).catch(function (err) {
			ctx.toast("error", "Failed to load memory files", err.message || String(err));
		});
	}

	function loadDetail(path) {
		return ctx.api("GET", "/ui/api/memory-files/" + encodeURIComponent(path)).then(function (res) {
			state.currentFile = res.file;
			state.lastLoadedContent = res.file.content;
			state.selectedPath = path;
			render(true);
		}).catch(function (err) {
			if (err.status === 404) {
				ctx.toast("error", "Memory file not found", path);
				ctx.navigate("#/memory-files");
				return;
			}
			ctx.toast("error", "Failed to load memory file", err.message || String(err));
		});
	}

	function mount(container, arg, dashCtx) {
		ctx = dashCtx;
		root = container;
		ctx.setBreadcrumb("Memory files");
		if (!state.initialized) {
			ctx.registerDirtyChecker(isDirty);
			state.initialized = true;
		}
		return loadList().then(function () {
			if (arg) return loadDetail(arg);
			if (state.files.length > 0 && !state.selectedPath) {
				return loadDetail(state.files[0].path);
			}
		});
	}

	window.PhantomDashboard.registerRoute("memory-files", { mount: mount });
})();
