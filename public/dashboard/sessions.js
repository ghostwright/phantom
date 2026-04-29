// Sessions tab: read-only view of every conversation across every channel.
//
// Module contract: registers with PhantomDashboard via
// registerRoute('sessions', { mount }). mount(container, arg, ctx) is called
// on hash change. When arg is present the detail drawer opens immediately
// with a skeleton, then fills once the detail fetch returns.
//
// All values from the API flow through ctx.esc() or textContent. No data
// concatenation into innerHTML. Operator-controlled fields include
// conversation_id, session_key, chat title, sdk_session_id, agent name.

(function () {
	var CHANNELS = ["slack", "chat", "telegram", "email", "webhook", "scheduler", "cli", "mcp", "trigger"];
	var COLOR_PALETTE_LENGTH = 8;
	var SEARCH_DEBOUNCE_MS = 250;

	var state = {
		loading: false,
		detailLoading: false,
		listError: null,
		detailError: null,
		list: null,
		detail: null,
		openKey: null,
		sort: { column: "last_active_at", direction: "desc" },
		filter: { channel: "all", days: "7", status: "all", q: "" },
	};
	var ctx = null;
	var root = null;
	var searchDebounceTimer = null;
	var drawerRoot = null;
	var drawerKeyHandler = null;
	var drawerFocusRestore = null;
	var prevBodyOverflow = null;
	var documentKeyHandler = null;

	function esc(s) { return ctx.esc(s); }

	function channelGlyph(channelId) {
		var map = {
			slack: "\u0023", // hash
			chat: "\u25CF", // filled circle
			telegram: "\u2709", // envelope
			email: "\u2709",
			webhook: "\u21AA", // hook arrow
			scheduler: "\u231A", // watch
			cli: "\u203A", // prompt
			mcp: "\u29BE", // circle with dot
			trigger: "\u26A1", // bolt
		};
		return map[channelId] || "\u25A1"; // square
	}

	function channelColorIdx(channelId) {
		var idx = CHANNELS.indexOf(channelId);
		if (idx < 0) idx = Math.abs(hashString(channelId));
		return idx % COLOR_PALETTE_LENGTH;
	}

	function hashString(s) {
		var h = 0;
		for (var i = 0; i < s.length; i++) {
			h = ((h << 5) - h + s.charCodeAt(i)) | 0;
		}
		return h;
	}

	function formatCost(n) {
		if (typeof n !== "number" || !isFinite(n)) return "$0.00";
		if (n < 0.01 && n > 0) return "<$0.01";
		return "$" + n.toFixed(2);
	}

	function formatInt(n) {
		if (typeof n !== "number" || !isFinite(n)) return "0";
		return Math.round(n).toLocaleString();
	}

	function parseSqlDate(s) {
		if (!s) return null;
		// SQLite "YYYY-MM-DD HH:MM:SS" is treated as UTC by phantom's storage.
		var iso = String(s).replace(" ", "T") + "Z";
		var d = new Date(iso);
		if (isNaN(d.getTime())) {
			d = new Date(s);
			if (isNaN(d.getTime())) return null;
		}
		return d;
	}

	function relativeTime(s) {
		var d = parseSqlDate(s);
		if (!d) return "";
		var diff = Date.now() - d.getTime();
		if (diff < 0) diff = 0;
		var sec = Math.floor(diff / 1000);
		if (sec < 60) return sec + "s ago";
		var min = Math.floor(sec / 60);
		if (min < 60) return min + "m ago";
		var hr = Math.floor(min / 60);
		if (hr < 24) return hr + "h ago";
		var day = Math.floor(hr / 24);
		if (day < 30) return day + "d ago";
		var mo = Math.floor(day / 30);
		if (mo < 12) return mo + "mo ago";
		var yr = Math.floor(day / 365);
		return yr + "y ago";
	}

	function absoluteTime(s) {
		var d = parseSqlDate(s);
		if (!d) return "";
		return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
	}

	function conversationCell(row) {
		if (row.channel_id === "chat") {
			var title = row.chat && row.chat.title ? row.chat.title : row.conversation_id;
			return esc(title);
		}
		if (row.channel_id === "slack") {
			var parts = String(row.conversation_id || "").split("/");
			if (parts.length >= 2) {
				return '<span class="phantom-muted">' + esc(parts[0]) + ' / </span>' + esc(parts.slice(1).join("/"));
			}
			return esc(row.conversation_id);
		}
		return esc(row.conversation_id);
	}

	function renderHeader() {
		return (
			'<div class="dash-header">' +
			'<p class="dash-header-eyebrow">Sessions</p>' +
			'<h1 class="dash-header-title">Sessions</h1>' +
			'<p class="dash-header-lead">Every conversation your agent has had, across every channel. Click a row for cost events, tokens, and a jump link back to where it started.</p>' +
			'<div class="dash-header-actions">' +
			'<button class="dash-btn dash-btn-ghost" id="sessions-export-btn">Export CSV</button>' +
			'</div>' +
			'</div>'
		);
	}

	function renderFilterBar() {
		var channelOpts = ['<option value="all">All channels</option>'];
		var present = {};
		CHANNELS.forEach(function (c) {
			present[c] = true;
			channelOpts.push('<option value="' + esc(c) + '"' + (state.filter.channel === c ? " selected" : "") + '>' + esc(c) + '</option>');
		});
		if (state.list && Array.isArray(state.list.summary && state.list.summary.by_channel)) {
			state.list.summary.by_channel.forEach(function (bc) {
				if (!present[bc.channel_id]) {
					present[bc.channel_id] = true;
					channelOpts.push('<option value="' + esc(bc.channel_id) + '"' + (state.filter.channel === bc.channel_id ? " selected" : "") + '>' + esc(bc.channel_id) + '</option>');
				}
			});
		}

		var daysOpts = [
			{ v: "1", l: "Last 24h" },
			{ v: "7", l: "Last 7 days" },
			{ v: "30", l: "Last 30 days" },
			{ v: "90", l: "Last 90 days" },
			{ v: "all", l: "All time" },
		].map(function (o) {
			return '<option value="' + o.v + '"' + (state.filter.days === o.v ? " selected" : "") + '>' + esc(o.l) + '</option>';
		}).join("");

		var statusOpts = [
			{ v: "all", l: "All statuses" },
			{ v: "active", l: "Active" },
			{ v: "expired", l: "Expired" },
		].map(function (o) {
			return '<option value="' + o.v + '"' + (state.filter.status === o.v ? " selected" : "") + '>' + esc(o.l) + '</option>';
		}).join("");

		return (
			'<div class="dash-filter-bar" role="group" aria-label="Session filters">' +
			'<div class="dash-filter-group">' +
			'<label class="dash-filter-label" for="sessions-filter-channel">Channel</label>' +
			'<select class="dash-filter-select" id="sessions-filter-channel">' + channelOpts.join("") + '</select>' +
			'</div>' +
			'<div class="dash-filter-group">' +
			'<label class="dash-filter-label" for="sessions-filter-days">Window</label>' +
			'<select class="dash-filter-select" id="sessions-filter-days">' + daysOpts + '</select>' +
			'</div>' +
			'<div class="dash-filter-group">' +
			'<label class="dash-filter-label" for="sessions-filter-status">Status</label>' +
			'<select class="dash-filter-select" id="sessions-filter-status">' + statusOpts + '</select>' +
			'</div>' +
			'<div class="dash-filter-search">' +
			'<svg fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"/></svg>' +
			'<input type="search" id="sessions-filter-q" placeholder="Search conversation or session key" value="' + esc(state.filter.q) + '" aria-label="Search conversation or session key">' +
			'</div>' +
			'</div>'
		);
	}

	function renderMetricStrip(summary) {
		if (!summary) {
			return (
				'<div class="dash-metric-strip" aria-busy="true">' +
				skeletonMetricCard() + skeletonMetricCard() + skeletonMetricCard() + skeletonMetricCard() +
				'</div>'
			);
		}
		var s = summary;
		return (
			'<div class="dash-metric-strip">' +
			metricCard("Total sessions", formatInt(s.total_sessions)) +
			metricCard("Total cost", formatCost(s.total_cost_usd || 0)) +
			metricCard("Avg turns", (s.avg_turns || 0).toFixed(1)) +
			metricCard("Active", formatInt(s.active_count || 0)) +
			'</div>'
		);
	}

	function metricCard(label, value) {
		return (
			'<div class="dash-metric-card">' +
			'<p class="dash-metric-label">' + esc(label) + '</p>' +
			'<p class="dash-metric-value">' + esc(value) + '</p>' +
			'</div>'
		);
	}

	function skeletonMetricCard() {
		return (
			'<div class="dash-metric-card dash-metric-skeleton" aria-hidden="true">' +
			'<p class="dash-metric-label">.</p>' +
			'<p class="dash-metric-value">.</p>' +
			'</div>'
		);
	}

	function renderChannelBar(summary) {
		if (!summary) return "";
		var by = (summary.by_channel || []).filter(function (b) { return b.count > 0; });
		if (by.length === 0) return "";
		var total = by.reduce(function (acc, b) { return acc + (b.count || 0); }, 0) || 1;
		var segs = by.map(function (b) {
			var pct = ((b.count / total) * 100).toFixed(3);
			var idx = channelColorIdx(b.channel_id);
			return '<div class="dash-channel-bar-segment" data-channel-idx="' + idx + '" style="width:' + pct + '%;" title="' + esc(b.channel_id + ": " + b.count) + '" aria-label="' + esc(b.channel_id + ": " + b.count + " sessions") + '"></div>';
		}).join("");
		var legend = by.map(function (b) {
			var idx = channelColorIdx(b.channel_id);
			return (
				'<span class="dash-channel-bar-label">' +
				'<span class="dash-channel-bar-swatch" data-channel-idx="' + idx + '"></span>' +
				'<span class="dash-channel-bar-label-name">' + esc(b.channel_id) + '</span>' +
				'<span class="dash-channel-bar-label-count">' + formatInt(b.count) + '</span>' +
				'</span>'
			);
		}).join("");
		return (
			'<div class="dash-channel-bar">' +
			'<div class="dash-channel-bar-track" role="img" aria-label="Sessions by channel">' + segs + '</div>' +
			'<div class="dash-channel-bar-legend">' + legend + '</div>' +
			'</div>'
		);
	}

	function sortRows(rows) {
		var copy = rows.slice();
		var col = state.sort.column;
		var dir = state.sort.direction === "asc" ? 1 : -1;
		copy.sort(function (a, b) {
			var av = a[col];
			var bv = b[col];
			if (col === "last_active_at" || col === "created_at") {
				av = parseSqlDate(av);
				bv = parseSqlDate(bv);
				av = av ? av.getTime() : 0;
				bv = bv ? bv.getTime() : 0;
			} else if (typeof av === "string" && typeof bv === "string") {
				av = av.toLowerCase();
				bv = bv.toLowerCase();
			}
			if (av < bv) return -1 * dir;
			if (av > bv) return 1 * dir;
			return 0;
		});
		return copy;
	}

	function sortArrow(column) {
		if (state.sort.column !== column) return "";
		return '<span class="dash-table-sort-arrow">' + (state.sort.direction === "asc" ? "\u25B2" : "\u25BC") + "</span>";
	}

	function headCell(label, column, extraClass) {
		var numericClass = extraClass === "numeric" ? " dash-table-head-cell-numeric" : "";
		var hideSm = extraClass === "hide-sm" ? " dash-table-hide-sm" : "";
		var active = state.sort.column === column ? ' data-sort-active="true"' : "";
		return (
			'<th class="dash-table-head-cell' + numericClass + hideSm + '" data-sortable="true" data-sort-col="' + esc(column) + '"' + active + ' scope="col" aria-sort="' + (state.sort.column === column ? state.sort.direction + "ending" : "none") + '">' +
			esc(label) + sortArrow(column) +
			'</th>'
		);
	}

	function renderTable(list, loading, error) {
		var rowsHtml;
		if (loading && !list) {
			rowsHtml = skeletonRows(6);
		} else if (error) {
			rowsHtml = '<tr><td colspan="6"><div class="dash-table-empty"><p>Could not load sessions.</p><p style="margin-top:var(--space-2);"><button class="dash-btn dash-btn-ghost dash-btn-sm" id="sessions-retry-btn">Retry</button></p></div></td></tr>';
		} else {
			var rows = (list && list.sessions) || [];
			if (rows.length === 0) {
				rowsHtml = '<tr><td colspan="6">' + renderEmptyStateInner() + '</td></tr>';
			} else {
				rows = sortRows(rows);
				rowsHtml = rows.map(renderRow).join("");
			}
		}

		return (
			'<div class="dash-table-wrap">' +
			'<table class="dash-table" aria-label="Sessions" aria-busy="' + (loading ? "true" : "false") + '">' +
			'<thead class="dash-table-head"><tr>' +
			headCell("Channel", "channel_id") +
			headCell("Conversation", "conversation_id") +
			headCell("Turns", "turn_count", "numeric") +
			headCell("Cost", "total_cost_usd", "numeric") +
			headCell("Last active", "last_active_at") +
			headCell("Status", "status", "hide-sm") +
			'</tr></thead>' +
			'<tbody id="sessions-tbody">' + rowsHtml + '</tbody>' +
			'</table>' +
			'</div>'
		);
	}

	function renderRow(row) {
		var idx = channelColorIdx(row.channel_id);
		var statusClass = row.status === "active" ? "dash-status-chip-active" : row.status === "expired" ? "dash-status-chip-expired" : "";
		var keyAttr = encodeURIComponent(row.session_key);
		return (
			'<tr class="dash-table-row" data-clickable="true" data-session-key="' + esc(row.session_key) + '" data-session-key-encoded="' + esc(keyAttr) + '" tabindex="0" role="button" aria-label="Open session ' + esc(row.session_key) + '">' +
			'<td class="dash-table-cell">' +
			'<span class="dash-channel-glyph"><span class="dash-channel-glyph-dot" data-channel-idx="' + idx + '"></span>' + esc(row.channel_id) + '</span>' +
			'</td>' +
			'<td class="dash-table-cell dash-table-cell-mono">' + conversationCell(row) + '</td>' +
			'<td class="dash-table-cell dash-table-cell-numeric">' + formatInt(row.turn_count) + '</td>' +
			'<td class="dash-table-cell dash-table-cell-numeric">' + esc(formatCost(row.total_cost_usd)) + '</td>' +
			'<td class="dash-table-cell dash-table-cell-muted" title="' + esc(absoluteTime(row.last_active_at)) + '">' + esc(relativeTime(row.last_active_at)) + '</td>' +
			'<td class="dash-table-cell dash-table-hide-sm">' + (statusClass ? '<span class="dash-status-chip ' + statusClass + '">' + esc(row.status) + '</span>' : esc(row.status)) + '</td>' +
			'</tr>'
		);
	}

	function skeletonRows(n) {
		var out = [];
		for (var i = 0; i < n; i++) {
			out.push(
				'<tr class="dash-table-skeleton-row" aria-hidden="true">' +
				'<td><div class="dash-table-skeleton-pill" style="width:50%;"></div></td>' +
				'<td><div class="dash-table-skeleton-pill" style="width:80%;"></div></td>' +
				'<td><div class="dash-table-skeleton-pill" style="width:30%; margin-left:auto;"></div></td>' +
				'<td><div class="dash-table-skeleton-pill" style="width:40%; margin-left:auto;"></div></td>' +
				'<td><div class="dash-table-skeleton-pill" style="width:45%;"></div></td>' +
				'<td class="dash-table-hide-sm"><div class="dash-table-skeleton-pill" style="width:55%;"></div></td>' +
				'</tr>',
			);
		}
		return out.join("");
	}

	function renderEmptyStateInner() {
		return (
			'<div class="dash-empty" style="border:none; padding:var(--space-10) var(--space-5);">' +
			'<svg class="dash-empty-icon" fill="none" viewBox="0 0 24 24" stroke-width="1.2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 14.15v4.098a2.25 2.25 0 0 1-2.25 2.25h-12a2.25 2.25 0 0 1-2.25-2.25V5.625a2.25 2.25 0 0 1 2.25-2.25h8.25M15.75 9l3.75-3.75m0 0L23.25 9m-3.75-3.75v9"/></svg>' +
			'<h3 class="dash-empty-title">No sessions yet</h3>' +
			'<p class="dash-empty-body">When someone messages your agent on Slack, chat, or via the CLI, each conversation shows up here with its cost, turn count, and outcome. Try clearing filters if you expected to see rows.</p>' +
			'</div>'
		);
	}

	function render() {
		if (!root) return;
		var header = renderHeader();
		var filterBar = renderFilterBar();
		var summary = state.list && state.list.summary ? state.list.summary : null;
		var metricStrip = renderMetricStrip(summary);
		var channelBar = renderChannelBar(summary);
		var table = renderTable(state.list, state.loading, state.listError);
		root.innerHTML = header + filterBar + metricStrip + channelBar + table;

		wireFilterBar();
		wireExport();
		wireTableInteractions();
	}


	function wireFilterBar() {
		var channelEl = document.getElementById("sessions-filter-channel");
		var daysEl = document.getElementById("sessions-filter-days");
		var statusEl = document.getElementById("sessions-filter-status");
		var qEl = document.getElementById("sessions-filter-q");
		if (channelEl) {
			channelEl.addEventListener("change", function () {
				state.filter.channel = channelEl.value;
				loadList();
			});
		}
		if (daysEl) {
			daysEl.addEventListener("change", function () {
				state.filter.days = daysEl.value;
				loadList();
			});
		}
		if (statusEl) {
			statusEl.addEventListener("change", function () {
				state.filter.status = statusEl.value;
				loadList();
			});
		}
		if (qEl) {
			qEl.addEventListener("input", function () {
				if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
				var val = qEl.value;
				searchDebounceTimer = setTimeout(function () {
					state.filter.q = val;
					loadList();
				}, SEARCH_DEBOUNCE_MS);
			});
		}
	}

	function wireExport() {
		var btn = document.getElementById("sessions-export-btn");
		if (!btn) return;
		btn.addEventListener("click", exportCsv);
	}

	function wireTableInteractions() {
		var tbody = document.getElementById("sessions-tbody");
		if (tbody) {
			var rows = tbody.querySelectorAll(".dash-table-row[data-clickable]");
			for (var i = 0; i < rows.length; i++) {
				var row = rows[i];
				row.addEventListener("click", onRowActivate);
				row.addEventListener("keydown", onRowKeyDown);
			}
		}
		var retry = document.getElementById("sessions-retry-btn");
		if (retry) retry.addEventListener("click", function () { loadList(); });

		var heads = root.querySelectorAll(".dash-table-head-cell[data-sortable='true']");
		for (var j = 0; j < heads.length; j++) {
			var head = heads[j];
			head.addEventListener("click", onHeadClick);
		}
	}

	function onRowActivate(e) {
		var row = e.currentTarget;
		var key = row.getAttribute("data-session-key");
		if (!key) return;
		var encoded = row.getAttribute("data-session-key-encoded");
		ctx.navigate("#/sessions/" + encoded);
	}

	function onRowKeyDown(e) {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			onRowActivate(e);
		}
	}

	function onHeadClick(e) {
		var col = e.currentTarget.getAttribute("data-sort-col");
		if (!col) return;
		if (state.sort.column === col) {
			state.sort.direction = state.sort.direction === "asc" ? "desc" : "asc";
		} else {
			state.sort.column = col;
			state.sort.direction = col === "last_active_at" || col === "created_at" || col === "turn_count" || col === "total_cost_usd" ? "desc" : "asc";
		}
		renderTableOnly();
	}

	function renderTableOnly() {
		var wrap = root.querySelector(".dash-table-wrap");
		if (!wrap) { render(); return; }
		var temp = document.createElement("div");
		temp.innerHTML = renderTable(state.list, state.loading, state.listError);
		if (temp.firstChild) wrap.parentNode.replaceChild(temp.firstChild, wrap);
		wireTableInteractions();
	}

	// ---- List loading ----

	function buildListQuery() {
		var params = new URLSearchParams();
		if (state.filter.channel && state.filter.channel !== "all") {
			params.set("channel", state.filter.channel);
		}
		if (state.filter.days) params.set("days", state.filter.days);
		if (state.filter.status) params.set("status", state.filter.status);
		var q = (state.filter.q || "").trim();
		if (q) params.set("q", q);
		var s = params.toString();
		return s ? "?" + s : "";
	}

	function loadList() {
		state.loading = true;
		state.listError = null;
		// Re-render table to show loading state.
		renderTableOnly();
		return ctx.api("GET", "/ui/api/sessions" + buildListQuery()).then(function (res) {
			state.list = res;
			state.loading = false;
			render();
			// Refresh the drawer if open.
			if (state.openKey && drawerRoot) {
				// Drawer has its own data; no re-fetch on list refresh.
			}
		}).catch(function (err) {
			state.loading = false;
			state.listError = err;
			state.list = null;
			render();
			ctx.toast("error", "Failed to load sessions", err.message || String(err));
		});
	}

	// ---- Drawer ----

	function openDrawer(sessionKey) {
		state.openKey = sessionKey;
		state.detailLoading = true;
		state.detailError = null;
		state.detail = null;
		renderDrawer();
		return ctx.api("GET", "/ui/api/sessions/" + encodeURIComponent(sessionKey))
			.then(function (res) {
				state.detailLoading = false;
				state.detail = res;
				if (state.openKey === sessionKey) renderDrawer();
			})
			.catch(function (err) {
				state.detailLoading = false;
				state.detailError = err;
				state.detail = null;
				if (state.openKey === sessionKey) renderDrawer();
				if (err.status === 404) {
					ctx.toast("error", "Session not found", sessionKey);
				} else {
					ctx.toast("error", "Failed to load session", err.message || String(err));
				}
			});
	}

	function closeDrawer(skipHashUpdate) {
		state.openKey = null;
		state.detail = null;
		state.detailError = null;
		removeDrawerDom();
		if (!skipHashUpdate && window.location.hash.indexOf("#/sessions/") === 0) {
			ctx.navigate("#/sessions");
		}
	}

	function removeDrawerDom() {
		if (!drawerRoot) return;
		if (drawerRoot.parentNode) drawerRoot.parentNode.removeChild(drawerRoot);
		drawerRoot = null;
		if (drawerKeyHandler) document.removeEventListener("keydown", drawerKeyHandler, true);
		drawerKeyHandler = null;
		document.body.style.overflow = prevBodyOverflow || "";
		prevBodyOverflow = null;
		if (drawerFocusRestore && typeof drawerFocusRestore.focus === "function") {
			try { drawerFocusRestore.focus(); } catch (_) { /* ignore */ }
		}
		drawerFocusRestore = null;
	}

	function renderDrawer() {
		if (!state.openKey) { removeDrawerDom(); return; }

		var firstOpen = !drawerRoot;
		if (firstOpen) {
			drawerFocusRestore = document.activeElement;
			drawerRoot = document.createElement("div");
			drawerRoot.setAttribute("data-sessions-drawer", "true");
			document.body.appendChild(drawerRoot);
			prevBodyOverflow = document.body.style.overflow;
			document.body.style.overflow = "hidden";
		}

		var contentBody;
		if (state.detailError) {
			contentBody = (
				'<div class="dash-drawer-body">' +
				'<div class="dash-drawer-error">' +
				'<p style="margin:0 0 var(--space-2); font-weight:600;">Could not load session.</p>' +
				'<p style="margin:0 0 var(--space-3);">' + esc(state.detailError.message || String(state.detailError)) + '</p>' +
				'<button class="dash-btn dash-btn-ghost dash-btn-sm" id="sessions-drawer-retry">Retry</button>' +
				'</div>' +
				'</div>'
			);
		} else if (!state.detail || state.detailLoading) {
			contentBody = renderDrawerSkeleton();
		} else {
			contentBody = renderDrawerContent(state.detail);
		}

		var session = state.detail && state.detail.session;
		var chip = "";
		if (session) {
			var cls = session.status === "active" ? "dash-status-chip-active" : session.status === "expired" ? "dash-status-chip-expired" : "";
			chip = '<span class="dash-status-chip ' + cls + '">' + esc(session.status) + '</span>';
		}

		var channel = session ? session.channel_id : state.openKey.split(":")[0] || "";

		drawerRoot.innerHTML = (
			'<div class="dash-drawer-backdrop" data-drawer-backdrop="true" aria-hidden="true"></div>' +
			'<aside class="dash-drawer" role="dialog" aria-modal="true" aria-labelledby="sessions-drawer-title" tabindex="-1">' +
			'<header class="dash-drawer-header">' +
			'<div class="dash-drawer-title-wrap">' +
			'<p class="dash-drawer-eyebrow">Session</p>' +
			'<h2 class="dash-drawer-title" id="sessions-drawer-title">' + esc(state.openKey) + '</h2>' +
			'<div class="dash-drawer-subtitle">' +
			'<span class="phantom-muted">' + esc(channel) + '</span>' +
			(chip ? chip : "") +
			'</div>' +
			'</div>' +
			'<button class="dash-drawer-close" type="button" aria-label="Close" id="sessions-drawer-close">' +
			'<svg fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg>' +
			'</button>' +
			'</header>' +
			contentBody +
			'</aside>'
		);

		wireDrawerInteractions();
		if (firstOpen) trapFocus();
	}

	function renderDrawerSkeleton() {
		var pill = '<div class="dash-table-skeleton-pill"></div>';
		return (
			'<div class="dash-drawer-body" aria-busy="true">' +
			'<section class="dash-drawer-section">' +
			'<p class="dash-drawer-section-label">Overview</p>' +
			'<div class="dash-drawer-kv">' +
			'<span class="dash-drawer-kv-key">Created</span><span class="dash-drawer-kv-value" style="min-width:120px; height:14px;">' + pill + '</span>' +
			'<span class="dash-drawer-kv-key">Last active</span><span class="dash-drawer-kv-value" style="min-width:120px; height:14px;">' + pill + '</span>' +
			'<span class="dash-drawer-kv-key">SDK session</span><span class="dash-drawer-kv-value" style="min-width:160px; height:14px;">' + pill + '</span>' +
			'<span class="dash-drawer-kv-key">Turns</span><span class="dash-drawer-kv-value" style="min-width:60px; height:14px;">' + pill + '</span>' +
			'<span class="dash-drawer-kv-key">Input tokens</span><span class="dash-drawer-kv-value" style="min-width:80px; height:14px;">' + pill + '</span>' +
			'<span class="dash-drawer-kv-key">Output tokens</span><span class="dash-drawer-kv-value" style="min-width:80px; height:14px;">' + pill + '</span>' +
			'<span class="dash-drawer-kv-key">Total cost</span><span class="dash-drawer-kv-value" style="min-width:80px; height:14px;">' + pill + '</span>' +
			'</div>' +
			'</section>' +
			'<section class="dash-drawer-section">' +
			'<p class="dash-drawer-section-label">Cost events</p>' +
			'<div style="display:flex; flex-direction:column; gap:8px;">' +
			pill + pill + pill +
			'</div>' +
			'</section>' +
			'</div>'
		);
	}

	function renderDrawerContent(detail) {
		var s = detail.session;
		var events = detail.cost_events || [];

		var kv = [];
		kv.push(kvRow("Created", absoluteTime(s.created_at), "plain"));
		kv.push(kvRow("Last active", absoluteTime(s.last_active_at) + " (" + relativeTime(s.last_active_at) + ")", "plain"));
		kv.push(kvRow("SDK session", s.sdk_session_id || "none"));
		kv.push(kvRow("Turns", formatInt(s.turn_count), "plain"));
		kv.push(kvRow("Input tokens", formatInt(s.input_tokens), "plain"));
		kv.push(kvRow("Output tokens", formatInt(s.output_tokens), "plain"));
		kv.push(kvRow("Total cost", formatCost(s.total_cost_usd), "plain"));

		var chatSection = "";
		if (s.chat) {
			var c = s.chat;
			var chatKv = [];
			chatKv.push(kvRow("Title", c.title || "(untitled)", "plain"));
			chatKv.push(kvRow("Messages", formatInt(c.message_count), "plain"));
			chatKv.push(kvRow("Pinned", c.pinned ? "yes" : "no", "plain"));
			if (c.deleted_at) chatKv.push(kvRow("Deleted", absoluteTime(c.deleted_at), "plain"));
			if (c.forked_from_session_id) {
				chatKv.push(kvRow("Forked from", c.forked_from_session_id + (c.forked_from_message_seq ? " #" + c.forked_from_message_seq : "")));
			}
			chatSection = (
				'<section class="dash-drawer-section">' +
				'<p class="dash-drawer-section-label">Chat</p>' +
				'<div class="dash-drawer-kv">' + chatKv.join("") + '</div>' +
				'</section>'
			);
		}

		var eventsSection;
		if (events.length === 0) {
			eventsSection = (
				'<section class="dash-drawer-section">' +
				'<p class="dash-drawer-section-label">Cost events</p>' +
				'<p style="font-size:12px; color:color-mix(in oklab, var(--color-base-content) 55%, transparent); margin:0;">No cost events recorded for this session.</p>' +
				'</section>'
			);
		} else {
			var rows = events.map(function (ev) {
				return (
					'<tr class="dash-table-row">' +
					'<td class="dash-table-cell dash-table-cell-muted" title="' + esc(absoluteTime(ev.created_at)) + '">' + esc(absoluteTime(ev.created_at).slice(11, 19)) + '</td>' +
					'<td class="dash-table-cell dash-table-cell-mono">' + esc(ev.model) + '</td>' +
					'<td class="dash-table-cell dash-table-cell-numeric">' + formatInt(ev.input_tokens) + '</td>' +
					'<td class="dash-table-cell dash-table-cell-numeric">' + formatInt(ev.output_tokens) + '</td>' +
					'<td class="dash-table-cell dash-table-cell-numeric">' + esc(formatCost(ev.cost_usd)) + '</td>' +
					'</tr>'
				);
			}).join("");
			eventsSection = (
				'<section class="dash-drawer-section">' +
				'<p class="dash-drawer-section-label">Cost events (' + events.length + ')</p>' +
				'<div class="dash-table-wrap">' +
				'<table class="dash-table" aria-label="Cost events">' +
				'<thead class="dash-table-head"><tr>' +
				'<th class="dash-table-head-cell" scope="col">Time</th>' +
				'<th class="dash-table-head-cell" scope="col">Model</th>' +
				'<th class="dash-table-head-cell dash-table-head-cell-numeric" scope="col">In</th>' +
				'<th class="dash-table-head-cell dash-table-head-cell-numeric" scope="col">Out</th>' +
				'<th class="dash-table-head-cell dash-table-head-cell-numeric" scope="col">Cost</th>' +
				'</tr></thead>' +
				'<tbody>' + rows + '</tbody>' +
				'</table>' +
				'</div>' +
				'</section>'
			);
		}

		var footer = "";
		if (s.channel_id === "slack") {
			var parts = String(s.conversation_id || "").split("/");
			var channelId = parts[0];
			var ts = parts.slice(1).join("/");
			if (channelId && ts) {
				footer = '<a class="dash-btn dash-btn-ghost dash-btn-sm" href="slack://channel?id=' + encodeURIComponent(channelId) + '&message=' + encodeURIComponent(ts) + '">Open in Slack</a>';
			}
		} else if (s.channel_id === "chat") {
			footer = '<a class="dash-btn dash-btn-ghost dash-btn-sm" href="/chat/?session=' + encodeURIComponent(s.conversation_id) + '">Open chat session</a>';
		}

		return (
			'<div class="dash-drawer-body">' +
			'<section class="dash-drawer-section">' +
			'<p class="dash-drawer-section-label">Overview</p>' +
			'<div class="dash-drawer-kv">' + kv.join("") + '</div>' +
			'</section>' +
			chatSection +
			eventsSection +
			'</div>' +
			(footer ? '<footer class="dash-drawer-footer">' + footer + '</footer>' : "")
		);
	}

	function kvRow(key, value, variant) {
		var valueClass = variant === "plain" ? " dash-drawer-kv-value-plain" : "";
		return (
			'<span class="dash-drawer-kv-key">' + esc(key) + '</span>' +
			'<span class="dash-drawer-kv-value' + valueClass + '">' + esc(value) + '</span>'
		);
	}

	function wireDrawerInteractions() {
		if (!drawerRoot) return;
		var closeBtn = drawerRoot.querySelector("#sessions-drawer-close");
		var backdrop = drawerRoot.querySelector("[data-drawer-backdrop]");
		var retry = drawerRoot.querySelector("#sessions-drawer-retry");
		if (closeBtn) closeBtn.addEventListener("click", function () { closeDrawer(false); });
		if (backdrop) backdrop.addEventListener("click", function () { closeDrawer(false); });
		if (retry) retry.addEventListener("click", function () {
			if (state.openKey) openDrawer(state.openKey);
		});

		// renderDrawer fires twice per open (skeleton then content), so detach
		// the previous keydown handler before installing a new one to prevent
		// document-level listener accumulation across the page lifetime.
		if (drawerKeyHandler) document.removeEventListener("keydown", drawerKeyHandler, true);
		drawerKeyHandler = function (e) {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				closeDrawer(false);
				return;
			}
			if (e.key === "Tab") {
				handleTab(e);
			}
		};
		document.addEventListener("keydown", drawerKeyHandler, true);
	}

	function getFocusable() {
		if (!drawerRoot) return [];
		var panel = drawerRoot.querySelector(".dash-drawer");
		if (!panel) return [];
		var selector = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
		var nodes = panel.querySelectorAll(selector);
		var visible = [];
		for (var i = 0; i < nodes.length; i++) {
			var n = nodes[i];
			if (n.offsetParent !== null || n === document.activeElement) visible.push(n);
		}
		return visible;
	}

	function handleTab(e) {
		var focusable = getFocusable();
		if (focusable.length === 0) {
			e.preventDefault();
			var panel = drawerRoot && drawerRoot.querySelector(".dash-drawer");
			if (panel) panel.focus();
			return;
		}
		var first = focusable[0];
		var last = focusable[focusable.length - 1];
		if (e.shiftKey && document.activeElement === first) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && document.activeElement === last) {
			e.preventDefault();
			first.focus();
		}
	}

	function trapFocus() {
		if (!drawerRoot) return;
		var panel = drawerRoot.querySelector(".dash-drawer");
		if (!panel) return;
		// Move focus to the close button (first interactive element) after paint.
		setTimeout(function () {
			var close = drawerRoot && drawerRoot.querySelector("#sessions-drawer-close");
			if (close) close.focus();
			else panel.focus();
		}, 40);
	}

	// ---- CSV export ----

	function exportCsv() {
		if (!state.list || !state.list.sessions || state.list.sessions.length === 0) {
			ctx.toast("error", "Nothing to export", "No sessions in the current view.");
			return;
		}
		var headers = ["session_key", "channel_id", "conversation_id", "status", "turn_count", "total_cost_usd", "input_tokens", "output_tokens", "created_at", "last_active_at"];
		var rows = [headers.join(",")];
		state.list.sessions.forEach(function (s) {
			var fields = headers.map(function (h) {
				var v = s[h];
				if (v == null) return "";
				return csvEscape(String(v));
			});
			rows.push(fields.join(","));
		});
		var csv = rows.join("\n");
		var blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
		var url = URL.createObjectURL(blob);
		var a = document.createElement("a");
		a.href = url;
		a.download = "sessions-" + new Date().toISOString().slice(0, 10) + ".csv";
		document.body.appendChild(a);
		a.click();
		setTimeout(function () {
			URL.revokeObjectURL(url);
			if (a.parentNode) a.parentNode.removeChild(a);
		}, 100);
	}

	function csvEscape(s) {
		if (/[",\n\r]/.test(s)) {
			return '"' + s.replace(/"/g, '""') + '"';
		}
		return s;
	}

	// ---- Global key handler ----

	function installGlobalKeys() {
		if (documentKeyHandler) return;
		documentKeyHandler = function (e) {
			if (e.key !== "/") return;
			var tag = (document.activeElement && document.activeElement.tagName) || "";
			var isTypingIn = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
			if (isTypingIn) return;
			if (e.metaKey || e.ctrlKey || e.altKey) return;
			var hash = window.location.hash || "";
			if (hash.indexOf("#/sessions") !== 0) return;
			var search = document.getElementById("sessions-filter-q");
			if (search) {
				e.preventDefault();
				search.focus();
				search.select();
			}
		};
		document.addEventListener("keydown", documentKeyHandler);
	}

	// ---- Mount ----

	function mount(container, arg, dashCtx) {
		ctx = dashCtx;
		root = container;
		ctx.setBreadcrumb("Sessions");
		installGlobalKeys();

		// Synchronous render: chrome + skeleton for list and (if arg) drawer.
		render();
		if (arg) {
			// Skeleton drawer first, then fill.
			openDrawer(arg);
		} else if (drawerRoot) {
			// Arg cleared by back-nav: close any existing drawer.
			closeDrawer(true);
		}

		// Fire list fetch.
		return loadList().then(function () {
			// If the deep-link requested a key that's not in the loaded list, the
			// drawer still opens because detail has its own endpoint. That's the
			// point of a separate detail endpoint: deep-links work even when the
			// filter excludes the row.
		});
	}

	if (window.PhantomDashboard && window.PhantomDashboard.registerRoute) {
		window.PhantomDashboard.registerRoute("sessions", { mount: mount });
	}
})();
