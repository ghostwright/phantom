// Evolution tab (Phase A, read-only): self-improvement timeline over
// phantom-config/meta/version.json + evolution-log.jsonl + metrics.json.
//
// Module contract: registers with PhantomDashboard via
// registerRoute("evolution", { mount }). mount(container, arg, ctx) is called
// on hash change. When arg looks like "v<n>" or "<n>" the card for that
// version auto-expands if it's in the current timeline page. Snapshot
// storage and rollback ship in Phase B; this module is pure read.
//
// All values from the API flow through ctx.esc() or textContent. Diff content
// previews render as textContent inside <pre> nodes because the payload is
// the actual file body from phantom-config/ and may contain any characters.

(function () {
	var DEFAULT_LIMIT = 20;
	var FILE_PREVIEW_MAX_CHARS = 8000;

	var state = {
		overview: null,
		overviewLoading: false,
		overviewError: null,
		entries: [],
		timelineLoading: false,
		timelineError: null,
		hasMore: false,
		expanded: {},
		versionCache: {},
		versionLoading: {},
		versionErrors: {},
		deepLink: null,
	};
	var ctx = null;
	var root = null;

	function esc(s) { return ctx ? ctx.esc(s) : ""; }

	function formatCost(n) {
		if (typeof n !== "number" || !isFinite(n)) return "$0.00";
		if (n > 0 && n < 0.01) return "<$0.01";
		return "$" + n.toFixed(2);
	}

	function formatInt(n) {
		if (typeof n !== "number" || !isFinite(n)) return "0";
		return Math.round(n).toLocaleString();
	}

	function formatRate(n) {
		if (typeof n !== "number" || !isFinite(n)) return "0%";
		return Math.round(n * 100) + "%";
	}

	function formatBytes(n) {
		if (typeof n !== "number" || !isFinite(n) || n < 0) return "0 B";
		if (n < 1024) return n + " B";
		if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
		return (n / (1024 * 1024)).toFixed(2) + " MB";
	}

	function parseIsoDate(s) {
		if (!s) return null;
		var d = new Date(s);
		if (isNaN(d.getTime())) return null;
		return d;
	}

	function relativeTime(s) {
		var d = parseIsoDate(s);
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
		return Math.floor(day / 365) + "y ago";
	}

	function absoluteTime(s) {
		var d = parseIsoDate(s);
		if (!d) return "";
		return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
	}

	function statusChipClass(status) {
		if (status === "ok") return "dash-status-chip-active";
		if (status === "skip") return "dash-status-chip-paused";
		if (status === "escalate") return "dash-status-chip-error";
		return "";
	}

	function tierLabel(tier) {
		return tier || "skip";
	}

	function typeChipClass(type) {
		if (type === "new") return "dash-status-chip-active";
		if (type === "delete") return "dash-status-chip-error";
		if (type === "compact") return "dash-status-chip-info";
		return "dash-status-chip-paused";
	}

	function parseDeepLink(arg) {
		if (!arg) return null;
		var raw = String(arg).replace(/^v/i, "");
		var n = Number.parseInt(raw, 10);
		if (!Number.isInteger(n) || n < 0) return null;
		return n;
	}

	function render() {
		if (!root) return;
		var out = [];
		out.push(renderHeader());
		out.push(renderMetricStrip());
		out.push(renderPoisonBanner());
		out.push(renderSparklineSection());
		out.push(renderTimelineSection());
		root.innerHTML = out.join("");
		wireHeader();
		wireTimeline();
		paintDiffContent();
	}

	function renderHeader() {
		return (
			'<div class="dash-header">' +
			'<p class="dash-header-eyebrow">Evolution</p>' +
			'<h1 class="dash-header-title">Evolution</h1>' +
			'<p class="dash-header-lead">The agent\u0027s self-improvement history. Every generation, every file change, every judge decision. Click a card to see the diff and the sessions that triggered it.</p>' +
			'<div class="dash-header-actions"><span class="dash-chip">Phase A \u00B7 read-only</span></div>' +
			'</div>'
		);
	}

	function metricCard(label, value, delta) {
		var deltaHtml = delta ? '<p class="dash-metric-delta">' + esc(delta) + '</p>' : "";
		return (
			'<div class="dash-metric-card">' +
			'<p class="dash-metric-label">' + esc(label) + '</p>' +
			'<p class="dash-metric-value">' + esc(value) + '</p>' +
			deltaHtml +
			'</div>'
		);
	}

	function skeletonMetric() {
		return (
			'<div class="dash-metric-card dash-metric-skeleton" aria-hidden="true">' +
			'<p class="dash-metric-label">.</p><p class="dash-metric-value">.</p></div>'
		);
	}

	function renderMetricStrip() {
		if (state.overviewLoading && !state.overview) {
			return '<div class="dash-metric-strip" aria-busy="true">' +
				skeletonMetric() + skeletonMetric() + skeletonMetric() + skeletonMetric() + skeletonMetric() + skeletonMetric() + '</div>';
		}
		if (state.overviewError) {
			return (
				'<div class="dash-empty" style="margin-top: var(--space-4);">' +
				'<h3 class="dash-empty-title">Could not load evolution state</h3>' +
				'<p class="dash-empty-body">' + esc(state.overviewError) + '</p>' +
				'<button class="dash-btn dash-btn-ghost" id="evolution-retry-overview">Retry</button>' +
				'</div>'
			);
		}
		if (!state.overview) return "";
		var o = state.overview;
		var m = o.metrics;
		var rs = m.reflection_stats;
		var sinceLabel = o.current.timestamp ? relativeTime(o.current.timestamp) : "never";
		var tiersLabel = rs.tiers.haiku + " haiku / " + rs.tiers.sonnet + " sonnet / " + rs.tiers.opus + " opus";
		return (
			'<div class="dash-metric-strip">' +
			metricCard("Current version", "v" + o.current.version, "since " + sinceLabel) +
			metricCard("Total sessions", formatInt(m.session_count)) +
			metricCard("Success 7d", formatRate(m.success_rate_7d)) +
			metricCard("Drains", formatInt(rs.drains), tiersLabel) +
			metricCard("Reflection cost", formatCost(rs.cost_usd)) +
			metricCard("Invariant fails", formatInt(rs.invariant_fails)) +
			'</div>'
		);
	}

	function renderPoisonBanner() {
		if (!state.overview || !state.overview.poison_count) return "";
		var n = state.overview.poison_count;
		var word = n === 1 ? "drain" : "drains";
		return (
			'<div class="dash-poison-banner" role="status">' +
			'<span class="dash-poison-banner-glyph" aria-hidden="true">!</span>' +
			'<div>' +
			'<p class="dash-poison-banner-title">' + esc(n + " poisoned " + word) + '</p>' +
			'<p class="dash-poison-banner-body">Reflections that exceeded the retry ceiling. Inspect them directly on the VM via the evolution-queue-poison table.</p>' +
			'</div>' +
			'</div>'
		);
	}

	function buildSparklineData() {
		if (!state.entries || state.entries.length === 0) return [];
		var counts = {};
		state.entries.forEach(function (e) {
			if (!e.timestamp) return;
			var day = e.timestamp.slice(0, 10);
			counts[day] = (counts[day] || 0) + 1;
		});
		var days = Object.keys(counts).sort();
		return days.map(function (d) { return { day: d, count: counts[d] }; });
	}

	function renderSparklineSvg(points, width, height) {
		if (points.length === 0) {
			return '<svg class="dash-chart-svg" viewBox="0 0 ' + width + ' ' + height + '"></svg>';
		}
		var padL = 36, padR = 10, padT = 8, padB = 20;
		var innerW = Math.max(1, width - padL - padR);
		var innerH = Math.max(1, height - padT - padB);
		var max = 0;
		for (var i = 0; i < points.length; i++) if (points[i].count > max) max = points[i].count;
		if (max === 0) max = 1;
		var gap = points.length > 30 ? 1 : 2;
		var barW = Math.max(2, (innerW - gap * (points.length - 1)) / points.length);
		var out = ['<svg class="dash-chart-svg" viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none" role="img" aria-label="Drains per day">'];
		var ticks = 3;
		for (var t = 0; t <= ticks; t++) {
			var yv = (max * t) / ticks;
			var yP = padT + innerH - (yv / max) * innerH;
			out.push('<line class="dash-chart-gridline" x1="' + padL + '" y1="' + yP + '" x2="' + (padL + innerW) + '" y2="' + yP + '"/>');
			out.push('<text class="dash-chart-tick-label" x="' + (padL - 6) + '" y="' + (yP + 3) + '" text-anchor="end">' + esc(String(Math.round(yv))) + '</text>');
		}
		out.push('<line class="dash-chart-axis" x1="' + padL + '" y1="' + (padT + innerH) + '" x2="' + (padL + innerW) + '" y2="' + (padT + innerH) + '"/>');
		var labelEvery = Math.max(1, Math.ceil(points.length / 6));
		for (var j = 0; j < points.length; j++) {
			var p = points[j];
			var h = (p.count / max) * innerH;
			var x = padL + j * (barW + gap);
			var y = padT + innerH - h;
			out.push('<rect class="dash-chart-bar" data-series-idx="0" x="' + x + '" y="' + y + '" width="' + barW + '" height="' + h + '"><title>' + esc(p.day + ": " + p.count) + '</title></rect>');
			if (j % labelEvery === 0 || j === points.length - 1) {
				out.push('<text class="dash-chart-tick-label" x="' + (x + barW / 2) + '" y="' + (padT + innerH + 12) + '" text-anchor="middle">' + esc(p.day.slice(5)) + '</text>');
			}
		}
		out.push('</svg>');
		return out.join("");
	}

	function renderSparklineSection() {
		var points = buildSparklineData();
		if (state.timelineLoading && state.entries.length === 0) {
			return (
				'<div class="dash-chart" style="margin-top: var(--space-4);">' +
				'<div class="dash-chart-header"><p class="dash-chart-title">Drains per day (from timeline)</p></div>' +
				'<div class="dash-chart-skeleton" aria-hidden="true"></div>' +
				'</div>'
			);
		}
		if (points.length === 0) return "";
		var width = Math.max(480, points.length * 26);
		var svg = renderSparklineSvg(points, width, 120);
		return (
			'<div class="dash-chart" style="margin-top: var(--space-4);">' +
			'<div class="dash-chart-header"><p class="dash-chart-title">Drains per day (from timeline)</p></div>' +
			'<div class="dash-chart-scroll">' + svg + '</div>' +
			'</div>'
		);
	}

	function renderTimelineSection() {
		if (state.timelineLoading && state.entries.length === 0) {
			return renderTimelineSkeleton();
		}
		if (state.timelineError) {
			return (
				'<div class="dash-empty" style="margin-top: var(--space-4);">' +
				'<h3 class="dash-empty-title">Could not load timeline</h3>' +
				'<p class="dash-empty-body">' + esc(state.timelineError) + '</p>' +
				'<button class="dash-btn dash-btn-ghost" id="evolution-retry-timeline">Retry</button>' +
				'</div>'
			);
		}
		if (state.entries.length === 0) {
			return renderEmpty();
		}
		var cards = state.entries.map(renderCard).join("");
		var loadMore = state.hasMore
			? '<div class="dash-timeline-footer"><button class="dash-btn dash-btn-ghost" id="evolution-load-more">Load more</button></div>'
			: "";
		return '<div class="dash-timeline" role="list">' + cards + '</div>' + loadMore;
	}

	function renderTimelineSkeleton() {
		var pill = '<div class="dash-table-skeleton-pill"></div>';
		var out = [];
		for (var i = 0; i < 4; i++) {
			out.push(
				'<div class="dash-timeline-card" aria-hidden="true">' +
				'<div class="dash-timeline-card-header"><div style="display:flex; gap:10px; width: 80%;">' + pill + pill + pill + '</div></div>' +
				'</div>'
			);
		}
		return '<div class="dash-timeline" aria-busy="true">' + out.join("") + '</div>';
	}

	function renderEmpty() {
		return (
			'<div class="dash-empty" style="margin-top: var(--space-4);">' +
			'<svg class="dash-empty-icon" fill="none" viewBox="0 0 24 24" stroke-width="1.2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99"/></svg>' +
			'<h3 class="dash-empty-title">Your agent hasn\u0027t evolved yet</h3>' +
			'<p class="dash-empty-body">After a few sessions and a drain, the first generation lands here. Each card will show the file changes and the sessions that motivated them.</p>' +
			'</div>'
		);
	}

	function renderCard(entry) {
		var isOpen = !!state.expanded[entry.version];
		var openClass = isOpen ? ' dash-timeline-card-open' : '';
		var statusCls = statusChipClass(entry.status);
		var tierLbl = tierLabel(entry.tier);
		var timeLabel = entry.timestamp ? absoluteTime(entry.timestamp) : "";
		var relLabel = entry.timestamp ? relativeTime(entry.timestamp) : "";
		var summary = deriveSummary(entry);
		var headerAria = 'aria-expanded="' + (isOpen ? 'true' : 'false') + '" aria-controls="evolution-card-body-' + entry.version + '"';
		var bodyHtml = isOpen ? renderCardBody(entry) : "";
		return (
			'<article class="dash-timeline-card' + openClass + '" role="listitem" data-version="' + entry.version + '">' +
			'<div class="dash-timeline-card-header" tabindex="0" role="button" ' + headerAria + ' data-expand="' + entry.version + '">' +
			'<div class="dash-timeline-card-head-row">' +
			'<span class="dash-timeline-card-version">v' + esc(String(entry.version)) + '</span>' +
			'<span class="dash-timeline-card-time" title="' + esc(timeLabel) + '">' + esc(relLabel) + '</span>' +
			'<span class="dash-timeline-tier">' + esc(tierLbl) + '</span>' +
			(statusCls ? '<span class="dash-status-chip ' + statusCls + '">' + esc(entry.status) + '</span>' : '<span class="dash-status-chip">' + esc(entry.status) + '</span>') +
			'<span class="dash-timeline-card-count">' + esc(entry.changes_applied + " change" + (entry.changes_applied === 1 ? "" : "s")) + '</span>' +
			'<span class="dash-timeline-chevron" aria-hidden="true">\u203A</span>' +
			'</div>' +
			'<p class="dash-timeline-card-summary">' + esc(summary) + '</p>' +
			'</div>' +
			'<div class="dash-timeline-card-body" id="evolution-card-body-' + entry.version + '">' + bodyHtml + '</div>' +
			'</article>'
		);
	}

	function deriveSummary(entry) {
		if (entry.status === "skip" || entry.changes_applied === 0) return "Nothing worth codifying.";
		if (!entry.details || entry.details.length === 0) return "Drain " + entry.drain_id;
		var names = entry.details.map(function (d) { return d.file; });
		if (names.length === 1) return names[0];
		if (names.length <= 3) return names.join(" \u00B7 ");
		return names.slice(0, 2).join(" \u00B7 ") + " + " + (names.length - 2) + " more";
	}

	function renderCardBody(entry) {
		var cached = state.versionCache[entry.version];
		if (state.versionLoading[entry.version] && !cached) {
			var pill = '<div class="dash-table-skeleton-pill"></div>';
			return '<div style="display:flex; flex-direction:column; gap:10px;">' + pill + pill + pill + '</div>';
		}
		if (state.versionErrors[entry.version] && !cached) {
			return (
				'<div class="dash-drawer-error">' +
				'<p style="margin:0 0 var(--space-2); font-weight:600;">Could not load generation v' + esc(String(entry.version)) + '</p>' +
				'<p style="margin:0 0 var(--space-3);">' + esc(state.versionErrors[entry.version]) + '</p>' +
				'<button class="dash-btn dash-btn-ghost dash-btn-sm" data-retry-version="' + entry.version + '">Retry</button>' +
				'</div>'
			);
		}
		if (!cached) return "";
		var sessionsRow = renderSessionsPills(entry.session_ids || []);
		var diffs = (cached.diff || []).map(function (d, i) { return renderDiffFile(d, entry.version, i); }).join("");
		var drainLine = '<p class="dash-timeline-card-meta">Drain ' + esc(entry.drain_id) + ' \u00B7 ' + esc(absoluteTime(entry.timestamp)) + '</p>';
		return drainLine + sessionsRow + '<div class="dash-timeline-diffs">' + diffs + '</div>';
	}

	function renderSessionsPills(sessionIds) {
		if (!sessionIds || sessionIds.length === 0) return "";
		var pills = sessionIds.map(function (id) {
			var encoded = encodeURIComponent(id);
			return '<a href="#/sessions/' + esc(encoded) + '" class="dash-session-pill" data-session-key="' + esc(id) + '">' + esc(id) + '</a>';
		}).join("");
		return '<div class="dash-timeline-sessions"><span class="dash-timeline-sessions-label">Sessions</span>' + pills + '</div>';
	}

	function renderDiffFile(diff, version, idx) {
		var typeCls = typeChipClass(diff.type);
		var previewId = 'evolution-preview-' + version + '-' + idx;
		var sessionsPills = renderSessionsPills(diff.session_ids || []);
		var sizeLine = diff.type === "delete" ? "deleted" : formatBytes(diff.current_size) + (diff.current_content && diff.current_size > diff.current_content.length ? " (preview truncated)" : "");
		var previewBlock = diff.type === "delete"
			? '<p class="dash-timeline-card-meta">No current content on disk.</p>'
			: '<pre class="dash-diff-preview" id="' + previewId + '" data-preview-version="' + version + '" data-preview-idx="' + idx + '"></pre>';
		return (
			'<div class="dash-diff-file">' +
			'<div class="dash-diff-meta">' +
			'<span class="dash-diff-file-name">' + esc(diff.file) + '</span>' +
			'<span class="dash-status-chip ' + typeCls + '">' + esc(diff.type) + '</span>' +
			'<span class="dash-diff-file-size">' + esc(sizeLine) + '</span>' +
			'</div>' +
			(diff.summary ? '<p class="dash-diff-line"><span class="dash-diff-line-label">Summary</span><span class="dash-diff-line-value">' + esc(diff.summary) + '</span></p>' : '') +
			(diff.rationale ? '<p class="dash-diff-line"><span class="dash-diff-line-label">Rationale</span><span class="dash-diff-line-value">' + esc(diff.rationale) + '</span></p>' : '') +
			sessionsPills +
			previewBlock +
			'</div>'
		);
	}

	function paintDiffContent() {
		if (!root) return;
		var nodes = root.querySelectorAll(".dash-diff-preview[data-preview-version]");
		for (var i = 0; i < nodes.length; i++) {
			var node = nodes[i];
			var version = Number(node.getAttribute("data-preview-version"));
			var idx = Number(node.getAttribute("data-preview-idx"));
			var cached = state.versionCache[version];
			if (!cached || !cached.diff || !cached.diff[idx]) continue;
			var content = cached.diff[idx].current_content || "";
			if (content.length > FILE_PREVIEW_MAX_CHARS) content = content.slice(0, FILE_PREVIEW_MAX_CHARS) + "\n\u2026";
			node.textContent = content || "(empty file)";
		}
	}

	function wireHeader() {
		var retryOverview = document.getElementById("evolution-retry-overview");
		if (retryOverview) retryOverview.addEventListener("click", loadOverview);
	}

	function wireTimeline() {
		var retry = document.getElementById("evolution-retry-timeline");
		if (retry) retry.addEventListener("click", function () { loadTimeline(true); });
		var loadMore = document.getElementById("evolution-load-more");
		if (loadMore) loadMore.addEventListener("click", onLoadMore);

		var headers = root.querySelectorAll("[data-expand]");
		for (var i = 0; i < headers.length; i++) {
			headers[i].addEventListener("click", onHeaderClick);
			headers[i].addEventListener("keydown", onHeaderKeyDown);
		}
		var retries = root.querySelectorAll("[data-retry-version]");
		for (var j = 0; j < retries.length; j++) {
			retries[j].addEventListener("click", onRetryVersionClick);
		}
		var pills = root.querySelectorAll(".dash-session-pill");
		for (var k = 0; k < pills.length; k++) {
			pills[k].addEventListener("click", onSessionPillClick);
		}
	}

	function onHeaderClick(e) {
		e.preventDefault();
		var node = e.currentTarget;
		var version = Number(node.getAttribute("data-expand"));
		if (!Number.isInteger(version)) return;
		toggleCard(version);
	}

	function onHeaderKeyDown(e) {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			onHeaderClick(e);
		}
	}

	function onRetryVersionClick(e) {
		e.preventDefault();
		e.stopPropagation();
		var version = Number(e.currentTarget.getAttribute("data-retry-version"));
		state.versionErrors[version] = null;
		fetchVersion(version);
	}

	function onSessionPillClick(e) {
		e.preventDefault();
		e.stopPropagation();
		var key = e.currentTarget.getAttribute("data-session-key");
		if (!key) return;
		ctx.navigate("#/sessions/" + encodeURIComponent(key));
	}

	function toggleCard(version) {
		var nowOpen = !state.expanded[version];
		state.expanded[version] = nowOpen;
		if (nowOpen && !state.versionCache[version] && !state.versionLoading[version]) {
			fetchVersion(version);
			return;
		}
		renderTimelineOnly();
	}

	function renderTimelineOnly() {
		var container = root.querySelector(".dash-timeline");
		var existingFooter = root.querySelector(".dash-timeline-footer");
		var fresh = document.createElement("div");
		fresh.innerHTML = renderTimelineSection();
		if (container && container.parentNode) {
			container.parentNode.replaceChild(fresh, container);
			if (existingFooter && existingFooter.parentNode) existingFooter.parentNode.removeChild(existingFooter);
			wireTimeline();
			paintDiffContent();
		} else {
			render();
		}
	}

	function loadOverview() {
		state.overviewLoading = true;
		state.overviewError = null;
		render();
		return ctx.api("GET", "/ui/api/evolution")
			.then(function (res) {
				state.overviewLoading = false;
				state.overview = res;
				render();
			})
			.catch(function (err) {
				state.overviewLoading = false;
				state.overviewError = err.message || String(err);
				render();
				ctx.toast("error", "Failed to load evolution", state.overviewError);
			});
	}

	function loadTimeline(reset) {
		if (reset) {
			state.entries = [];
			state.hasMore = false;
			state.timelineError = null;
		}
		state.timelineLoading = true;
		render();
		var params = ["limit=" + DEFAULT_LIMIT];
		return ctx.api("GET", "/ui/api/evolution/timeline?" + params.join("&"))
			.then(function (res) {
				state.timelineLoading = false;
				state.entries = res.entries || [];
				state.hasMore = !!res.has_more;
				if (state.deepLink !== null) tryExpandDeepLink();
				render();
			})
			.catch(function (err) {
				state.timelineLoading = false;
				state.timelineError = err.message || String(err);
				render();
				ctx.toast("error", "Failed to load timeline", state.timelineError);
			});
	}

	function onLoadMore() {
		if (state.entries.length === 0) return;
		var oldest = state.entries[state.entries.length - 1];
		var btn = document.getElementById("evolution-load-more");
		if (btn) btn.setAttribute("disabled", "disabled");
		ctx.api("GET", "/ui/api/evolution/timeline?limit=" + DEFAULT_LIMIT + "&before_version=" + oldest.version)
			.then(function (res) {
				var next = res.entries || [];
				state.entries = state.entries.concat(next);
				state.hasMore = !!res.has_more;
				render();
			})
			.catch(function (err) {
				if (btn) btn.removeAttribute("disabled");
				ctx.toast("error", "Failed to load more", err.message || String(err));
			});
	}

	function fetchVersion(version) {
		state.versionLoading[version] = true;
		renderTimelineOnly();
		return ctx.api("GET", "/ui/api/evolution/version/" + encodeURIComponent(String(version)))
			.then(function (res) {
				state.versionLoading[version] = false;
				state.versionCache[version] = res;
				renderTimelineOnly();
			})
			.catch(function (err) {
				state.versionLoading[version] = false;
				state.versionErrors[version] = err.message || String(err);
				renderTimelineOnly();
			});
	}

	function tryExpandDeepLink() {
		if (state.deepLink === null) return;
		var target = state.deepLink;
		var found = state.entries.some(function (e) { return e.version === target; });
		if (found) {
			state.expanded[target] = true;
			if (!state.versionCache[target] && !state.versionLoading[target]) fetchVersion(target);
			setTimeout(function () {
				var node = root && root.querySelector('[data-version="' + target + '"]');
				if (node && typeof node.scrollIntoView === "function") {
					try { node.scrollIntoView({ block: "start", behavior: "smooth" }); } catch (_) { /* ignore */ }
				}
			}, 100);
		} else {
			ctx.toast("info", "Generation v" + target + " not in the current page", "Click Load more to scroll back further in history.");
		}
		state.deepLink = null;
	}

	function resetState() {
		state.overview = null;
		state.overviewLoading = false;
		state.overviewError = null;
		state.entries = [];
		state.timelineLoading = false;
		state.timelineError = null;
		state.hasMore = false;
		state.expanded = {};
		state.versionCache = {};
		state.versionLoading = {};
		state.versionErrors = {};
		state.deepLink = null;
	}

	function mount(container, arg, dashCtx) {
		ctx = dashCtx;
		root = container;
		ctx.setBreadcrumb("Evolution");
		resetState();
		state.deepLink = parseDeepLink(arg);
		render();
		return Promise.all([loadOverview(), loadTimeline(true)]);
	}

	if (window.PhantomDashboard && window.PhantomDashboard.registerRoute) {
		window.PhantomDashboard.registerRoute("evolution", { mount: mount });
	}
})();
