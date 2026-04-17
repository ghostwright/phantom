// Scheduler dashboard tab: list, detail drawer, create drawer with templates
// and Sonnet describe-assist. Values from the API flow through ctx.esc() or
// textContent. The task field renders as pre-wrapped text via textContent.
// Cardinal Rule: the describe endpoint fills a form. The operator reviews
// and edits the proposal before saving. See src/scheduler/parse-with-sonnet.ts.

(function () {
	var TASK_MAX = 32 * 1024;
	var DESCRIPTION_MAX = 1000;
	var DESCRIBE_MAX = 2000;
	var NAME_MAX = 200;
	var PREVIEW_DEBOUNCE_MS = 300;
	var SEARCH_DEBOUNCE_MS = 200;

	var TZ_OPTIONS = ["UTC", "America/Los_Angeles", "America/New_York", "America/Chicago", "Europe/London", "Europe/Berlin", "Asia/Tokyo", "Asia/Singapore", "Australia/Sydney"];
	var CRON_EXAMPLES = ["*/15 * * * *", "0 9 * * *", "0 9 * * 1-5", "0 0 1 * *", "0 17 * * 5"];

	// Templates. UI kind ("daily") maps to backend cron at submit.
	var TEMPLATES = [
		{ id: "hn-digest", label: "Hacker News digest", description: "Top HN stories every 6 hours, posted to your owner DM",
			values: {
				name: "hn-digest", description: "Top Hacker News stories every 6 hours",
				task: "Fetch the top 10 Hacker News stories from\nhttps://hacker-news.firebaseio.com/v0/topstories.json, resolve each\nto its title and URL, and post a brief summary (one sentence per\nstory) to Slack.",
				schedule: { kind: "every", unit: "hours", value: 6 },
				delivery: { channel: "slack", targetKind: "owner" }, enabled: true } },
		{ id: "daily-standup", label: "Daily standup", description: "9am weekdays, summary of yesterday and today's priorities",
			values: {
				name: "daily-standup", description: "Weekday 9am summary and priorities",
				task: "Summarize yesterday's activity across Slack, pull requests, and scheduled job outputs. Then list three priorities for today. Post to Slack.",
				schedule: { kind: "cron", expr: "0 9 * * 1-5", tz: "America/Los_Angeles" },
				delivery: { channel: "slack", targetKind: "owner" }, enabled: true } },
		{ id: "pr-review-reminder", label: "PR review reminder", description: "Every 2 hours, check for stale open PRs",
			values: {
				name: "pr-review-reminder", description: "Check for stale open PRs needing review",
				task: "List any open pull requests on ghostwright/phantom older than 24 hours that have not received a review. Post to Slack.",
				schedule: { kind: "every", unit: "hours", value: 2 },
				delivery: { channel: "slack", targetKind: "owner" }, enabled: true } },
		{ id: "weekly-metrics", label: "Weekly metrics", description: "Friday 5pm, summary of agent activity this week",
			values: {
				name: "weekly-metrics", description: "Weekly agent activity summary",
				task: "Summarize this week's agent activity: session count, total cost, top channels, notable memories consolidated, evolution changes. Post to Slack.",
				schedule: { kind: "cron", expr: "0 17 * * 5", tz: "America/Los_Angeles" },
				delivery: { channel: "slack", targetKind: "owner" }, enabled: true } },
	];

	var state = makeInitialState();
	var ctx = null, root = null;
	var searchTimer = null, previewTimer = null;
	var drawerRoot = null, drawerKeyHandler = null, drawerFocusRestore = null, prevBodyOverflow = null;
	var documentKeyHandler = null, dirtyRegistered = false;

	function makeInitialState() {
		return {
			loading: false, listError: null, list: null, summary: null,
			filter: { status: "all", q: "" },
			detail: { open: false, id: null, loading: false, error: null, job: null, audit: [], runResult: null, runPending: false },
			create: makeCreateState(),
		};
	}
	function makeCreateState() {
		return {
			open: false, appliedTemplate: null, form: defaultForm(), dirtyByUser: false,
			preview: null, previewError: null, previewPending: false,
			submitting: false, submitError: null,
			describeText: "", describeFilled: false, describePending: false, describeError: null,
			errors: {},
		};
	}
	function defaultForm() {
		return {
			name: "", description: "", task: "",
			schedule: { kind: "every", unit: "hours", value: 1, expr: "", tz: defaultTz(), at: "" },
			delivery: { channel: "slack", targetKind: "owner", target: "" },
			enabled: true, deleteAfterRun: false,
		};
	}
	function defaultTz() {
		try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Los_Angeles"; } catch (_) { return "America/Los_Angeles"; }
	}

	function esc(s) { return ctx ? ctx.esc(s) : ""; }

	function parseSqlDate(s) {
		if (!s) return null;
		var iso = String(s).indexOf("T") >= 0 ? s : String(s).replace(" ", "T") + "Z";
		var d = new Date(iso);
		if (isNaN(d.getTime())) { d = new Date(s); if (isNaN(d.getTime())) return null; }
		return d;
	}
	function relativeTime(s) {
		var d = parseSqlDate(s);
		if (!d) return "";
		var diff = d.getTime() - Date.now();
		var future = diff > 0;
		var sec = Math.round(Math.abs(diff) / 1000);
		var label = sec < 60 ? sec + "s" : sec < 3600 ? Math.round(sec / 60) + "m" : sec < 86400 ? Math.round(sec / 3600) + "h" : Math.round(sec / 86400) + "d";
		return future ? "in " + label : label + " ago";
	}
	function absoluteTime(s) {
		var d = parseSqlDate(s);
		return d ? d.toISOString().replace("T", " ").slice(0, 19) + " UTC" : "";
	}

	function humanSchedule(schedule) {
		if (!schedule) return "";
		if (schedule.kind === "every") {
			var ms = schedule.intervalMs;
			if (!ms) return "every ?";
			if (ms < 60000) return "every " + Math.round(ms / 1000) + "s";
			if (ms < 3_600_000) return "every " + Math.round(ms / 60000) + "m";
			var hrs = ms / 3_600_000;
			if (hrs === Math.floor(hrs) && hrs < 48) return "every " + hrs + "h";
			var days = ms / 86_400_000;
			return days === Math.floor(days) ? "every " + days + "d" : "every " + Math.round(hrs) + "h";
		}
		if (schedule.kind === "at") return "once " + schedule.at;
		if (schedule.kind === "cron") return schedule.expr + (schedule.tz ? " " + schedule.tz : "");
		return "";
	}

	function statusChip(status) {
		if (!status) return "";
		var cls = status === "active" ? "dash-status-chip-active" : status === "paused" ? "dash-status-chip-paused" : status === "completed" ? "dash-status-chip-completed" : status === "failed" ? "dash-status-chip-failed" : "";
		return '<span class="dash-status-chip ' + cls + '">' + esc(status) + '</span>';
	}

	function deliverySummary(d) {
		if (!d) return "";
		return d.channel === "none" ? "silent" : "slack " + (d.target || "owner");
	}

	function cronToHhMm(expr) {
		var parts = (expr || "").trim().split(/\s+/);
		if (parts.length !== 5) return "09:00";
		var m = Number(parts[0]), h = Number(parts[1]);
		if (!Number.isFinite(m) || !Number.isFinite(h)) return "09:00";
		return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
	}

	function formatBytes(n) {
		if (n < 1024) return n + " B";
		if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
		return (n / (1024 * 1024)).toFixed(2) + " MB";
	}

	// ---- list chrome ----

	function render() {
		if (!root) return;
		root.innerHTML = renderHeader() + renderFilterBar() + renderMetricStrip() + renderTable();
		wireFilterBar(); wireTableInteractions(); wireHeaderButtons();
	}

	function renderHeader() {
		return '<div class="dash-header">' +
			'<p class="dash-header-eyebrow">Scheduler</p>' +
			'<h1 class="dash-header-title">Scheduler</h1>' +
			'<p class="dash-header-lead">Every cron and one-shot job the agent knows about, plus the ones you author. Inspect, pause, run now, or delete any schedule in one click.</p>' +
			'<div class="dash-header-actions"><button class="dash-btn dash-btn-primary" id="scheduler-new-btn">+ New job</button></div>' +
			'</div>';
	}

	function renderFilterBar() {
		var statuses = ["all", "active", "paused", "completed", "failed"];
		var opts = statuses.map(function (s) {
			var label = s === "all" ? "All statuses" : s.charAt(0).toUpperCase() + s.slice(1);
			return '<option value="' + esc(s) + '"' + (state.filter.status === s ? " selected" : "") + '>' + esc(label) + '</option>';
		}).join("");
		return '<div class="dash-filter-bar" role="group" aria-label="Scheduler filters">' +
			'<div class="dash-filter-group"><label class="dash-filter-label" for="scheduler-filter-status">Status</label>' +
			'<select class="dash-filter-select" id="scheduler-filter-status">' + opts + '</select></div>' +
			'<div class="dash-filter-search"><svg fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"/></svg>' +
			'<input type="search" id="scheduler-filter-q" placeholder="Search by name or task" value="' + esc(state.filter.q) + '" aria-label="Search scheduler jobs"></div>' +
			'</div>';
	}

	function renderMetricStrip() {
		var s = state.summary;
		if (!s) {
			var sk = '<div class="dash-metric-card dash-metric-skeleton" aria-hidden="true"><p class="dash-metric-label">.</p><p class="dash-metric-value">.</p></div>';
			return '<div class="dash-metric-strip" aria-busy="true">' + sk + sk + sk + sk + sk + sk + '</div>';
		}
		var nextLabel = s.nextFireAt ? relativeTime(s.nextFireAt) : "none";
		return '<div class="dash-metric-strip">' +
			metricCard("Total", String(s.total || 0)) +
			metricCard("Active", String(s.active || 0)) +
			metricCard("Paused", String(s.paused || 0)) +
			metricCard("Failed", String(s.failed || 0)) +
			metricCard("Next run", nextLabel) +
			metricCard("Recent errors", String(s.recentFailures || 0)) +
			'</div>';
	}

	function metricCard(label, value) {
		return '<div class="dash-metric-card"><p class="dash-metric-label">' + esc(label) + '</p><p class="dash-metric-value">' + esc(value) + '</p></div>';
	}

	function filterJobs(jobs) {
		var q = (state.filter.q || "").toLowerCase().trim();
		var out = [];
		for (var i = 0; i < jobs.length; i++) {
			var j = jobs[i];
			if (state.filter.status !== "all" && j.status !== state.filter.status) continue;
			if (q) {
				var hay = (j.name + " " + (j.description || "") + " " + (j.task || "")).toLowerCase();
				if (hay.indexOf(q) < 0) continue;
			}
			out.push(j);
		}
		return out;
	}

	function renderTable() {
		var body;
		if (state.loading && !state.list) body = skeletonRows(5);
		else if (state.listError) body = '<tr><td colspan="7"><div class="dash-table-empty"><p>Could not load scheduler.</p><p style="margin-top:var(--space-2);"><button class="dash-btn dash-btn-ghost dash-btn-sm" id="scheduler-retry-btn">Retry</button></p></div></td></tr>';
		else {
			var jobs = filterJobs((state.list && state.list.jobs) || []);
			body = jobs.length === 0 ? '<tr><td colspan="7">' + renderEmptyState() + '</td></tr>' : jobs.map(renderRow).join("");
		}
		return '<div class="dash-table-wrap">' +
			'<table class="dash-table" aria-label="Scheduled jobs" aria-busy="' + (state.loading ? "true" : "false") + '">' +
			'<thead class="dash-table-head"><tr>' +
			'<th class="dash-table-head-cell" scope="col">Name</th>' +
			'<th class="dash-table-head-cell" scope="col">Schedule</th>' +
			'<th class="dash-table-head-cell" scope="col">Status</th>' +
			'<th class="dash-table-head-cell" scope="col">Next run</th>' +
			'<th class="dash-table-head-cell dash-table-hide-sm" scope="col">Last run</th>' +
			'<th class="dash-table-head-cell dash-table-head-cell-numeric" scope="col">Runs</th>' +
			'<th class="dash-table-head-cell dash-table-hide-sm" scope="col">Errors</th>' +
			'</tr></thead><tbody id="scheduler-tbody">' + body + '</tbody></table></div>';
	}

	function renderRow(job) {
		var errors = job.consecutiveErrors || 0;
		var lastCell = job.lastRunAt ? (job.lastRunStatus === "ok" ? "ok " : "err ") + relativeTime(job.lastRunAt) : "never";
		var errorBadge = errors > 0 ? '<span class="dash-status-chip dash-status-chip-failed">' + esc(String(errors)) + '</span>' : '<span class="phantom-muted">0</span>';
		var nextLabel = job.nextRunAt ? relativeTime(job.nextRunAt) : (job.status === "paused" ? "paused" : "-");
		return '<tr class="dash-table-row" data-clickable="true" data-job-id="' + esc(job.id) + '" tabindex="0" role="button" aria-label="Open job ' + esc(job.name) + '">' +
			'<td class="dash-table-cell dash-table-cell-mono">' + esc(job.name) + '</td>' +
			'<td class="dash-table-cell dash-table-cell-mono phantom-muted">' + esc(humanSchedule(job.schedule)) + '</td>' +
			'<td class="dash-table-cell">' + statusChip(job.status) + '</td>' +
			'<td class="dash-table-cell dash-table-cell-muted" title="' + esc(job.nextRunAt ? absoluteTime(job.nextRunAt) : "") + '">' + esc(nextLabel) + '</td>' +
			'<td class="dash-table-cell dash-table-cell-muted dash-table-hide-sm" title="' + esc(job.lastRunAt ? absoluteTime(job.lastRunAt) : "") + '">' + esc(lastCell) + '</td>' +
			'<td class="dash-table-cell dash-table-cell-numeric">' + esc(String(job.runCount || 0)) + '</td>' +
			'<td class="dash-table-cell dash-table-hide-sm">' + errorBadge + '</td>' +
			'</tr>';
	}

	function skeletonRows(n) {
		var out = [];
		for (var i = 0; i < n; i++) {
			out.push('<tr class="dash-table-skeleton-row" aria-hidden="true">' +
				'<td><div class="dash-table-skeleton-pill" style="width:50%;"></div></td>' +
				'<td><div class="dash-table-skeleton-pill" style="width:65%;"></div></td>' +
				'<td><div class="dash-table-skeleton-pill" style="width:45%;"></div></td>' +
				'<td><div class="dash-table-skeleton-pill" style="width:35%;"></div></td>' +
				'<td class="dash-table-hide-sm"><div class="dash-table-skeleton-pill" style="width:55%;"></div></td>' +
				'<td><div class="dash-table-skeleton-pill" style="width:25%; margin-left:auto;"></div></td>' +
				'<td class="dash-table-hide-sm"><div class="dash-table-skeleton-pill" style="width:30%;"></div></td></tr>');
		}
		return out.join("");
	}

	function renderEmptyState() {
		return '<div class="dash-empty" style="border:none; padding:var(--space-10) var(--space-5);">' +
			'<svg class="dash-empty-icon" fill="none" viewBox="0 0 24 24" stroke-width="1.2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/></svg>' +
			'<h3 class="dash-empty-title">No scheduled jobs yet</h3>' +
			'<p class="dash-empty-body">Click +&nbsp;New&nbsp;job, or ask your agent in Slack to "schedule the top HN digest every 6 hours". Every schedule shows up here with its next run, last outcome, and actions to pause or delete.</p>' +
			'<p style="margin-top:var(--space-4);"><button class="dash-btn dash-btn-primary" id="scheduler-empty-new-btn">Create your first job</button></p>' +
			'</div>';
	}

	function renderTableOnly() {
		var wrap = root.querySelector(".dash-table-wrap");
		if (!wrap) { render(); return; }
		var temp = document.createElement("div");
		temp.innerHTML = renderTable();
		if (temp.firstChild) wrap.parentNode.replaceChild(temp.firstChild, wrap);
		wireTableInteractions();
	}

	function wireFilterBar() {
		var statusEl = document.getElementById("scheduler-filter-status");
		if (statusEl) statusEl.addEventListener("change", function () { state.filter.status = statusEl.value; renderTableOnly(); });
		var qEl = document.getElementById("scheduler-filter-q");
		if (qEl) qEl.addEventListener("input", function () {
			if (searchTimer) clearTimeout(searchTimer);
			var val = qEl.value;
			searchTimer = setTimeout(function () { state.filter.q = val; renderTableOnly(); }, SEARCH_DEBOUNCE_MS);
		});
	}

	function wireHeaderButtons() {
		var a = document.getElementById("scheduler-new-btn");
		if (a) a.addEventListener("click", function () { ctx.navigate("#/scheduler/new"); });
		var b = document.getElementById("scheduler-empty-new-btn");
		if (b) b.addEventListener("click", function () { ctx.navigate("#/scheduler/new"); });
	}

	function wireTableInteractions() {
		var tbody = document.getElementById("scheduler-tbody");
		if (tbody) {
			var rows = tbody.querySelectorAll(".dash-table-row[data-clickable]");
			for (var i = 0; i < rows.length; i++) {
				rows[i].addEventListener("click", onRowActivate);
				rows[i].addEventListener("keydown", onRowKey);
			}
		}
		var retry = document.getElementById("scheduler-retry-btn");
		if (retry) retry.addEventListener("click", loadList);
	}

	function onRowActivate(e) {
		var id = e.currentTarget.getAttribute("data-job-id");
		if (id) ctx.navigate("#/scheduler/" + encodeURIComponent(id));
	}
	function onRowKey(e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onRowActivate(e); } }

	function loadList() {
		state.loading = true; state.listError = null;
		renderTableOnly();
		return ctx.api("GET", "/ui/api/scheduler").then(function (res) {
			state.loading = false;
			state.list = { jobs: res.jobs || [] };
			state.summary = res.summary || null;
			render();
		}).catch(function (err) {
			state.loading = false; state.listError = err;
			render();
			ctx.toast("error", "Failed to load scheduler", err.message || String(err));
		});
	}

	// ---- drawer lifecycle ----

	function openDrawer(mode) {
		if (!drawerRoot) {
			drawerFocusRestore = document.activeElement;
			drawerRoot = document.createElement("div");
			drawerRoot.setAttribute("data-scheduler-drawer", "true");
			document.body.appendChild(drawerRoot);
			prevBodyOverflow = document.body.style.overflow;
			document.body.style.overflow = "hidden";
		}
		if (mode === "create") renderCreateDrawer(); else renderDetailDrawer();
	}

	function closeDrawer(skipHash) {
		if (state.create.open && state.create.dirtyByUser) {
			if (!window.confirm("Discard this job draft?")) return;
		}
		state.create = makeCreateState();
		state.detail = { open: false, id: null, loading: false, error: null, job: null, audit: [], runResult: null, runPending: false };
		removeDrawerDom();
		if (!skipHash && (window.location.hash || "").indexOf("#/scheduler/") === 0) ctx.navigate("#/scheduler");
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

	function wireDrawerKeys() {
		if (drawerKeyHandler) document.removeEventListener("keydown", drawerKeyHandler, true);
		drawerKeyHandler = function (e) {
			if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeDrawer(false); return; }
			if (e.key === "Tab") handleTab(e);
		};
		document.addEventListener("keydown", drawerKeyHandler, true);
	}

	function getFocusable() {
		if (!drawerRoot) return [];
		var panel = drawerRoot.querySelector(".dash-drawer");
		if (!panel) return [];
		var nodes = panel.querySelectorAll('a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])');
		var out = [];
		for (var i = 0; i < nodes.length; i++) {
			if (nodes[i].offsetParent !== null || nodes[i] === document.activeElement) out.push(nodes[i]);
		}
		return out;
	}
	function handleTab(e) {
		var f = getFocusable();
		if (f.length === 0) {
			e.preventDefault();
			var p = drawerRoot && drawerRoot.querySelector(".dash-drawer");
			if (p) p.focus();
			return;
		}
		var first = f[0], last = f[f.length - 1];
		if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
		else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
	}
	function focusInDrawer(selector) {
		setTimeout(function () {
			if (!drawerRoot) return;
			var el = (selector && drawerRoot.querySelector(selector)) || drawerRoot.querySelector(".dash-drawer-close");
			if (el && typeof el.focus === "function") el.focus();
		}, 40);
	}

	// ---- detail drawer ----

	function renderDetailDrawer() {
		if (!drawerRoot) return;
		state.detail.open = true; state.create.open = false;
		var d = state.detail, job = d.job;
		var body = d.error
			? '<div class="dash-drawer-body"><div class="dash-drawer-error" role="alert">' +
				'<p style="margin:0 0 var(--space-2); font-weight:600;">Could not load job.</p>' +
				'<p style="margin:0 0 var(--space-3);">' + esc(d.error.message || String(d.error)) + '</p>' +
				'<button class="dash-btn dash-btn-ghost dash-btn-sm" id="scheduler-detail-retry">Retry</button></div></div>'
			: (!job || d.loading) ? renderDetailSkeleton() : renderDetailContent(job);

		var actions = "";
		if (job) {
			var isPaused = job.status === "paused";
			actions = '<div class="dash-sched-drawer-actions">' +
				(isPaused
					? '<button class="dash-btn dash-btn-ghost dash-btn-sm" id="scheduler-resume-btn">Resume</button>'
					: '<button class="dash-btn dash-btn-ghost dash-btn-sm" id="scheduler-pause-btn"' + (job.status !== "active" ? " disabled" : "") + '>Pause</button>') +
				'<button class="dash-btn dash-btn-ghost dash-btn-sm" id="scheduler-run-btn"' + (job.status !== "active" || d.runPending ? " disabled" : "") + '>' +
				(d.runPending ? '<span class="dash-sched-inline-spinner" aria-hidden="true"></span>Running' : "Run now") +
				'</button>' +
				'<button class="dash-btn dash-btn-danger dash-btn-sm" id="scheduler-delete-btn">Delete</button>' +
				'</div>';
		}

		drawerRoot.innerHTML = '<div class="dash-drawer-backdrop" data-drawer-backdrop="true" aria-hidden="true"></div>' +
			'<aside class="dash-drawer dash-sched-wide-drawer" role="dialog" aria-modal="true" aria-labelledby="scheduler-detail-title" tabindex="-1">' +
			'<header class="dash-drawer-header"><div class="dash-drawer-title-wrap">' +
			'<p class="dash-drawer-eyebrow">Scheduled job</p>' +
			'<h2 class="dash-drawer-title" id="scheduler-detail-title">' + esc(job ? job.name : (state.detail.id || "")) + '</h2>' +
			'<div class="dash-drawer-subtitle">' + (job ? '<span class="phantom-muted">' + esc(humanSchedule(job.schedule)) + '</span>' + statusChip(job.status) : "") + '</div>' +
			actions + '</div>' +
			'<button class="dash-drawer-close" type="button" aria-label="Close" id="scheduler-detail-close">' +
			'<svg fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg>' +
			'</button></header>' + body + '</aside>';

		wireDetailDrawer();
		wireDrawerKeys();
		if (!d.loading && job) focusInDrawer("#scheduler-detail-close");
	}

	function renderDetailSkeleton() {
		var pill = '<div class="dash-table-skeleton-pill"></div>';
		return '<div class="dash-drawer-body" aria-busy="true">' +
			'<section class="dash-drawer-section"><p class="dash-drawer-section-label">Overview</p>' +
			'<div class="dash-drawer-kv">' +
			'<span class="dash-drawer-kv-key">Schedule</span><span class="dash-drawer-kv-value" style="min-width:120px; height:14px;">' + pill + '</span>' +
			'<span class="dash-drawer-kv-key">Next run</span><span class="dash-drawer-kv-value" style="min-width:100px; height:14px;">' + pill + '</span>' +
			'<span class="dash-drawer-kv-key">Last run</span><span class="dash-drawer-kv-value" style="min-width:160px; height:14px;">' + pill + '</span>' +
			'<span class="dash-drawer-kv-key">Delivery</span><span class="dash-drawer-kv-value" style="min-width:120px; height:14px;">' + pill + '</span>' +
			'</div></section></div>';
	}

	function renderDetailContent(job) {
		var kv = [
			kvRow("Schedule", humanSchedule(job.schedule), "plain"),
			kvRow("Status", job.status, "plain"),
			kvRow("Enabled", job.enabled ? "yes" : "no", "plain"),
			kvRow("Created by", job.createdBy || "agent", "plain"),
			kvRow("Created", absoluteTime(job.createdAt), "plain"),
			kvRow("Next run", job.nextRunAt ? absoluteTime(job.nextRunAt) + " (" + relativeTime(job.nextRunAt) + ")" : "none", "plain"),
		];
		if (job.lastRunAt) {
			kv.push(kvRow("Last run", [absoluteTime(job.lastRunAt), job.lastRunStatus || "", job.lastRunDurationMs != null ? job.lastRunDurationMs + " ms" : "", job.lastDeliveryStatus || ""].filter(Boolean).join(" "), "plain"));
		} else {
			kv.push(kvRow("Last run", "never", "plain"));
		}
		kv.push(kvRow("Run count", String(job.runCount || 0), "plain"));
		kv.push(kvRow("Consecutive errors", String(job.consecutiveErrors || 0), "plain"));
		kv.push(kvRow("Delivery", deliverySummary(job.delivery), "plain"));
		if (job.deleteAfterRun) kv.push(kvRow("Delete after run", "yes", "plain"));

		var audit = state.detail.audit || [];
		var auditHtml;
		if (audit.length === 0) {
			auditHtml = '<section class="dash-drawer-section"><p class="dash-drawer-section-label">Recent actions</p><p class="phantom-muted" style="font-size:12px; margin:0;">No UI actions recorded for this job yet.</p></section>';
		} else {
			var rows = audit.map(function (a) {
				return '<div class="dash-sched-audit-row">' +
					'<span class="dash-sched-audit-action">' + esc(a.action) + '</span>' +
					'<span class="dash-sched-audit-actor">' + esc(a.actor || "") + '</span>' +
					'<span class="dash-sched-audit-detail" title="' + esc(a.detail || "") + '">' + esc(a.detail || "") + '</span>' +
					'<span class="dash-sched-audit-time" title="' + esc(absoluteTime(a.created_at)) + '">' + esc(relativeTime(a.created_at)) + '</span>' +
					'</div>';
			}).join("");
			auditHtml = '<section class="dash-drawer-section"><p class="dash-drawer-section-label">Recent actions (' + audit.length + ')</p><div class="dash-sched-audit-list">' + rows + '</div></section>';
		}

		var errorSection = job.lastRunError ? '<section class="dash-drawer-section"><p class="dash-drawer-section-label">Last error</p><div id="scheduler-last-error-mount"></div></section>' : "";
		var runSection = state.detail.runResult != null ? '<section class="dash-drawer-section"><p class="dash-drawer-section-label">Run-now result</p><div id="scheduler-run-result-mount"></div></section>' : "";

		setTimeout(function () {
			mountTextBlock("scheduler-task-mount", job.task || "", "dash-sched-code-block");
			if (job.lastRunError) mountTextBlock("scheduler-last-error-mount", job.lastRunError, "dash-sched-code-block");
			if (state.detail.runResult != null) mountTextBlock("scheduler-run-result-mount", state.detail.runResult, "dash-sched-run-result");
		}, 0);

		return '<div class="dash-drawer-body">' +
			'<section class="dash-drawer-section"><p class="dash-drawer-section-label">Overview</p><div class="dash-drawer-kv">' + kv.join("") + '</div></section>' +
			'<section class="dash-drawer-section"><p class="dash-drawer-section-label">Task prompt</p><div id="scheduler-task-mount"></div></section>' +
			errorSection + runSection + auditHtml +
			'</div>';
	}

	function mountTextBlock(id, text, cls) {
		var mount = document.getElementById(id);
		if (!mount) return;
		var pre = document.createElement("pre");
		pre.className = cls;
		pre.textContent = text;
		mount.innerHTML = "";
		mount.appendChild(pre);
	}

	function kvRow(key, value, variant) {
		var valClass = variant === "plain" ? " dash-drawer-kv-value-plain" : "";
		return '<span class="dash-drawer-kv-key">' + esc(key) + '</span><span class="dash-drawer-kv-value' + valClass + '">' + esc(value) + '</span>';
	}

	function wireDetailDrawer() {
		if (!drawerRoot) return;
		var close = drawerRoot.querySelector("#scheduler-detail-close");
		var bd = drawerRoot.querySelector("[data-drawer-backdrop]");
		if (close) close.addEventListener("click", function () { closeDrawer(false); });
		if (bd) bd.addEventListener("click", function () { closeDrawer(false); });
		var retry = drawerRoot.querySelector("#scheduler-detail-retry");
		if (retry) retry.addEventListener("click", function () { if (state.detail.id) loadDetail(state.detail.id); });
		bindAction("#scheduler-pause-btn", actPause);
		bindAction("#scheduler-resume-btn", actResume);
		bindAction("#scheduler-run-btn", actRun);
		bindAction("#scheduler-delete-btn", actDelete);
	}
	function bindAction(sel, fn) {
		var el = drawerRoot.querySelector(sel);
		if (el) el.addEventListener("click", fn);
	}

	function loadDetail(id) {
		state.detail.open = true; state.detail.id = id; state.detail.loading = true;
		state.detail.error = null; state.detail.job = null; state.detail.audit = []; state.detail.runResult = null;
		renderDetailDrawer();
		return Promise.all([
			ctx.api("GET", "/ui/api/scheduler/" + encodeURIComponent(id)),
			ctx.api("GET", "/ui/api/scheduler/" + encodeURIComponent(id) + "/audit?limit=20").catch(function () { return { entries: [] }; }),
		]).then(function (vals) {
			if (state.detail.id !== id) return;
			state.detail.loading = false;
			state.detail.job = vals[0].job;
			state.detail.audit = vals[1].entries || [];
			renderDetailDrawer();
		}).catch(function (err) {
			if (state.detail.id !== id) return;
			state.detail.loading = false; state.detail.error = err;
			renderDetailDrawer();
			ctx.toast("error", err.status === 404 ? "Job not found" : "Failed to load job", err.message || String(err));
		});
	}

	function simpleAction(path, successTitle, errorTitle) {
		var id = state.detail.id;
		if (!id) return;
		ctx.api("POST", "/ui/api/scheduler/" + encodeURIComponent(id) + "/" + path).then(function (res) {
			state.detail.job = res.job;
			patchListJob(res.job);
			renderDetailDrawer();
			ctx.toast("success", successTitle, res.job.name);
		}).catch(function (err) { ctx.toast("error", errorTitle, err.message || String(err)); });
	}
	function actPause() { simpleAction("pause", "Job paused", "Could not pause job"); }
	function actResume() { simpleAction("resume", "Job resumed", "Could not resume job"); }

	function actRun() {
		var id = state.detail.id; if (!id) return;
		state.detail.runPending = true; state.detail.runResult = null;
		renderDetailDrawer();
		ctx.api("POST", "/ui/api/scheduler/" + encodeURIComponent(id) + "/run").then(function (res) {
			state.detail.runPending = false;
			state.detail.runResult = res.result || "";
			if (res.job) { state.detail.job = res.job; patchListJob(res.job); }
			renderDetailDrawer();
			ctx.toast("success", "Job ran", "Result captured in drawer.");
		}).catch(function (err) {
			state.detail.runPending = false;
			renderDetailDrawer();
			ctx.toast("error", "Run failed", err.message || String(err));
		});
	}

	function actDelete() {
		var id = state.detail.id, job = state.detail.job;
		if (!id) return;
		ctx.openModal({
			title: "Delete scheduled job?",
			body: 'This removes "' + (job ? job.name : id) + '" immediately. The job will not fire again.',
			actions: [
				{ label: "Cancel", className: "dash-btn-ghost" },
				{ label: "Delete", className: "dash-btn-danger",
					onClick: function () {
						return ctx.api("DELETE", "/ui/api/scheduler/" + encodeURIComponent(id)).then(function () {
							ctx.toast("success", "Job deleted", job ? job.name : id);
							removeListJob(id);
							closeDrawer(false);
						}).catch(function (err) {
							ctx.toast("error", "Could not delete", err.message || String(err));
							return false;
						});
					} },
			],
		});
	}

	function patchListJob(job) {
		if (!state.list || !Array.isArray(state.list.jobs)) return;
		for (var i = 0; i < state.list.jobs.length; i++) {
			if (state.list.jobs[i].id === job.id) { state.list.jobs[i] = job; render(); return; }
		}
	}
	function removeListJob(id) {
		if (!state.list || !Array.isArray(state.list.jobs)) return;
		state.list.jobs = state.list.jobs.filter(function (j) { return j.id !== id; });
		render();
	}

	// ---- create drawer ----

	function renderCreateDrawer() {
		state.create.open = true; state.detail.open = false;
		drawerRoot.innerHTML = '<div class="dash-drawer-backdrop" data-drawer-backdrop="true" aria-hidden="true"></div>' +
			'<aside class="dash-drawer dash-sched-wide-drawer" role="dialog" aria-modal="true" aria-labelledby="scheduler-create-title" tabindex="-1">' +
			'<header class="dash-drawer-header"><div class="dash-drawer-title-wrap">' +
			'<p class="dash-drawer-eyebrow">New scheduled job</p>' +
			'<h2 class="dash-drawer-title" id="scheduler-create-title">Schedule a job</h2>' +
			'<div class="dash-drawer-subtitle"><span class="phantom-muted">Fill the form or describe it in plain English below.</span></div>' +
			'</div>' +
			'<button class="dash-drawer-close" type="button" aria-label="Close" id="scheduler-create-close">' +
			'<svg fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg>' +
			'</button></header>' +
			'<div class="dash-drawer-body">' +
			renderDescribe() + renderTemplates() +
			(state.create.submitError ? '<div class="dash-alert dash-alert-error" role="alert">' + esc(state.create.submitError) + '</div>' : "") +
			renderCreateForm() +
			'</div>' +
			'<footer class="dash-drawer-footer">' +
			'<button class="dash-btn dash-btn-ghost" id="scheduler-cancel-btn">Cancel</button>' +
			'<div style="flex:1;"></div>' +
			'<button class="dash-btn dash-btn-primary" id="scheduler-save-btn"' + (isCreateValid() && !state.create.submitting ? "" : " disabled") + '>' +
			(state.create.submitting ? '<span class="dash-sched-inline-spinner" aria-hidden="true"></span>Saving' : "Save job") +
			'</button></footer></aside>';
		wireCreateDrawer();
		wireDrawerKeys();
		focusInDrawer("#scheduler-describe-text");
		schedulePreview();
	}

	function renderDescribe() {
		var c = state.create;
		var count = c.describeText.length, over = count > DESCRIBE_MAX;
		var banner = c.describeFilled
			? '<div class="dash-sched-describe-filled-banner" role="status"><span>Filled from your description. Review and edit before saving.</span><button type="button" class="dash-sched-template-clear" id="scheduler-describe-dismiss">Dismiss</button></div>'
			: "";
		var err = c.describeError ? '<div class="dash-sched-describe-error" role="alert">' + esc(c.describeError) + '</div>' : "";
		var disableFill = !c.describeText.trim() || c.describePending || over;
		return '<section class="dash-sched-describe">' +
			'<div class="dash-sched-describe-header">' +
			'<p class="dash-sched-describe-eyebrow">Describe assist</p>' +
			'<span class="dash-sched-char-count' + (over ? ' dash-sched-char-count-over' : '') + '">' + esc(count + " / " + DESCRIBE_MAX) + '</span>' +
			'</div>' +
			'<p class="dash-sched-describe-title">Describe your job in plain English (optional)</p>' +
			'<textarea class="dash-textarea" id="scheduler-describe-text" rows="3" placeholder="pull the top HN stories every 6 hours and post a summary to my Slack DM" aria-label="Describe your job in plain English">' + esc(c.describeText) + '</textarea>' +
			'<div class="dash-sched-describe-actions">' +
			'<button type="button" class="dash-btn dash-btn-ghost dash-btn-sm" id="scheduler-describe-fill"' + (disableFill ? " disabled" : "") + '>' +
			(c.describePending ? '<span class="dash-sched-inline-spinner" aria-hidden="true"></span>Filling' : "Fill form from description") +
			'</button>' +
			'<span class="phantom-muted" style="font-size:11px;">Sonnet proposes fields. You review and edit before saving.</span>' +
			'</div>' + err + banner + '</section>';
	}

	function renderTemplates() {
		var pills = TEMPLATES.map(function (t) {
			var pressed = state.create.appliedTemplate === t.id ? 'aria-pressed="true" ' : 'aria-pressed="false" ';
			return '<button type="button" class="dash-sched-template-pill" ' + pressed + 'data-template-id="' + esc(t.id) + '" title="' + esc(t.description) + '">' + esc(t.label) + '</button>';
		}).join("");
		var clearBtn = state.create.appliedTemplate ? '<button type="button" class="dash-sched-template-clear" id="scheduler-template-clear">Clear template</button>' : "";
		return '<section class="dash-drawer-section"><p class="dash-drawer-section-label">Templates</p>' +
			'<div class="dash-sched-template-row" role="group" aria-label="Job templates">' + pills + clearBtn + '</div></section>';
	}

	function renderCreateForm() {
		var f = state.create.form, e = state.create.errors;
		var taskBytes = new Blob([f.task]).size, taskOver = taskBytes > TASK_MAX;
		return '<section class="dash-drawer-section">' +
			'<p class="dash-drawer-section-label">Basics</p>' +
			'<div class="dash-form">' +
			field("scheduler-name", "Name",
				'<input type="text" class="dash-input" id="scheduler-name" maxlength="' + NAME_MAX + '" value="' + esc(f.name) + '" placeholder="hn-digest" aria-invalid="' + (e.name ? "true" : "false") + '">' +
				(e.name ? fieldError(e.name) : '<p class="dash-field-hint">Lowercase, kebab-case. Must be unique.</p>')) +
			field("scheduler-description", "Description",
				'<input type="text" class="dash-input" id="scheduler-description" maxlength="' + DESCRIPTION_MAX + '" value="' + esc(f.description) + '" placeholder="Top Hacker News stories every 6 hours">' +
				'<p class="dash-field-hint">One-sentence summary, optional.</p>') +
			field("scheduler-task", "Task prompt",
				'<textarea class="dash-textarea" id="scheduler-task" rows="6" aria-invalid="' + (e.task || taskOver ? "true" : "false") + '" placeholder="Fetch the top 10 Hacker News stories and post a summary to Slack.">' + esc(f.task) + '</textarea>' +
				'<div class="dash-sched-char-count' + (taskOver ? ' dash-sched-char-count-over' : '') + '">' + formatBytes(taskBytes) + ' / 32 KB</div>' +
				(e.task ? fieldError(e.task) : '<p class="dash-field-hint">The prompt the agent runs when the job fires. Include every bit of context it needs.</p>')) +
			'</div></section>' +

			'<section class="dash-drawer-section"><p class="dash-drawer-section-label">Schedule</p>' +
			renderKindTabs(f.schedule.kind) + renderKindControls(f.schedule) + renderPreview() + '</section>' +

			'<section class="dash-drawer-section"><p class="dash-drawer-section-label">Delivery</p>' + renderDelivery(f.delivery) + '</section>' +

			'<section class="dash-drawer-section"><p class="dash-drawer-section-label">Options</p>' +
			'<label class="dash-toggle"><input type="checkbox" id="scheduler-enabled"' + (f.enabled ? " checked" : "") + '><span class="dash-toggle-track" aria-hidden="true"></span><span>Enabled</span></label>' +
			(f.schedule.kind === "once" ? '<label class="dash-toggle"><input type="checkbox" id="scheduler-delete-after"' + (f.deleteAfterRun ? " checked" : "") + '><span class="dash-toggle-track" aria-hidden="true"></span><span>Delete after single run</span></label>' : "") +
			'</section>';
	}

	function field(id, label, contents) {
		return '<div class="dash-field"><label class="dash-field-label" for="' + esc(id) + '">' + esc(label) + '</label>' + contents + '</div>';
	}
	function fieldError(msg) {
		return '<p class="dash-field-hint" role="alert" style="color:var(--color-error);">' + esc(msg) + '</p>';
	}

	function renderKindTabs(kind) {
		var kinds = [{ id: "every", label: "Every interval" }, { id: "daily", label: "Daily time" }, { id: "cron", label: "Cron expression" }, { id: "once", label: "Once" }];
		return '<div class="dash-segmented" role="tablist" aria-label="Schedule kind">' +
			kinds.map(function (k) {
				return '<button type="button" data-schedule-kind="' + esc(k.id) + '" aria-pressed="' + (kind === k.id ? "true" : "false") + '">' + esc(k.label) + '</button>';
			}).join("") + '</div>';
	}

	function renderKindControls(s) {
		var err = state.create.errors.schedule;
		var errNode = err ? fieldError(err) : "";
		if (s.kind === "every") {
			return '<div class="dash-sched-field-row">' +
				field("scheduler-every-value", "Interval",
					'<input type="number" min="1" max="1440" class="dash-input" id="scheduler-every-value" value="' + esc(String(s.value || 1)) + '">') +
				field("scheduler-every-unit", "Unit",
					'<select class="dash-select" id="scheduler-every-unit">' +
					["minutes", "hours", "days"].map(function (u) { return '<option value="' + u + '"' + (s.unit === u ? " selected" : "") + '>' + u + '</option>'; }).join("") +
					'</select>') + '</div>' + errNode;
		}
		if (s.kind === "daily") {
			var hhmm = s.expr && /^\d+ \d+/.test(s.expr) ? cronToHhMm(s.expr) : (s.at || "09:00");
			return '<div class="dash-sched-field-row">' +
				field("scheduler-daily-time", "Time", '<input type="time" class="dash-input" id="scheduler-daily-time" value="' + esc(hhmm) + '">') +
				field("scheduler-daily-tz", "Timezone", tzSelect("scheduler-daily-tz", s.tz)) +
				'</div>' + errNode;
		}
		if (s.kind === "cron") {
			var exChips = CRON_EXAMPLES.map(function (ex) { return '<button type="button" class="dash-sched-example-chip" data-cron-example="' + esc(ex) + '">' + esc(ex) + '</button>'; }).join("");
			return '<div class="dash-sched-field-row">' +
				field("scheduler-cron-expr", "Expression", '<input type="text" class="dash-input" id="scheduler-cron-expr" value="' + esc(s.expr || "") + '" placeholder="0 9 * * 1-5" spellcheck="false">') +
				field("scheduler-cron-tz", "Timezone", tzSelect("scheduler-cron-tz", s.tz)) +
				'</div>' +
				'<p class="dash-field-hint">5-field cron: minute hour day-of-month month day-of-week. No @nicknames.</p>' +
				'<div class="dash-sched-examples">' + exChips + '</div>' + errNode;
		}
		return '<div class="dash-sched-field-row">' +
			field("scheduler-once-at", "Date and time", '<input type="datetime-local" class="dash-input" id="scheduler-once-at" value="' + esc(s.at || "") + '">') +
			field("scheduler-once-tz", "Timezone", tzSelect("scheduler-once-tz", s.tz)) +
			'</div>' + errNode;
	}

	function tzSelect(id, current) {
		var tz = current || defaultTz();
		var opts = TZ_OPTIONS.slice();
		if (opts.indexOf(tz) < 0) opts.unshift(tz);
		return '<select class="dash-select" id="' + esc(id) + '">' +
			opts.map(function (o) { return '<option value="' + esc(o) + '"' + (o === tz ? " selected" : "") + '>' + esc(o) + '</option>'; }).join("") +
			'</select>';
	}

	function renderPreview() {
		var c = state.create, body;
		if (c.previewPending) body = '<span class="dash-sched-inline-spinner" aria-hidden="true"></span><span>Computing next run...</span>';
		else if (c.previewError) return '<div class="dash-sched-preview dash-sched-preview-error" role="status"><span class="dash-sched-preview-label">Preview error:</span><span>' + esc(c.previewError) + '</span></div>';
		else if (c.preview && c.preview.nextRunAt) {
			var human = c.preview.humanReadable ? " (" + c.preview.humanReadable + ")" : "";
			body = '<span class="dash-sched-preview-label">Next run:</span><span>' + esc(absoluteTime(c.preview.nextRunAt)) + '</span><span class="phantom-muted">' + esc(relativeTime(c.preview.nextRunAt) + human) + '</span>';
		} else if (c.preview && c.preview.humanReadable) {
			body = '<span class="dash-sched-preview-label">Next run:</span><span>' + esc(c.preview.humanReadable) + '</span>';
		} else {
			body = '<span class="phantom-muted">Fill the schedule to preview the next run.</span>';
		}
		return '<div class="dash-sched-preview" role="status">' + body + '</div>';
	}

	function renderDelivery(d) {
		var radios = [
			{ value: "owner", label: "Owner (you, via DM)" },
			{ value: "channel", label: "Slack channel id (starts with C...)" },
			{ value: "user", label: "Slack user id (starts with U...)" },
		];
		var kind = d.targetKind || "owner", err = state.create.errors.delivery;
		var targetInput = kind !== "owner"
			? '<input type="text" class="dash-input" id="scheduler-delivery-target" value="' + esc(d.target || "") + '" placeholder="' + esc(kind === "channel" ? "C04ABC123" : "U04ABC123") + '">'
			: "";
		return field("scheduler-delivery-channel", "Channel",
			'<select class="dash-select" id="scheduler-delivery-channel"><option value="slack"' + (d.channel === "slack" ? " selected" : "") + '>Slack</option><option value="none"' + (d.channel === "none" ? " selected" : "") + '>None (silent)</option></select>') +
			(d.channel === "slack"
				? '<div class="dash-sched-radio-group" role="radiogroup" aria-label="Target">' +
					radios.map(function (r) {
						return '<label class="dash-sched-radio"><input type="radio" name="scheduler-delivery-target-kind" value="' + esc(r.value) + '"' + (kind === r.value ? " checked" : "") + '><span>' + esc(r.label) + '</span></label>';
					}).join("") + '</div>' +
					(targetInput ? '<div class="dash-field">' + targetInput + (err ? fieldError(err) : "") + '</div>' : "")
				: '<p class="dash-field-hint">No Slack message. Useful for quiet maintenance tasks.</p>');
	}

	// ---- wiring ----

	function wireCreateDrawer() {
		if (!drawerRoot) return;
		bindClick("#scheduler-create-close", function () { closeDrawer(false); });
		bindClick("[data-drawer-backdrop]", function () { closeDrawer(false); });
		bindClick("#scheduler-cancel-btn", function () { closeDrawer(false); });
		bindClick("#scheduler-save-btn", submitCreate);
		wireDescribeInputs();
		wireTemplateInputs();
		wireFormInputs();
	}
	function bindClick(sel, fn) {
		var el = drawerRoot.querySelector(sel);
		if (el) el.addEventListener("click", fn);
	}

	function wireDescribeInputs() {
		var text = drawerRoot.querySelector("#scheduler-describe-text");
		if (text) text.addEventListener("input", function () {
			state.create.describeText = text.value;
			var over = text.value.length > DESCRIBE_MAX;
			var fillBtn = drawerRoot.querySelector("#scheduler-describe-fill");
			if (fillBtn) fillBtn.disabled = text.value.trim().length === 0 || state.create.describePending || over;
			var countEl = drawerRoot.querySelector(".dash-sched-describe .dash-sched-char-count");
			if (countEl) {
				countEl.textContent = text.value.length + " / " + DESCRIBE_MAX;
				countEl.classList.toggle("dash-sched-char-count-over", over);
			}
		});
		bindClick("#scheduler-describe-fill", fillFromDescription);
		bindClick("#scheduler-describe-dismiss", function () { state.create.describeFilled = false; renderCreateDrawer(); });
	}

	function wireTemplateInputs() {
		var pills = drawerRoot.querySelectorAll(".dash-sched-template-pill");
		for (var i = 0; i < pills.length; i++) {
			pills[i].addEventListener("click", function (e) { applyTemplate(e.currentTarget.getAttribute("data-template-id")); });
		}
		bindClick("#scheduler-template-clear", function () {
			state.create.appliedTemplate = null;
			state.create.form = defaultForm();
			state.create.dirtyByUser = false;
			renderCreateDrawer();
			schedulePreview();
		});
	}

	function wireFormInputs() {
		bindInput("#scheduler-name", function (v) { state.create.form.name = v; markDirty(); validateField("name"); });
		bindInput("#scheduler-description", function (v) { state.create.form.description = v; markDirty(); });
		bindInput("#scheduler-task", function (v) {
			state.create.form.task = v; markDirty(); validateField("task"); updateTaskCount(); updateSaveButton();
		});

		var kindTabs = drawerRoot.querySelectorAll("[data-schedule-kind]");
		for (var i = 0; i < kindTabs.length; i++) {
			kindTabs[i].addEventListener("click", function (e) { setScheduleKind(e.currentTarget.getAttribute("data-schedule-kind")); });
		}
		wireScheduleInputs();
		wireDeliveryInputs();

		bindChange("#scheduler-enabled", function (el) { state.create.form.enabled = el.checked; markDirty(); });
		bindChange("#scheduler-delete-after", function (el) { state.create.form.deleteAfterRun = el.checked; markDirty(); });
	}

	function bindInput(sel, fn) {
		var el = drawerRoot.querySelector(sel);
		if (el) el.addEventListener("input", function () { fn(el.value); });
	}
	function bindChange(sel, fn) {
		var el = drawerRoot.querySelector(sel);
		if (el) el.addEventListener("change", function () { fn(el); });
	}

	function wireScheduleInputs() {
		bindInput("#scheduler-every-value", function (v) {
			var n = Number(v);
			state.create.form.schedule.value = isFinite(n) && n > 0 ? n : 1;
			markDirty(); schedulePreview();
		});
		bindChange("#scheduler-every-unit", function (el) { state.create.form.schedule.unit = el.value; markDirty(); schedulePreview(); });
		bindInput("#scheduler-daily-time", function (v) {
			var parts = v.split(":");
			if (parts.length === 2) {
				state.create.form.schedule.expr = Number(parts[1]) + " " + Number(parts[0]) + " * * *";
				state.create.form.schedule.at = v;
			}
			markDirty(); schedulePreview();
		});
		bindChange("#scheduler-daily-tz", function (el) { state.create.form.schedule.tz = el.value; markDirty(); schedulePreview(); });
		bindInput("#scheduler-cron-expr", function (v) { state.create.form.schedule.expr = v; markDirty(); schedulePreview(); });
		bindChange("#scheduler-cron-tz", function (el) { state.create.form.schedule.tz = el.value; markDirty(); schedulePreview(); });
		var chips = drawerRoot.querySelectorAll(".dash-sched-example-chip");
		for (var i = 0; i < chips.length; i++) {
			chips[i].addEventListener("click", function (e) {
				var ex = e.currentTarget.getAttribute("data-cron-example");
				state.create.form.schedule.expr = ex;
				var eEl = drawerRoot.querySelector("#scheduler-cron-expr");
				if (eEl) eEl.value = ex;
				markDirty(); schedulePreview();
			});
		}
		bindInput("#scheduler-once-at", function (v) { state.create.form.schedule.at = v; markDirty(); schedulePreview(); });
		bindChange("#scheduler-once-tz", function (el) { state.create.form.schedule.tz = el.value; markDirty(); schedulePreview(); });
	}

	function wireDeliveryInputs() {
		bindChange("#scheduler-delivery-channel", function (el) {
			state.create.form.delivery.channel = el.value;
			if (el.value === "none") state.create.form.delivery.targetKind = "owner";
			markDirty();
			renderCreateDrawer();
		});
		var radios = drawerRoot.querySelectorAll('input[name="scheduler-delivery-target-kind"]');
		for (var i = 0; i < radios.length; i++) {
			radios[i].addEventListener("change", function (e) {
				state.create.form.delivery.targetKind = e.currentTarget.value;
				if (e.currentTarget.value === "owner") state.create.form.delivery.target = "";
				markDirty();
				renderCreateDrawer();
			});
		}
		bindInput("#scheduler-delivery-target", function (v) { state.create.form.delivery.target = v; markDirty(); validateField("delivery"); });
	}

	function setScheduleKind(kind) {
		if (state.create.form.schedule.kind === kind) return;
		state.create.form.schedule.kind = kind;
		if (kind === "once") state.create.form.deleteAfterRun = true;
		markDirty();
		renderCreateDrawer();
		schedulePreview();
	}

	function markDirty() { state.create.dirtyByUser = true; updateSaveButton(); }

	function updateSaveButton() {
		if (!drawerRoot) return;
		var btn = drawerRoot.querySelector("#scheduler-save-btn");
		if (btn) btn.disabled = state.create.submitting || !isCreateValid();
	}

	function updateTaskCount() {
		if (!drawerRoot) return;
		var el = drawerRoot.querySelector("#scheduler-task");
		if (!el) return;
		var bytes = new Blob([el.value]).size;
		var countEl = el.parentNode.querySelector(".dash-sched-char-count");
		if (countEl) {
			countEl.textContent = formatBytes(bytes) + " / 32 KB";
			countEl.classList.toggle("dash-sched-char-count-over", bytes > TASK_MAX);
		}
	}

	// ---- templates ----

	function applyTemplate(tid) {
		var t = null;
		for (var i = 0; i < TEMPLATES.length; i++) if (TEMPLATES[i].id === tid) { t = TEMPLATES[i]; break; }
		if (!t) return;
		var v = t.values, f = defaultForm();
		f.name = v.name; f.description = v.description || ""; f.task = v.task || "";
		f.enabled = v.enabled !== false;
		// Templates ship "every", "cron", or "at" only. UI-only "daily" never
		// appears in template values; it's exposed in the manual editor and
		// translated to cron at submit.
		if (v.schedule.kind === "every") { f.schedule.kind = "every"; f.schedule.unit = v.schedule.unit || "hours"; f.schedule.value = v.schedule.value || 1; }
		else if (v.schedule.kind === "cron") { f.schedule.kind = "cron"; f.schedule.expr = v.schedule.expr; f.schedule.tz = v.schedule.tz || defaultTz(); }
		else if (v.schedule.kind === "at") { f.schedule.kind = "once"; f.schedule.at = v.schedule.at || ""; f.schedule.tz = v.schedule.tz || defaultTz(); }
		if (v.delivery) { f.delivery.channel = v.delivery.channel || "slack"; f.delivery.targetKind = v.delivery.targetKind || "owner"; f.delivery.target = v.delivery.target || ""; }

		state.create.appliedTemplate = tid;
		state.create.form = f;
		state.create.dirtyByUser = false;
		state.create.errors = {};
		state.create.submitError = null;
		renderCreateDrawer();
		schedulePreview();
	}

	// ---- describe assist ----

	function fillFromDescription() {
		var desc = state.create.describeText.trim();
		if (!desc || desc.length > DESCRIBE_MAX) return;
		state.create.describePending = true;
		state.create.describeError = null;
		renderCreateDrawer();
		ctx.api("POST", "/ui/api/scheduler/parse", { description: desc }).then(function (res) {
			state.create.describePending = false;
			applyProposal(res.proposal);
			state.create.describeFilled = true;
			renderCreateDrawer();
			focusInDrawer("#scheduler-name");
			schedulePreview();
		}).catch(function (err) {
			state.create.describePending = false;
			state.create.describeError = err.message || "Could not parse description, please fill the form manually.";
			renderCreateDrawer();
		});
	}

	function applyProposal(p) {
		if (!p || typeof p !== "object") return;
		var f = defaultForm();
		if (typeof p.name === "string") f.name = p.name;
		if (typeof p.description === "string") f.description = p.description;
		if (typeof p.task === "string") f.task = p.task;
		if (p.schedule && typeof p.schedule === "object") {
			if (p.schedule.kind === "every") {
				f.schedule.kind = "every";
				var ms = Number(p.schedule.intervalMs) || 3_600_000;
				if (ms % 86_400_000 === 0) { f.schedule.unit = "days"; f.schedule.value = ms / 86_400_000; }
				else if (ms % 3_600_000 === 0) { f.schedule.unit = "hours"; f.schedule.value = ms / 3_600_000; }
				else { f.schedule.unit = "minutes"; f.schedule.value = Math.max(1, Math.round(ms / 60_000)); }
			} else if (p.schedule.kind === "cron") {
				var expr = String(p.schedule.expr || "");
				var parts = expr.trim().split(/\s+/);
				var isDaily = parts.length === 5 && parts[2] === "*" && parts[3] === "*" && parts[4] === "*";
				f.schedule.kind = isDaily ? "daily" : "cron";
				f.schedule.expr = expr;
				if (isDaily) f.schedule.at = cronToHhMm(expr);
				if (p.schedule.tz) f.schedule.tz = String(p.schedule.tz);
			} else if (p.schedule.kind === "at") {
				f.schedule.kind = "once";
				var iso = String(p.schedule.at || "");
				f.schedule.at = iso ? iso.slice(0, 16) : "";
			}
		}
		if (p.delivery && typeof p.delivery === "object") {
			f.delivery.channel = p.delivery.channel === "none" ? "none" : "slack";
			var t = String(p.delivery.target || "owner");
			if (t === "owner") f.delivery.targetKind = "owner";
			else if (/^C[A-Z0-9]+$/.test(t)) { f.delivery.targetKind = "channel"; f.delivery.target = t; }
			else if (/^U[A-Z0-9]+$/.test(t)) { f.delivery.targetKind = "user"; f.delivery.target = t; }
		}
		state.create.form = f;
		state.create.dirtyByUser = false;
		state.create.errors = {};
		state.create.submitError = null;
	}

	// ---- validation + submit ----

	function validateField(fld) {
		var errors = state.create.errors, f = state.create.form;
		if (fld === "name") {
			delete errors.name;
			if (!f.name.trim()) errors.name = "Name is required.";
			else if (f.name.length > NAME_MAX) errors.name = "Name exceeds " + NAME_MAX + " characters.";
			else {
				var jobs = (state.list && state.list.jobs) || [];
				for (var i = 0; i < jobs.length; i++) {
					if (jobs[i].name.toLowerCase() === f.name.toLowerCase()) { errors.name = 'A job named "' + f.name + '" already exists.'; break; }
				}
			}
		}
		if (fld === "task") {
			delete errors.task;
			if (!f.task.trim()) errors.task = "Task prompt is required.";
			else if (new Blob([f.task]).size > TASK_MAX) errors.task = "Task prompt exceeds 32 KB.";
		}
		if (fld === "delivery") {
			delete errors.delivery;
			if (f.delivery.channel === "slack") {
				if (f.delivery.targetKind === "channel" && !/^C[A-Z0-9]+$/.test(f.delivery.target)) errors.delivery = "Channel id must start with C and use capital letters and digits.";
				if (f.delivery.targetKind === "user" && !/^U[A-Z0-9]+$/.test(f.delivery.target)) errors.delivery = "User id must start with U and use capital letters and digits.";
			}
		}
		updateSaveButton();
	}

	function validateAll() {
		validateField("name"); validateField("task"); validateField("delivery");
		if (state.create.previewError) state.create.errors.schedule = state.create.previewError;
		else delete state.create.errors.schedule;
	}

	function isCreateValid() {
		var f = state.create.form;
		if (!f.name.trim() || !f.task.trim()) return false;
		if (new Blob([f.task]).size > TASK_MAX) return false;
		if (state.create.previewError) return false;
		var e = state.create.errors;
		if (e.name || e.task || e.delivery) return false;
		if (f.delivery.channel === "slack" && f.delivery.targetKind !== "owner" && !f.delivery.target.trim()) return false;
		if (f.schedule.kind === "cron" && !f.schedule.expr.trim()) return false;
		if (f.schedule.kind === "once" && !f.schedule.at.trim()) return false;
		if (f.schedule.kind === "daily" && !(f.schedule.expr || f.schedule.at)) return false;
		return true;
	}

	function schedulePreview() {
		if (previewTimer) clearTimeout(previewTimer);
		var payload = buildServerSchedule(state.create.form.schedule);
		if (!payload) {
			state.create.preview = null; state.create.previewError = null;
			updatePreviewNode();
			return;
		}
		state.create.previewPending = true;
		updatePreviewNode();
		previewTimer = setTimeout(function () {
			ctx.api("POST", "/ui/api/scheduler/preview", { schedule: payload }).then(function (res) {
				state.create.previewPending = false;
				state.create.preview = { nextRunAt: res.nextRunAt, humanReadable: res.humanReadable };
				state.create.previewError = res.error || null;
				updatePreviewNode();
				updateSaveButton();
			}).catch(function (err) {
				state.create.previewPending = false;
				state.create.preview = null;
				state.create.previewError = err.message || "Could not preview schedule.";
				updatePreviewNode();
				updateSaveButton();
			});
		}, PREVIEW_DEBOUNCE_MS);
	}

	function updatePreviewNode() {
		if (!drawerRoot) return;
		var node = drawerRoot.querySelector(".dash-sched-preview");
		if (!node) return;
		var temp = document.createElement("div");
		temp.innerHTML = renderPreview();
		if (temp.firstChild) node.parentNode.replaceChild(temp.firstChild, node);
	}

	function buildServerSchedule(s) {
		if (s.kind === "every") {
			var v = Number(s.value) || 0;
			if (v <= 0) return null;
			var mult = s.unit === "minutes" ? 60_000 : s.unit === "days" ? 86_400_000 : 3_600_000;
			return { kind: "every", intervalMs: v * mult };
		}
		if (s.kind === "daily") {
			var hhmm = s.at || (/^\d+ \d+/.test(s.expr || "") ? cronToHhMm(s.expr) : "");
			if (!/^\d{1,2}:\d{2}$/.test(hhmm || "")) return null;
			var parts = hhmm.split(":");
			return { kind: "cron", expr: Number(parts[1]) + " " + Number(parts[0]) + " * * *", tz: s.tz || defaultTz() };
		}
		if (s.kind === "cron") {
			if (!s.expr || !s.expr.trim()) return null;
			var out = { kind: "cron", expr: s.expr.trim() };
			if (s.tz) out.tz = s.tz;
			return out;
		}
		if (s.kind === "once") {
			if (!s.at) return null;
			var iso = toIsoWithOffset(s.at);
			return iso ? { kind: "at", at: iso } : null;
		}
		return null;
	}

	// datetime-local yields "YYYY-MM-DDTHH:mm". Backend rejects bare-local;
	// we emit the viewer's current offset for the chosen instant. If the
	// operator picked a tz different from the viewer's system tz the
	// timestamp still parses, but the interpretation uses the viewer's
	// offset. Tradeoff noted in the spec.
	function toIsoWithOffset(localDt) {
		var d = new Date(localDt);
		if (isNaN(d.getTime())) return null;
		var offsetMin = -d.getTimezoneOffset();
		var sign = offsetMin >= 0 ? "+" : "-";
		var abs = Math.abs(offsetMin);
		return localDt + ":00" + sign + String(Math.floor(abs / 60)).padStart(2, "0") + ":" + String(abs % 60).padStart(2, "0");
	}

	function submitCreate() {
		validateAll();
		if (!isCreateValid()) { updateSaveButton(); return; }
		var f = state.create.form;
		var payload = {
			name: f.name.trim(),
			task: f.task,
			schedule: buildServerSchedule(f.schedule),
			enabled: f.enabled !== false,
			createdBy: "user",
		};
		if (f.description.trim()) payload.description = f.description.trim();
		if (f.delivery.channel === "none") payload.delivery = { channel: "none", target: "none" };
		else if (f.delivery.targetKind === "owner") payload.delivery = { channel: "slack", target: "owner" };
		else payload.delivery = { channel: "slack", target: f.delivery.target.trim() };
		if (f.schedule.kind === "once") payload.deleteAfterRun = f.deleteAfterRun;

		state.create.submitting = true;
		state.create.submitError = null;
		updateSaveButton();
		ctx.api("POST", "/ui/api/scheduler", payload).then(function (res) {
			state.create.submitting = false;
			ctx.toast("success", "Job scheduled", res.job.name);
			if (!state.list) state.list = { jobs: [] };
			state.list.jobs.unshift(res.job);
			state.create = makeCreateState();
			render();
			closeDrawer(true);
			ctx.navigate("#/scheduler/" + encodeURIComponent(res.job.id));
		}).catch(function (err) {
			state.create.submitting = false;
			state.create.submitError = err.message || "Could not save job.";
			renderCreateDrawer();
			ctx.toast("error", "Could not save", err.message || String(err));
		});
	}

	// ---- global keys + mount ----

	function installGlobalKeys() {
		if (documentKeyHandler) return;
		documentKeyHandler = function (e) {
			if (e.key !== "/") return;
			var tag = (document.activeElement && document.activeElement.tagName) || "";
			if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
			if (e.metaKey || e.ctrlKey || e.altKey) return;
			if ((window.location.hash || "").indexOf("#/scheduler") !== 0) return;
			var search = document.getElementById("scheduler-filter-q");
			if (search) { e.preventDefault(); search.focus(); search.select(); }
		};
		document.addEventListener("keydown", documentKeyHandler);
	}

	function mount(container, arg, dashCtx) {
		ctx = dashCtx; root = container;
		ctx.setBreadcrumb("Scheduler");
		installGlobalKeys();

		if (!dirtyRegistered) {
			ctx.registerDirtyChecker(function () { return state.create.dirtyByUser; });
			dirtyRegistered = true;
		}

		render();

		return loadList().then(function () {
			if (arg === "new") openDrawer("create");
			else if (arg) { openDrawer("detail"); loadDetail(arg); }
			else if (drawerRoot) closeDrawer(true);
		});
	}

	if (window.PhantomDashboard && window.PhantomDashboard.registerRoute) {
		window.PhantomDashboard.registerRoute("scheduler", { mount: mount });
	}
})();
