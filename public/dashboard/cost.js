// Cost tab: read-only view of token spend and model usage over time.
//
// Module contract: registers with PhantomDashboard via
// registerRoute("cost", { mount }). mount(container, arg, ctx) is called
// on hash change. Cost does not honor `arg` (no per-item deep link); it
// links OUT to Sessions via #/sessions/<session_key> instead.
//
// All values from the API flow through ctx.esc() or textContent. Operator-
// controlled fields include model (from cost_events), channel_id,
// conversation_id, and session_key. Audit every interpolation.

(function () {
	var CHANNELS = ["slack", "chat", "telegram", "email", "webhook", "scheduler", "cli", "mcp", "trigger"];
	var SERIES_PALETTE_LENGTH = 8;

	var state = {
		loading: false,
		error: null,
		data: null,
		range: "30",
		groupBy: "day",
	};
	var ctx = null;
	var root = null;
	var hoverTooltipEl = null;

	function esc(s) { return ctx.esc(s); }

	function formatCost(n) {
		if (typeof n !== "number" || !isFinite(n)) return "$0.00";
		if (n === 0) return "$0.00";
		if (n > 0 && n < 0.01) return "<$0.01";
		if (n >= 1000) return "$" + Math.round(n).toLocaleString();
		return "$" + n.toFixed(2);
	}

	function formatCostShort(n) {
		if (typeof n !== "number" || !isFinite(n)) return "$0";
		if (n === 0) return "$0";
		if (n >= 1000) return "$" + (n / 1000).toFixed(1) + "k";
		if (n >= 10) return "$" + Math.round(n);
		if (n >= 1) return "$" + n.toFixed(1);
		return "$" + n.toFixed(2);
	}

	function formatInt(n) {
		if (typeof n !== "number" || !isFinite(n)) return "0";
		return Math.round(n).toLocaleString();
	}

	function formatPct(n) {
		if (typeof n !== "number" || !isFinite(n)) return "0%";
		var sign = n > 0 ? "+" : "";
		return sign + n.toFixed(1) + "%";
	}

	function formatShortDate(isoDay) {
		if (!isoDay) return "";
		var parts = String(isoDay).split("-");
		if (parts.length !== 3) return isoDay;
		var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
		var m = parseInt(parts[1], 10) - 1;
		if (m < 0 || m > 11) return isoDay;
		return months[m] + " " + parseInt(parts[2], 10);
	}

	function parseSqlDate(s) {
		if (!s) return null;
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
		return Math.floor(day / 365) + "y ago";
	}

	function modelLabel(model) {
		return String(model || "").replace(/^claude-/, "").replace(/-\d+$/, "") || "unknown";
	}

	function channelColorIdx(channelId) {
		var idx = CHANNELS.indexOf(channelId);
		if (idx < 0) {
			var h = 0;
			for (var i = 0; i < channelId.length; i++) h = ((h << 5) - h + channelId.charCodeAt(i)) | 0;
			idx = Math.abs(h);
		}
		return idx % SERIES_PALETTE_LENGTH;
	}

	// Build a stable model->seriesIdx map. The model with the highest total
	// cost in the range gets idx 0 (primary color), then idx 1, etc.
	function buildModelIndex(byModel) {
		var map = {};
		for (var i = 0; i < byModel.length; i++) {
			map[byModel[i].model] = i % SERIES_PALETTE_LENGTH;
		}
		return map;
	}

	// Round up to a "nice" increment so y-axis ticks are human readable.
	function niceCeil(v) {
		if (v <= 0) return 1;
		var pow = Math.pow(10, Math.floor(Math.log10(v)));
		var n = v / pow;
		var bucket = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
		return bucket * pow;
	}

	// ---- Rendering ----

	function renderHeader() {
		return (
			'<div class="dash-header">' +
			'<p class="dash-header-eyebrow">Cost</p>' +
			'<h1 class="dash-header-title">Cost</h1>' +
			'<p class="dash-header-lead">Token spend and model usage over time. Drill down to the most expensive sessions to see what drove the bill.</p>' +
			'<div class="dash-header-actions">' +
			'<button class="dash-btn dash-btn-ghost" id="cost-export-btn">Export CSV</button>' +
			'</div>' +
			'</div>'
		);
	}

	function renderFilterBar() {
		var rangeOpts = [
			{ v: "7", l: "Last 7 days" },
			{ v: "30", l: "Last 30 days" },
			{ v: "90", l: "Last 90 days" },
			{ v: "all", l: "All time" },
		].map(function (o) {
			return '<option value="' + o.v + '"' + (state.range === o.v ? " selected" : "") + '>' + esc(o.l) + '</option>';
		}).join("");

		return (
			'<div class="dash-filter-bar" role="group" aria-label="Cost filters">' +
			'<div class="dash-filter-group">' +
			'<label class="dash-filter-label" for="cost-filter-range">Range</label>' +
			'<select class="dash-filter-select" id="cost-filter-range">' + rangeOpts + '</select>' +
			'</div>' +
			'<div class="dash-filter-group">' +
			'<span class="dash-filter-label">Group by</span>' +
			'<div class="dash-segmented" role="group" aria-label="Group by">' +
			'<button type="button" id="cost-group-day" aria-pressed="' + (state.groupBy === "day" ? "true" : "false") + '">Day</button>' +
			'<button type="button" id="cost-group-week" aria-pressed="' + (state.groupBy === "week" ? "true" : "false") + '">Week</button>' +
			'</div>' +
			'</div>' +
			'</div>'
		);
	}

	function metricCard(label, valueHtml, deltaHtml) {
		return (
			'<div class="dash-metric-card">' +
			'<p class="dash-metric-label">' + esc(label) + '</p>' +
			'<p class="dash-metric-value">' + valueHtml + '</p>' +
			(deltaHtml ? '<p class="dash-metric-delta">' + deltaHtml + '</p>' : "") +
			'</div>'
		);
	}

	function deltaClass(n) {
		return n > 0 ? "dash-metric-delta-down" : n < 0 ? "dash-metric-delta-up" : "";
	}

	function renderMetricStrip() {
		if (!state.data) {
			var skel = '<div class="dash-metric-card dash-metric-skeleton" aria-hidden="true"><p class="dash-metric-label">.</p><p class="dash-metric-value">.</p></div>';
			return '<div class="dash-metric-strip" aria-busy="true">' + skel + skel + skel + skel + skel + '</div>';
		}
		var h = state.data.headline;
		var dayDelta = h.yesterday === 0 && h.today === 0
			? "No activity"
			: '<span class="' + deltaClass(h.day_delta_pct) + '">' + esc(formatPct(h.day_delta_pct) + " vs yesterday") + '</span>';
		var weekDelta = '<span class="' + deltaClass(h.week_delta_pct) + '">' + esc(formatPct(h.week_delta_pct) + " vs prior week") + '</span>';
		var avgDaily = state.data.daily.length > 0
			? state.data.daily.reduce(function (a, r) { return a + r.cost_usd; }, 0) / state.data.daily.length
			: 0;
		return (
			'<div class="dash-metric-strip">' +
			metricCard("Today", esc(formatCost(h.today)), dayDelta) +
			metricCard("Yesterday", esc(formatCost(h.yesterday))) +
			metricCard("This week", esc(formatCost(h.this_week)), weekDelta) +
			metricCard("This month", esc(formatCost(h.this_month)), esc("avg " + formatCost(avgDaily) + "/d")) +
			metricCard("All time", esc(formatCost(h.all_time))) +
			'</div>'
		);
	}

	// ---- Chart ----

	// Bucket daily rows into Monday-start weeks when groupBy === "week".
	function bucketByWeek(daily) {
		if (daily.length === 0) return [];
		var buckets = [];
		var current = null;
		for (var i = 0; i < daily.length; i++) {
			var d = daily[i];
			var dt = new Date(d.day + "T00:00:00Z");
			var monday = new Date(dt.getTime() - ((dt.getUTCDay() + 6) % 7) * 86400000);
			var key = monday.toISOString().slice(0, 10);
			if (!current || current.day !== key) {
				current = { day: key, cost_usd: 0, by_model: {} };
				buckets.push(current);
			}
			current.cost_usd += d.cost_usd;
			for (var j = 0; j < d.by_model.length; j++) {
				var m = d.by_model[j];
				current.by_model[m.model] = (current.by_model[m.model] || 0) + m.cost_usd;
			}
		}
		return buckets.map(function (b) {
			var arr = Object.keys(b.by_model).map(function (k) { return { model: k, cost_usd: b.by_model[k] }; });
			arr.sort(function (a, b2) { return b2.cost_usd - a.cost_usd; });
			return { day: b.day, cost_usd: b.cost_usd, by_model: arr };
		});
	}

	// Generic stacked-bar SVG renderer. opts.rows is an array of
	// { day, segments: [{ value, seriesIdx }] }. Returns SVG markup; the
	// caller wires up hover on .dash-chart-bar-hit after it lands in DOM.
	function renderStackedBarChart(opts) {
		var rows = opts.rows;
		var width = opts.width;
		var height = opts.height;
		var formatY = opts.formatY || function (n) { return String(n); };
		var padL = 46, padR = 12, padT = 8, padB = 28;
		var innerW = Math.max(1, width - padL - padR);
		var innerH = Math.max(1, height - padT - padB);

		if (rows.length === 0) {
			return '<svg class="dash-chart-svg" viewBox="0 0 ' + width + ' ' + height + '"></svg>';
		}

		var maxTotal = 0;
		for (var i = 0; i < rows.length; i++) {
			var t = 0;
			for (var k = 0; k < rows[i].segments.length; k++) t += rows[i].segments[k].value;
			if (t > maxTotal) maxTotal = t;
		}
		var yMax = niceCeil(maxTotal || 0.01);
		var ticks = 4;

		var parts = ['<svg class="dash-chart-svg" viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none" role="img" aria-label="Stacked bar chart">'];

		for (var tk = 0; tk <= ticks; tk++) {
			var yv = (yMax * tk) / ticks;
			var yP = padT + innerH - (yv / yMax) * innerH;
			parts.push('<line class="dash-chart-gridline" x1="' + padL + '" y1="' + yP + '" x2="' + (padL + innerW) + '" y2="' + yP + '"/>');
			parts.push('<text class="dash-chart-tick-label" x="' + (padL - 6) + '" y="' + (yP + 3) + '" text-anchor="end">' + esc(formatY(yv)) + '</text>');
		}
		parts.push('<line class="dash-chart-axis" x1="' + padL + '" y1="' + (padT + innerH) + '" x2="' + (padL + innerW) + '" y2="' + (padT + innerH) + '"/>');

		var gap = rows.length > 60 ? 1 : rows.length > 30 ? 2 : 3;
		var barW = Math.max(2, (innerW - gap * (rows.length - 1)) / rows.length);
		var labelEvery = Math.max(1, Math.ceil(rows.length / 8));

		for (var b = 0; b < rows.length; b++) {
			var row = rows[b];
			var x = padL + b * (barW + gap);
			var cursorY = padT + innerH;
			var group = '<g class="dash-chart-bar-group" data-bar-index="' + b + '">';
			for (var s = 0; s < row.segments.length; s++) {
				var seg = row.segments[s];
				if (seg.value <= 0) continue;
				var segH = (seg.value / yMax) * innerH;
				cursorY -= segH;
				group += '<rect class="dash-chart-bar" data-series-idx="' + (seg.seriesIdx % SERIES_PALETTE_LENGTH) + '" x="' + x + '" y="' + cursorY + '" width="' + barW + '" height="' + segH + '"></rect>';
			}
			group += '<rect class="dash-chart-bar-hit" data-bar-index="' + b + '" x="' + x + '" y="' + padT + '" width="' + barW + '" height="' + innerH + '" fill="transparent" pointer-events="all"></rect></g>';
			parts.push(group);
			if (b % labelEvery === 0 || b === rows.length - 1) {
				parts.push('<text class="dash-chart-tick-label" x="' + (x + barW / 2) + '" y="' + (padT + innerH + 14) + '" text-anchor="middle">' + esc(formatShortDate(row.day)) + '</text>');
			}
		}
		parts.push('</svg>');
		return parts.join("");
	}

	function chartFrame(title, id, body) {
		var idAttr = id ? ' id="' + id + '"' : "";
		return (
			'<div class="dash-chart"' + idAttr + '>' +
			'<div class="dash-chart-header"><p class="dash-chart-title">' + esc(title) + '</p></div>' +
			body +
			'</div>'
		);
	}

	function renderChart() {
		var title = state.groupBy === "week" ? "Weekly spend" : "Daily spend";
		if (state.loading && !state.data) {
			return chartFrame(title, "", '<div class="dash-chart-skeleton" aria-hidden="true"></div>');
		}
		if (!state.data || state.data.daily.length === 0) {
			return chartFrame(title, "", '<div class="dash-chart-empty">No cost events in this range yet.</div>');
		}
		var modelIdx = buildModelIndex(state.data.by_model);
		var source = state.groupBy === "week" ? bucketByWeek(state.data.daily) : state.data.daily;
		var chartRows = source.map(function (d) {
			return {
				day: d.day,
				segments: d.by_model.map(function (m) {
					return { value: m.cost_usd, seriesIdx: modelIdx[m.model] || 0 };
				}),
			};
		});
		var svg = renderStackedBarChart({
			rows: chartRows,
			width: Math.max(640, chartRows.length * 24),
			height: 260,
			formatY: formatCostShort,
		});
		return chartFrame(title, "cost-chart",
			'<div class="dash-chart-scroll">' + svg + '</div>' +
			'<div class="dash-chart-tooltip" id="cost-chart-tooltip" aria-hidden="true"></div>');
	}

	// Generic table shell: headers declare label + class, rows is raw HTML.
	// When rows is "" renders an empty-state row spanning all columns.
	function renderTable(label, headers, rowsHtml, emptyMsg, bodyId) {
		var headHtml = headers.map(function (h) {
			var cls = "dash-table-head-cell" + (h.numeric ? " dash-table-head-cell-numeric" : "");
			return '<th class="' + cls + '" scope="col">' + esc(h.label) + '</th>';
		}).join("");
		var body = rowsHtml
			? rowsHtml
			: '<tr><td colspan="' + headers.length + '" class="dash-table-empty">' + esc(emptyMsg) + '</td></tr>';
		var bodyAttr = bodyId ? ' id="' + bodyId + '"' : "";
		return (
			'<div class="dash-table-wrap">' +
			'<table class="dash-table" aria-label="' + esc(label) + '">' +
			'<thead class="dash-table-head"><tr>' + headHtml + '</tr></thead>' +
			'<tbody' + bodyAttr + '>' + body + '</tbody>' +
			'</table>' +
			'</div>'
		);
	}

	function renderByModel() {
		var headers = [
			{ label: "Model" },
			{ label: "Cost", numeric: true },
			{ label: "Share", numeric: true },
		];
		if (!state.data) return renderTable("By model", headers, "", "Loading.");
		var rows = state.data.by_model;
		if (rows.length === 0) return renderTable("By model", headers, "", "No models in this range.");
		var modelIdx = buildModelIndex(rows);
		var body = rows.map(function (r) {
			return (
				'<tr class="dash-table-row">' +
				'<td class="dash-table-cell">' +
				'<span class="dash-breakdown-swatch" data-series-idx="' + (modelIdx[r.model] || 0) + '"></span>' +
				'<span class="dash-table-cell-mono">' + esc(modelLabel(r.model)) + '</span>' +
				'</td>' +
				'<td class="dash-table-cell dash-table-cell-numeric">' + esc(formatCost(r.cost_usd)) + '</td>' +
				'<td class="dash-table-cell dash-table-cell-numeric">' + esc((r.pct * 100).toFixed(1) + "%") + '</td>' +
				'</tr>'
			);
		}).join("");
		return renderTable("By model", headers, body);
	}

	function channelCell(channelId) {
		return '<span class="dash-channel-glyph"><span class="dash-channel-glyph-dot" data-channel-idx="' + channelColorIdx(channelId) + '"></span>' + esc(channelId) + '</span>';
	}

	function conversationCell(row) {
		if (row.channel_id === "slack") {
			var parts = String(row.conversation_id || "").split("/");
			if (parts.length >= 2) {
				return '<span class="phantom-muted">' + esc(parts[0]) + ' / </span>' + esc(parts.slice(1).join("/"));
			}
		}
		return esc(row.conversation_id);
	}

	function renderByChannel() {
		var headers = [{ label: "Channel" }, { label: "Cost", numeric: true }, { label: "Per session", numeric: true }];
		if (!state.data) return renderTable("By channel", headers, "", "Loading.");
		var rows = state.data.by_channel;
		if (rows.length === 0) return renderTable("By channel", headers, "", "No channels in this range.");
		var body = rows.map(function (r) {
			return (
				'<tr class="dash-table-row">' +
				'<td class="dash-table-cell">' + channelCell(r.channel_id) + '</td>' +
				'<td class="dash-table-cell dash-table-cell-numeric">' + esc(formatCost(r.cost_usd)) + '</td>' +
				'<td class="dash-table-cell dash-table-cell-numeric">' + esc(formatCost(r.avg_per_session)) + '</td>' +
				'</tr>'
			);
		}).join("");
		return renderTable("By channel", headers, body);
	}

	function renderTopSessions() {
		var headers = [
			{ label: "Channel" },
			{ label: "Conversation" },
			{ label: "Cost", numeric: true },
			{ label: "Turns", numeric: true },
			{ label: "Last active" },
		];
		var rows = state.data ? state.data.top_sessions : null;
		if (!rows) return renderTable("Top sessions", headers, "", "Loading.", "cost-top-tbody");
		if (rows.length === 0) return renderTable("Top sessions", headers, "", "No sessions in this range.", "cost-top-tbody");
		var body = rows.map(function (r) {
			var keyAttr = encodeURIComponent(r.session_key);
			return (
				'<tr class="dash-table-row" data-clickable="true" data-session-key="' + esc(r.session_key) + '" data-session-key-encoded="' + esc(keyAttr) + '" tabindex="0" role="button" aria-label="Open session ' + esc(r.session_key) + '">' +
				'<td class="dash-table-cell">' + channelCell(r.channel_id) + '</td>' +
				'<td class="dash-table-cell dash-table-cell-mono">' + conversationCell(r) + '</td>' +
				'<td class="dash-table-cell dash-table-cell-numeric">' + esc(formatCost(r.total_cost_usd)) + '</td>' +
				'<td class="dash-table-cell dash-table-cell-numeric">' + formatInt(r.turn_count) + '</td>' +
				'<td class="dash-table-cell dash-table-cell-muted">' + esc(relativeTime(r.last_active_at)) + '</td>' +
				'</tr>'
			);
		}).join("");
		return renderTable("Top sessions", headers, body, "", "cost-top-tbody");
	}

	function renderError() {
		return (
			'<div class="dash-empty" style="margin-bottom: var(--space-5);">' +
			'<h3 class="dash-empty-title">Could not load cost data</h3>' +
			'<p class="dash-empty-body">' + esc((state.error && state.error.message) || "Unknown error") + '</p>' +
			'<button class="dash-btn dash-btn-ghost" id="cost-retry-btn">Retry</button>' +
			'</div>'
		);
	}

	function sectionLabel(text) {
		return '<p class="dash-drawer-section-label" style="margin-bottom: var(--space-2);">' + esc(text) + '</p>';
	}

	function render() {
		if (!root) return;
		if (state.error) {
			root.innerHTML = renderHeader() + renderFilterBar() + renderError();
			wireFilterBar();
			var r = document.getElementById("cost-retry-btn");
			if (r) r.addEventListener("click", load);
			return;
		}
		root.innerHTML = (
			renderHeader() + renderFilterBar() + renderMetricStrip() + renderChart() +
			'<div class="dash-breakdown-grid">' +
			'<section>' + sectionLabel("By model") + renderByModel() + '</section>' +
			'<section>' + sectionLabel("By channel") + renderByChannel() + '</section>' +
			'</div>' +
			'<section style="margin-bottom: var(--space-5);">' + sectionLabel("Top 10 sessions") + renderTopSessions() + '</section>'
		);
		wireFilterBar();
		wireChart();
		wireTopSessions();
		wireExport();
	}

	// ---- Wiring ----

	function wireFilterBar() {
		var range = document.getElementById("cost-filter-range");
		if (range) range.addEventListener("change", function () {
			state.range = range.value;
			load();
		});
		var d = document.getElementById("cost-group-day");
		var w = document.getElementById("cost-group-week");
		if (d) d.addEventListener("click", function () {
			if (state.groupBy === "day") return;
			state.groupBy = "day";
			render();
		});
		if (w) w.addEventListener("click", function () {
			if (state.groupBy === "week") return;
			state.groupBy = "week";
			render();
		});
	}

	function wireTopSessions() {
		var tbody = document.getElementById("cost-top-tbody");
		if (!tbody) return;
		var rows = tbody.querySelectorAll(".dash-table-row[data-clickable]");
		for (var i = 0; i < rows.length; i++) {
			rows[i].addEventListener("click", onRowActivate);
			rows[i].addEventListener("keydown", onRowKeyDown);
		}
	}

	function onRowActivate(e) {
		var encoded = e.currentTarget.getAttribute("data-session-key-encoded");
		if (encoded) ctx.navigate("#/sessions/" + encoded);
	}

	function onRowKeyDown(e) {
		if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onRowActivate(e); }
	}

	function wireExport() {
		var btn = document.getElementById("cost-export-btn");
		if (btn) btn.addEventListener("click", exportCsv);
	}

	function wireChart() {
		var chart = document.getElementById("cost-chart");
		if (!chart || !state.data) return;
		hoverTooltipEl = document.getElementById("cost-chart-tooltip");
		var hits = chart.querySelectorAll(".dash-chart-bar-hit");
		var source = state.groupBy === "week" ? bucketByWeek(state.data.daily) : state.data.daily;
		var modelIdx = buildModelIndex(state.data.by_model);
		for (var i = 0; i < hits.length; i++) {
			(function (hit) {
				hit.addEventListener("mouseenter", function (e) { showTooltip(e, hit, source, modelIdx); });
				hit.addEventListener("mousemove", function (e) { positionTooltip(e, hit); });
				hit.addEventListener("mouseleave", hideTooltip);
			})(hits[i]);
		}
	}

	function showTooltip(evt, hit, source, modelIdx) {
		if (!hoverTooltipEl) return;
		var idx = parseInt(hit.getAttribute("data-bar-index"), 10);
		if (isNaN(idx) || !source[idx]) return;
		var row = source[idx];
		var title = (state.groupBy === "week" ? "Week of " : "") + formatShortDate(row.day);
		var segRows = row.by_model.map(function (m) {
			var mi = (modelIdx[m.model] || 0) % SERIES_PALETTE_LENGTH;
			return (
				'<div class="dash-chart-tooltip-row">' +
				'<span class="dash-chart-tooltip-swatch" data-series-idx="' + mi + '"></span>' +
				'<span>' + esc(modelLabel(m.model)) + '</span>' +
				'<span style="margin-left:auto;">' + esc(formatCost(m.cost_usd)) + '</span>' +
				'</div>'
			);
		}).join("");
		hoverTooltipEl.innerHTML = (
			'<p class="dash-chart-tooltip-title">' + esc(title) + '</p>' +
			segRows +
			'<p class="dash-chart-tooltip-total">Total ' + esc(formatCost(row.cost_usd)) + '</p>'
		);
		hoverTooltipEl.setAttribute("data-visible", "true");
		positionTooltip(evt, hit);
	}

	function positionTooltip(_evt, hit) {
		if (!hoverTooltipEl) return;
		var chart = document.getElementById("cost-chart");
		if (!chart) return;
		var rect = chart.getBoundingClientRect();
		var hitRect = hit.getBoundingClientRect();
		var cx = hitRect.left + hitRect.width / 2 - rect.left;
		var half = (hoverTooltipEl.offsetWidth || 200) / 2;
		if (cx - half < 6) cx = half + 6;
		if (cx + half > rect.width - 6) cx = rect.width - half - 6;
		hoverTooltipEl.style.left = cx + "px";
		hoverTooltipEl.style.top = Math.max(0, hitRect.top - rect.top) + "px";
	}

	function hideTooltip() {
		if (hoverTooltipEl) hoverTooltipEl.setAttribute("data-visible", "false");
	}

	// ---- Load ----

	function load() {
		state.loading = true;
		state.error = null;
		render();
		var url = "/ui/api/cost?days=" + encodeURIComponent(state.range);
		return ctx.api("GET", url).then(function (res) {
			state.data = res;
			state.loading = false;
			render();
		}).catch(function (err) {
			state.loading = false;
			state.error = err;
			state.data = null;
			render();
			ctx.toast("error", "Failed to load cost data", err.message || String(err));
		});
	}

	// ---- CSV export ----

	function exportCsv() {
		if (!state.data || state.data.daily.length === 0) {
			ctx.toast("error", "Nothing to export", "No cost data in the current range.");
			return;
		}
		var headers = ["day", "cost_usd", "input_tokens", "output_tokens"];
		var rows = [headers.join(",")];
		state.data.daily.forEach(function (d) {
			rows.push([d.day, d.cost_usd.toFixed(6), d.input_tokens, d.output_tokens].join(","));
		});
		var csv = rows.join("\n");
		var blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
		var url = URL.createObjectURL(blob);
		var a = document.createElement("a");
		a.href = url;
		a.download = "cost-" + new Date().toISOString().slice(0, 10) + ".csv";
		document.body.appendChild(a);
		a.click();
		setTimeout(function () {
			URL.revokeObjectURL(url);
			if (a.parentNode) a.parentNode.removeChild(a);
		}, 100);
	}

	// ---- Mount ----

	function mount(container, _arg, dashCtx) {
		ctx = dashCtx;
		root = container;
		ctx.setBreadcrumb("Cost");
		render();
		return load();
	}

	if (window.PhantomDashboard && window.PhantomDashboard.registerRoute) {
		window.PhantomDashboard.registerRoute("cost", { mount: mount });
	}
})();
