// Memory explorer tab: read and delete across episodes, facts, and
// procedures stored in Qdrant.
//
// Module contract: registers via PhantomDashboard.registerRoute("memory").
// mount(container, arg, ctx). arg is `<type>[/<id>]`; default tab episodes.
//
// All agent-authored text (summary, detail, trigger, natural_language,
// lessons, step action) renders via textContent inside <pre> nodes because
// payloads may contain any characters. esc() guards shorter identifiers.
// Delete routes through ctx.openModal; Qdrant deletes are irreversible.

(function () {
	var TYPES = ["episodes", "facts", "procedures"];
	var LIMIT = 30;
	var SEARCH_DEBOUNCE_MS = 250;

	var state = {
		health: null, healthError: null,
		activeType: "episodes", query: "",
		list: { items: [], nextOffset: null, loading: false, error: null },
		selectedId: null,
		detail: { item: null, loading: false, error: null },
	};
	var ctx = null, root = null, searchTimer = null, documentKeyHandler = null;

	function esc(s) { return ctx ? ctx.esc(s) : ""; }
	function parseIso(iso) { if (!iso) return null; var d = new Date(iso); return isNaN(d.getTime()) ? null : d; }
	function formatDate(iso) { var d = parseIso(iso); return d ? d.toISOString().slice(0, 10) : (iso ? String(iso) : ""); }
	function formatIsoShort(iso) { var d = parseIso(iso); return d ? d.toISOString().replace("T", " ").slice(0, 16) + " UTC" : (iso ? String(iso) : ""); }
	function relativeTime(iso) {
		var d = parseIso(iso);
		if (!d) return "";
		var diff = Math.max(0, Date.now() - d.getTime());
		var sec = Math.floor(diff / 1000);
		if (sec < 60) return sec + "s ago";
		var min = Math.floor(sec / 60); if (min < 60) return min + "m ago";
		var hr = Math.floor(min / 60); if (hr < 24) return hr + "h ago";
		var day = Math.floor(hr / 24); if (day < 30) return day + "d ago";
		return Math.floor(day / 30) + "mo ago";
	}
	function truncate(s, n) { if (!s) return ""; var x = String(s); return x.length <= n ? x : x.slice(0, n - 1) + "\u2026"; }
	function formatInt(n) { return (typeof n === "number" && isFinite(n)) ? Math.round(n).toLocaleString() : "0"; }

	function parseArg(arg) {
		var out = { type: "episodes", id: null };
		if (!arg) return out;
		var parts = String(arg).split("/");
		if (TYPES.indexOf(parts[0]) >= 0) out.type = parts[0];
		if (parts.length >= 2) out.id = parts.slice(1).join("/");
		return out;
	}
	function buildHash() {
		var base = "#/memory/" + state.activeType;
		return state.selectedId ? base + "/" + encodeURIComponent(state.selectedId) : base;
	}

	function render() {
		if (!root) return;
		root.innerHTML = renderHeader() + renderHealth() + renderSplit();
		wireAll();
		paintDetailText();
	}

	function renderHeader() {
		return '<div class="dash-header">' +
			'<p class="dash-header-eyebrow">Memory</p>' +
			'<h1 class="dash-header-title">Memory explorer</h1>' +
			'<p class="dash-header-lead">Every episode, fact, and procedure your agent remembers. Search to find one, then inspect the source or remove anything that looks wrong.</p>' +
			'</div>';
	}

	function metricCard(label, value) {
		return '<div class="dash-metric-card"><p class="dash-metric-label">' + esc(label) + '</p><p class="dash-metric-value">' + esc(value) + '</p></div>';
	}
	function statusCard(label, ok) {
		var cls = ok ? "dash-status-chip-active" : "dash-status-chip-error";
		var txt = ok ? "healthy" : "unavailable";
		return '<div class="dash-metric-card"><p class="dash-metric-label">' + esc(label) + '</p><p class="dash-metric-value"><span class="dash-status-chip ' + cls + '">' + esc(txt) + '</span></p></div>';
	}
	function skMetric() { return '<div class="dash-metric-card dash-metric-skeleton" aria-hidden="true"><p class="dash-metric-label">.</p><p class="dash-metric-value">.</p></div>'; }

	function renderHealth() {
		if (state.healthError) {
			return '<div class="dash-empty" style="margin-top: var(--space-4);">' +
				'<h3 class="dash-empty-title">Could not load memory health</h3>' +
				'<p class="dash-empty-body">' + esc(state.healthError) + '</p>' +
				'<button class="dash-btn dash-btn-ghost" id="memory-retry-health">Retry</button></div>';
		}
		if (!state.health) return '<div class="dash-metric-strip" aria-busy="true">' + skMetric() + skMetric() + skMetric() + skMetric() + skMetric() + '</div>';
		var h = state.health;
		return '<div class="dash-metric-strip">' +
			statusCard("Qdrant", h.qdrant) + statusCard("Ollama", h.ollama) +
			metricCard("Episodes", formatInt(h.counts.episodes)) +
			metricCard("Facts", formatInt(h.counts.facts)) +
			metricCard("Procedures", formatInt(h.counts.procedures)) +
			'</div>';
	}

	function renderSplit() {
		var open = state.selectedId ? "true" : "false";
		return '<div class="dash-split-pane" data-detail-open="' + open + '">' + renderRail() + renderMain() + '</div>';
	}

	function renderRail() {
		var tabs = TYPES.map(function (t) {
			var label = t === "episodes" ? "Episodes" : t === "facts" ? "Facts" : "Procedures";
			return '<button type="button" class="dash-tab-switcher-tab" role="tab" aria-pressed="' + (state.activeType === t ? "true" : "false") + '" data-memory-tab="' + t + '">' + esc(label) + '</button>';
		}).join("");
		var search = '<div class="dash-filter-search" style="margin: 0 var(--space-3) var(--space-3);">' +
			'<svg fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"/></svg>' +
			'<input type="search" id="memory-search" placeholder="Search ' + esc(state.activeType) + '" value="' + esc(state.query) + '" aria-label="Search memories"></div>';
		return '<div class="dash-split-pane-rail" role="complementary" aria-label="Memory list">' +
			'<div class="dash-memory-rail-head"><div class="dash-tab-switcher" role="tablist" aria-label="Memory type">' + tabs + '</div></div>' +
			search + renderList() + '</div>';
	}

	function skPill() { return '<div class="dash-table-skeleton-pill"></div>'; }
	function listSkeleton() {
		var out = [];
		for (var i = 0; i < 6; i++) out.push('<div class="dash-memory-row" aria-hidden="true"><div style="display:flex; gap:10px;">' + skPill() + '</div><div style="display:flex; gap:10px; margin-top:6px;">' + skPill() + '</div></div>');
		return out.join("");
	}

	function renderList() {
		if (state.list.loading && state.list.items.length === 0) return '<div class="dash-memory-list" aria-busy="true">' + listSkeleton() + '</div>';
		if (state.list.error) return '<div class="dash-memory-list"><div class="dash-drawer-error" style="margin: var(--space-3);">' +
			'<p style="margin:0 0 var(--space-2); font-weight:600;">Failed to load memories</p>' +
			'<p style="margin:0 0 var(--space-3);">' + esc(state.list.error) + '</p>' +
			'<button class="dash-btn dash-btn-ghost dash-btn-sm" id="memory-retry-list">Retry</button></div></div>';
		if (state.health && !state.health.qdrant) return '<div class="dash-memory-list"><div class="dash-empty" style="border:none; margin: var(--space-3);">' +
			'<h3 class="dash-empty-title">Memory system not available</h3>' +
			'<p class="dash-empty-body">Qdrant is not reachable. Check <code>docker compose ps qdrant</code> on the VM.</p></div></div>';
		if (state.list.items.length === 0) {
			var label = state.query
				? ("No " + state.activeType + " match \u201C" + state.query + "\u201D.")
				: ("No " + state.activeType + " yet. Your agent will populate these after a few sessions.");
			return '<div class="dash-memory-list"><div class="dash-empty" style="border:none; margin: var(--space-3);"><p class="dash-empty-body">' + esc(label) + '</p></div></div>';
		}
		var items = sortListItems(state.list.items);
		var rows = items.map(renderListRow).join("");
		var more = state.list.nextOffset
			? '<div style="padding: var(--space-3); display:flex; justify-content:center;"><button class="dash-btn dash-btn-ghost dash-btn-sm" id="memory-load-more">Load more</button></div>'
			: "";
		return '<div class="dash-memory-list" role="list">' + rows + more + '</div>';
	}

	function sortListItems(items) {
		if (state.activeType !== "facts") return items;
		var live = [], stale = [];
		items.forEach(function (it) { (it.valid_until ? stale : live).push(it); });
		return live.concat(stale);
	}

	function renderListRow(item) {
		var sel = state.selectedId === item.id ? "true" : "false";
		var extra = state.activeType === "facts" && item.valid_until ? " dash-memory-row-contradicted" : "";
		var body = state.activeType === "episodes" ? episodeRow(item) : state.activeType === "facts" ? factRow(item) : procedureRow(item);
		return '<div class="dash-memory-row' + extra + '" data-memory-id="' + esc(item.id) + '" role="listitem" tabindex="0" aria-current="' + sel + '">' + body + '</div>';
	}

	function episodeRow(ep) {
		var cls = ep.outcome === "success" ? "dash-status-chip-active" : ep.outcome === "failure" ? "dash-status-chip-error" : "dash-status-chip-paused";
		var tools = (ep.tools_used || []).length;
		return '<p class="dash-memory-row-title">' + esc(truncate(ep.summary || "(no summary)", 80)) + '</p>' +
			'<p class="dash-memory-row-sub">' +
			'<span>' + esc(formatDate(ep.started_at)) + '</span>' +
			'<span class="dash-status-chip ' + cls + '">' + esc(ep.outcome) + '</span>' +
			'<span>' + esc(tools + " tool" + (tools === 1 ? "" : "s")) + '</span>' +
			'<span>' + esc(truncate(ep.session_id || "", 20)) + '</span>' +
			'</p>';
	}
	function factRow(fact) {
		var pct = Math.max(0, Math.min(100, Math.round((fact.confidence || 0) * 100)));
		var contradicted = fact.valid_until ? '<span class="dash-status-chip dash-status-chip-error">contradicted</span>' : "";
		return '<p class="dash-memory-row-title">' + esc(truncate(fact.natural_language || "(no text)", 90)) + '</p>' +
			'<p class="dash-memory-row-sub">' +
			'<span class="dash-memory-chip">' + esc(fact.category || "fact") + '</span>' +
			'<span class="dash-confidence-bar" title="' + esc(pct + "% confidence") + '"><span class="dash-confidence-bar-fill" style="width:' + pct + '%;"></span></span>' +
			'<span>' + esc(formatDate(fact.valid_from)) + '</span>' + contradicted + '</p>';
	}
	function procedureRow(proc) {
		var ratio = (proc.success_count || 0) + "/" + (proc.failure_count || 0);
		return '<p class="dash-memory-row-title">' + esc(proc.name || "(unnamed)") + '</p>' +
			'<p class="dash-memory-row-sub">' +
			'<span>' + esc(truncate(proc.trigger || "", 60)) + '</span>' +
			'<span class="dash-memory-chip">' + esc(ratio) + '</span>' +
			'<span>' + esc(relativeTime(proc.last_used_at)) + '</span>' +
			'</p>';
	}

	function renderMain() {
		if (state.health && !state.health.qdrant && !state.selectedId) {
			return '<div class="dash-split-pane-main"><div class="dash-empty" style="border:none;">' +
				'<h3 class="dash-empty-title">Memory system not available</h3>' +
				'<p class="dash-empty-body">Qdrant is not reachable. Once it\u0027s back up, memories will appear here.</p></div></div>';
		}
		if (!state.selectedId) {
			return '<div class="dash-split-pane-main"><div class="dash-empty" style="border:none;">' +
				'<h3 class="dash-empty-title">Select a memory</h3>' +
				'<p class="dash-empty-body">Pick any row on the left to see the full record, its source sessions, and the delete action.</p></div></div>';
		}
		return '<div class="dash-split-pane-main">' + renderMainBody() + '</div>';
	}

	function renderMainBody() {
		var back = '<button type="button" class="dash-btn dash-btn-ghost dash-btn-sm dash-memory-back-btn" id="memory-back-btn">\u2039 Back to list</button>';
		if (state.detail.loading && !state.detail.item) {
			return back + '<div aria-busy="true" style="display:flex; flex-direction:column; gap:12px; margin-top: var(--space-3);">' + skPill() + skPill() + skPill() + skPill() + '</div>';
		}
		if (state.detail.error && !state.detail.item) {
			return back + '<div class="dash-drawer-error">' +
				'<p style="margin:0 0 var(--space-2); font-weight:600;">Could not load memory</p>' +
				'<p style="margin:0 0 var(--space-3);">' + esc(state.detail.error) + '</p>' +
				'<button class="dash-btn dash-btn-ghost dash-btn-sm" id="memory-retry-detail">Retry</button></div>';
		}
		if (!state.detail.item) return back + '<p class="phantom-muted">No memory loaded.</p>';
		var item = state.detail.item;
		return back + detailHeader(item) + (state.activeType === "episodes" ? episodeDetail(item) : state.activeType === "facts" ? factDetail(item) : procedureDetail(item));
	}

	function detailHeader(item) {
		var title = state.activeType === "episodes" ? truncate(item.summary || "(no summary)", 120)
			: state.activeType === "facts" ? truncate(item.natural_language || "(no text)", 120)
			: (item.name || "(unnamed procedure)");
		return '<div class="dash-memory-detail-header">' +
			'<div><p class="dash-drawer-eyebrow">' + esc(state.activeType) + '</p>' +
			'<h2 class="dash-drawer-title">' + esc(title) + '</h2>' +
			'<p class="dash-memory-detail-id">' + esc(item.id) + '</p></div>' +
			'<div class="dash-memory-detail-actions">' +
			'<button type="button" class="dash-btn dash-btn-ghost dash-btn-sm" id="memory-copy-json">Copy as JSON</button>' +
			'<button type="button" class="dash-btn dash-btn-danger dash-btn-sm" id="memory-delete-btn">Delete memory</button>' +
			'</div></div>';
	}

	function section(label, inner) {
		return '<section class="dash-drawer-section"><p class="dash-drawer-section-label">' + esc(label) + '</p>' + inner + '</section>';
	}
	function metaRow(k, v) { return '<span class="dash-memory-meta-grid-key">' + esc(k) + '</span><span>' + esc(v) + '</span>'; }
	function sessionsPills(ids) {
		if (!ids || ids.length === 0) return '<span class="phantom-muted">none</span>';
		return ids.map(function (id) {
			return '<a href="#/sessions/' + esc(encodeURIComponent(id)) + '" class="dash-session-pill" data-session-key="' + esc(id) + '">' + esc(id) + '</a>';
		}).join(" ");
	}
	function chipList(values) {
		if (!values || values.length === 0) return '<span class="phantom-muted">none</span>';
		return values.map(function (v) { return '<span class="dash-memory-chip">' + esc(v) + '</span>'; }).join(" ");
	}
	function textPre(field) { return '<pre class="dash-memory-text" data-memory-text="' + esc(field) + '"></pre>'; }

	function episodeDetail(ep) {
		var meta = '<div class="dash-memory-meta-grid">' +
			metaRow("Type", ep.type || "task") + metaRow("Outcome", ep.outcome) +
			metaRow("Importance", (ep.importance || 0).toFixed(2)) +
			metaRow("Access count", String(ep.access_count || 0)) +
			metaRow("Decay rate", (ep.decay_rate || 1).toFixed(2)) +
			metaRow("Started", formatIsoShort(ep.started_at)) +
			metaRow("Ended", formatIsoShort(ep.ended_at)) +
			metaRow("Duration", (ep.duration_seconds || 0) + "s") +
			'</div>';
		var lessons = (ep.lessons && ep.lessons.length > 0)
			? section("Lessons", '<ol style="margin:0; padding-left: 20px; display:flex; flex-direction:column; gap:6px;">' +
				ep.lessons.map(function (_, i) { return '<li><pre class="dash-memory-text" data-memory-lesson-idx="' + i + '"></pre></li>'; }).join("") +
				'</ol>')
			: "";
		return meta +
			section("Session", ep.session_id ? sessionsPills([ep.session_id]) : '<span class="phantom-muted">none</span>') +
			section("Summary", textPre("summary")) +
			section("Detail", textPre("detail")) +
			section("Tools used", chipList(ep.tools_used)) +
			section("Files touched", chipList(ep.files_touched)) +
			lessons;
	}

	function factDetail(fact) {
		var pct = Math.max(0, Math.min(100, Math.round((fact.confidence || 0) * 100)));
		var triple = '<div class="dash-memory-meta-grid">' +
			metaRow("Subject", fact.subject || "") + metaRow("Predicate", fact.predicate || "") +
			metaRow("Object", fact.object || "") + metaRow("Category", fact.category || "") +
			metaRow("Version", String(fact.version || 1)) +
			metaRow("Valid from", formatIsoShort(fact.valid_from)) +
			metaRow("Valid until", fact.valid_until ? formatIsoShort(fact.valid_until) : "present") +
			'</div>';
		var conf = section("Confidence",
			'<div style="display:flex; align-items:center; gap:10px;">' +
			'<span class="dash-confidence-bar" style="width:120px;"><span class="dash-confidence-bar-fill" style="width:' + pct + '%;"></span></span>' +
			'<span class="phantom-muted">' + esc(pct + "%") + '</span></div>');
		var contradicted = fact.valid_until
			? section("Status", '<span class="dash-status-chip dash-status-chip-error">contradicted</span> <span class="phantom-muted">superseded at ' + esc(formatIsoShort(fact.valid_until)) + '</span>')
			: "";
		return section("Natural language", textPre("natural_language")) +
			triple + conf + contradicted +
			section("Source episodes", sessionsPills(fact.source_episode_ids)) +
			section("Tags", chipList(fact.tags));
	}

	function procedureDetail(proc) {
		var total = (proc.success_count || 0) + (proc.failure_count || 0);
		var pct = total === 0 ? 0 : Math.round((proc.success_count / total) * 100);
		var meta = '<div class="dash-memory-meta-grid">' +
			metaRow("Name", proc.name || "") + metaRow("Version", String(proc.version || 1)) +
			metaRow("Confidence", (proc.confidence || 0).toFixed(2)) +
			metaRow("Last used", formatIsoShort(proc.last_used_at)) +
			metaRow("Success", String(proc.success_count || 0)) +
			metaRow("Failure", String(proc.failure_count || 0)) +
			'</div>';
		var ratio = section("Success ratio",
			'<div style="display:flex; align-items:center; gap:10px;">' +
			'<span class="dash-confidence-bar" style="width:160px;"><span class="dash-confidence-bar-fill" style="width:' + pct + '%;"></span></span>' +
			'<span class="phantom-muted">' + esc(pct + "% (" + (proc.success_count || 0) + " / " + total + ")") + '</span></div>');
		var steps;
		if (!proc.steps || proc.steps.length === 0) {
			steps = section("Steps", '<span class="phantom-muted">none</span>');
		} else {
			var body = proc.steps.map(function (s, i) {
				return '<li class="dash-memory-step">' +
					'<div class="dash-memory-step-head">' +
					'<span class="dash-memory-step-num">' + esc(String(s.order || i + 1)) + '</span>' +
					(s.tool ? '<span class="dash-memory-chip">' + esc(s.tool) + '</span>' : "") +
					(s.decision_point ? '<span class="dash-status-chip dash-status-chip-info">decision</span>' : "") +
					'</div>' +
					'<pre class="dash-memory-text" data-memory-step-idx="' + i + '" data-memory-step-field="action"></pre>' +
					(s.expected_outcome ? '<pre class="dash-memory-text" data-memory-step-idx="' + i + '" data-memory-step-field="expected_outcome"></pre>' : "") +
					'</li>';
			}).join("");
			steps = section("Steps", '<ol class="dash-memory-steps">' + body + '</ol>');
		}
		return meta + section("Description", textPre("description")) + section("Trigger", textPre("trigger")) + ratio + steps;
	}

	function paintDetailText() {
		if (!state.detail.item || !root) return;
		var item = state.detail.item;
		var nodes = root.querySelectorAll("[data-memory-text]");
		for (var i = 0; i < nodes.length; i++) {
			var field = nodes[i].getAttribute("data-memory-text");
			nodes[i].textContent = (item && item[field]) ? String(item[field]) : "(empty)";
		}
		if (Array.isArray(item.lessons)) {
			var lessons = root.querySelectorAll("[data-memory-lesson-idx]");
			for (var j = 0; j < lessons.length; j++) {
				lessons[j].textContent = item.lessons[Number(lessons[j].getAttribute("data-memory-lesson-idx"))] || "";
			}
		}
		if (Array.isArray(item.steps)) {
			var stepNodes = root.querySelectorAll("[data-memory-step-idx]");
			for (var k = 0; k < stepNodes.length; k++) {
				var step = item.steps[Number(stepNodes[k].getAttribute("data-memory-step-idx"))];
				var f = stepNodes[k].getAttribute("data-memory-step-field");
				stepNodes[k].textContent = (step && step[f]) ? String(step[f]) : "";
			}
		}
	}

	function wireAll() {
		var retryHealth = document.getElementById("memory-retry-health");
		if (retryHealth) retryHealth.addEventListener("click", loadHealth);

		var tabs = root.querySelectorAll("[data-memory-tab]");
		for (var i = 0; i < tabs.length; i++) tabs[i].addEventListener("click", onTabClick);

		var search = document.getElementById("memory-search");
		if (search) {
			search.addEventListener("input", function (e) {
				var val = e.currentTarget.value;
				if (searchTimer) clearTimeout(searchTimer);
				searchTimer = setTimeout(function () { state.query = val; loadList(true); }, SEARCH_DEBOUNCE_MS);
			});
			search.addEventListener("keydown", function (e) {
				if (e.key === "Escape") { search.value = ""; state.query = ""; loadList(true); }
			});
		}

		var rows = root.querySelectorAll("[data-memory-id]");
		for (var j = 0; j < rows.length; j++) {
			rows[j].addEventListener("click", onRowClick);
			rows[j].addEventListener("keydown", onRowKey);
		}
		var more = document.getElementById("memory-load-more");
		if (more) more.addEventListener("click", onLoadMore);
		var retryList = document.getElementById("memory-retry-list");
		if (retryList) retryList.addEventListener("click", function () { loadList(true); });
		var back = document.getElementById("memory-back-btn");
		if (back) back.addEventListener("click", function () {
			state.selectedId = null;
			state.detail = { item: null, loading: false, error: null };
			ctx.navigate(buildHash());
			render();
		});
		var copy = document.getElementById("memory-copy-json");
		if (copy) copy.addEventListener("click", onCopyJson);
		var del = document.getElementById("memory-delete-btn");
		if (del) del.addEventListener("click", onDeleteClick);
		var retryDetail = document.getElementById("memory-retry-detail");
		if (retryDetail) retryDetail.addEventListener("click", function () { loadDetail(state.selectedId); });
		var pills = root.querySelectorAll(".dash-session-pill");
		for (var p = 0; p < pills.length; p++) {
			pills[p].addEventListener("click", function (e) {
				e.preventDefault();
				e.stopPropagation();
				var key = e.currentTarget.getAttribute("data-session-key");
				if (key) ctx.navigate("#/sessions/" + encodeURIComponent(key));
			});
		}
	}

	function onTabClick(e) {
		var tab = e.currentTarget.getAttribute("data-memory-tab");
		if (!tab || tab === state.activeType) return;
		state.activeType = tab;
		state.selectedId = null;
		state.detail = { item: null, loading: false, error: null };
		state.query = "";
		ctx.navigate(buildHash());
		loadList(true);
	}
	function onRowClick(e) {
		e.preventDefault();
		var id = e.currentTarget.getAttribute("data-memory-id");
		if (!id) return;
		state.selectedId = id;
		ctx.navigate(buildHash());
		loadDetail(id);
	}
	function onRowKey(e) {
		if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onRowClick(e); }
	}
	function onLoadMore() {
		if (!state.list.nextOffset) return;
		var prev = state.list.nextOffset;
		state.list.loading = true;
		ctx.api("GET", listUrl(prev))
			.then(function (res) {
				state.list.loading = false;
				state.list.items = state.list.items.concat(res.items || []);
				state.list.nextOffset = res.nextOffset || null;
				render();
			})
			.catch(function (err) {
				state.list.loading = false;
				ctx.toast("error", "Failed to load more", err.message || String(err));
			});
	}
	function onCopyJson() {
		if (!state.detail.item) return;
		var text = JSON.stringify(state.detail.item, null, 2);
		if (navigator.clipboard && navigator.clipboard.writeText) {
			navigator.clipboard.writeText(text)
				.then(function () { ctx.toast("success", "Copied to clipboard"); })
				.catch(function () { ctx.toast("error", "Copy failed", "Clipboard API rejected the write."); });
		} else {
			ctx.toast("error", "Copy failed", "Clipboard API is unavailable.");
		}
	}
	function onDeleteClick() {
		if (!state.detail.item) return;
		var item = state.detail.item;
		var body = document.createElement("div");
		var p1 = document.createElement("p");
		p1.style.margin = "0 0 var(--space-2)";
		p1.textContent = "This cannot be undone. The memory will be permanently removed from Qdrant and will no longer inform the agent\u2019s responses.";
		var idLine = document.createElement("p");
		idLine.className = "phantom-muted";
		idLine.style.margin = "0";
		idLine.style.fontSize = "12px";
		idLine.textContent = state.activeType.slice(0, -1) + " id: " + item.id;
		body.appendChild(p1);
		body.appendChild(idLine);
		ctx.openModal({
			title: "Delete this memory?",
			body: body,
			actions: [
				{ label: "Cancel", className: "dash-btn-ghost" },
				{
					label: "Delete memory",
					className: "dash-btn-danger",
					onClick: function () { return performDelete(item.id); },
				},
			],
		});
	}
	function performDelete(id) {
		return ctx.api("DELETE", "/ui/api/memory/" + state.activeType + "/" + encodeURIComponent(id))
			.then(function () {
				ctx.toast("success", "Memory deleted");
				state.list.items = state.list.items.filter(function (it) { return it.id !== id; });
				if (state.selectedId === id) {
					state.selectedId = null;
					state.detail = { item: null, loading: false, error: null };
					ctx.navigate(buildHash());
				}
				render();
				return true;
			})
			.catch(function (err) {
				ctx.toast("error", "Failed to delete", err.message || String(err));
				return false;
			});
	}

	function listUrl(offset) {
		var base = "/ui/api/memory/" + state.activeType;
		var params = new URLSearchParams();
		params.set("limit", String(LIMIT));
		var q = (state.query || "").trim();
		if (q) params.set("q", q);
		if (offset) params.set("offset", String(offset));
		var s = params.toString();
		return s ? base + "?" + s : base;
	}

	function loadHealth() {
		state.healthError = null;
		ctx.api("GET", "/ui/api/memory/health")
			.then(function (res) { state.health = res; render(); })
			.catch(function (err) { state.healthError = err.message || String(err); render(); });
	}
	function loadList(reset) {
		if (reset) {
			state.list.items = [];
			state.list.nextOffset = null;
			state.list.error = null;
		}
		state.list.loading = true;
		render();
		return ctx.api("GET", listUrl(null))
			.then(function (res) {
				state.list.loading = false;
				state.list.items = res.items || [];
				state.list.nextOffset = res.nextOffset || null;
				render();
			})
			.catch(function (err) {
				state.list.loading = false;
				state.list.error = err.message || String(err);
				render();
				ctx.toast("error", "Failed to load memories", state.list.error);
			});
	}
	function loadDetail(id) {
		if (!id) return Promise.resolve();
		state.detail = { item: null, loading: true, error: null };
		render();
		return ctx.api("GET", "/ui/api/memory/" + state.activeType + "/" + encodeURIComponent(id))
			.then(function (res) { state.detail.loading = false; state.detail.item = res.item; render(); })
			.catch(function (err) { state.detail.loading = false; state.detail.error = err.message || String(err); render(); });
	}

	function installGlobalKeys() {
		if (documentKeyHandler) return;
		documentKeyHandler = function (e) {
			if (e.key !== "/") return;
			var tag = (document.activeElement && document.activeElement.tagName) || "";
			if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
			if (e.metaKey || e.ctrlKey || e.altKey) return;
			if ((window.location.hash || "").indexOf("#/memory") !== 0) return;
			var search = document.getElementById("memory-search");
			if (search) { e.preventDefault(); search.focus(); search.select(); }
		};
		document.addEventListener("keydown", documentKeyHandler);
	}

	function mount(container, arg, dashCtx) {
		ctx = dashCtx;
		root = container;
		ctx.setBreadcrumb("Memory");
		installGlobalKeys();
		var parsed = parseArg(arg);
		state.activeType = parsed.type;
		state.selectedId = parsed.id;
		state.query = "";
		state.list = { items: [], nextOffset: null, loading: true, error: null };
		state.detail = { item: null, loading: false, error: null };
		render();
		loadHealth();
		return loadList(true).then(function () { if (state.selectedId) return loadDetail(state.selectedId); });
	}

	if (window.PhantomDashboard && window.PhantomDashboard.registerRoute) {
		window.PhantomDashboard.registerRoute("memory", { mount: mount });
	}
})();
