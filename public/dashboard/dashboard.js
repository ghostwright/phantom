// Dashboard shell: router, theme toggle, sidebar wiring, toast helpers,
// modal helpers, and a thin fetch wrapper. Each tab module (skills.js,
// memory-files.js) registers with the shell and is told to mount/unmount
// on route changes.

(function () {
	var routes = {};
	var activeRoute = null;
	var dirtyCheckers = [];

	function qs(sel) { return document.querySelector(sel); }
	function qsa(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

	function esc(s) {
		if (s == null) return "";
		return String(s)
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#39;");
	}

	function toast(kind, title, body) {
		var container = qs("#toast-container");
		if (!container) return;
		var el = document.createElement("div");
		el.className = "dash-toast dash-toast-" + kind;
		el.setAttribute("role", kind === "error" ? "alert" : "status");
		var titleHtml = '<p class="dash-toast-title">' + esc(title) + "</p>";
		var bodyHtml = body ? '<p class="dash-toast-body">' + esc(body) + "</p>" : "";
		el.innerHTML = titleHtml + bodyHtml;
		container.appendChild(el);
		setTimeout(function () {
			el.style.transition = "opacity 200ms ease, transform 200ms ease";
			el.style.opacity = "0";
			el.style.transform = "translateY(-6px)";
		}, kind === "error" ? 5000 : 2800);
		setTimeout(function () {
			if (el.parentNode) el.parentNode.removeChild(el);
		}, kind === "error" ? 5400 : 3100);
	}

	function api(method, url, body) {
		var init = { method: method, credentials: "same-origin", headers: {} };
		if (body !== undefined) {
			init.headers["Content-Type"] = "application/json";
			init.body = JSON.stringify(body);
		}
		return fetch(url, init).then(function (res) {
			var ct = res.headers.get("Content-Type") || "";
			var pJson = ct.indexOf("application/json") >= 0 ? res.json() : res.text();
			return pJson.then(function (parsed) {
				if (!res.ok) {
					var msg = (parsed && parsed.error) || ("HTTP " + res.status);
					var e = new Error(msg);
					e.status = res.status;
					throw e;
				}
				return parsed;
			});
		});
	}

	function openModal(options) {
		var backdrop = document.createElement("div");
		backdrop.className = "dash-modal-backdrop";
		backdrop.setAttribute("role", "dialog");
		backdrop.setAttribute("aria-modal", "true");

		var modal = document.createElement("div");
		modal.className = "dash-modal";

		var title = document.createElement("h2");
		title.className = "dash-modal-title";
		title.textContent = options.title || "";

		var body = document.createElement("div");
		body.className = "dash-modal-body";
		if (typeof options.body === "string") {
			body.textContent = options.body;
		} else if (options.body instanceof Node) {
			body.appendChild(options.body);
		}

		var actions = document.createElement("div");
		actions.className = "dash-modal-actions";
		(options.actions || []).forEach(function (action) {
			var btn = document.createElement("button");
			btn.className = "dash-btn " + (action.className || "dash-btn-ghost");
			btn.textContent = action.label;
			btn.addEventListener("click", function () {
				var result = action.onClick ? action.onClick(modal) : null;
				Promise.resolve(result).then(function (shouldClose) {
					if (shouldClose !== false) close();
				});
			});
			actions.appendChild(btn);
		});

		modal.appendChild(title);
		modal.appendChild(body);
		modal.appendChild(actions);
		backdrop.appendChild(modal);
		document.body.appendChild(backdrop);

		var firstInput = modal.querySelector("input, textarea, select, button");
		if (firstInput) setTimeout(function () { firstInput.focus(); }, 50);

		function close() {
			if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
			document.removeEventListener("keydown", onKey);
		}
		function onKey(e) {
			if (e.key === "Escape") { e.preventDefault(); close(); }
		}
		document.addEventListener("keydown", onKey);
		backdrop.addEventListener("click", function (e) {
			if (e.target === backdrop) close();
		});

		return { modal: modal, close: close };
	}

	function registerRoute(name, module) {
		routes[name] = module;
	}

	function registerDirtyChecker(fn) {
		dirtyCheckers.push(fn);
	}

	function anyDirty() {
		for (var i = 0; i < dirtyCheckers.length; i++) {
			if (dirtyCheckers[i]()) return true;
		}
		return false;
	}

	function parseHash() {
		var hash = window.location.hash || "#/skills";
		var clean = hash.replace(/^#\/?/, "");
		var parts = clean.split("/");
		return {
			route: parts[0] || "skills",
			arg: parts.length > 1 ? decodeURIComponent(parts.slice(1).join("/")) : null,
		};
	}

	function setActiveSidebar(name) {
		qsa(".dash-sidebar-item").forEach(function (item) {
			if (item.getAttribute("data-route") === name) {
				item.setAttribute("aria-current", "page");
			} else {
				item.removeAttribute("aria-current");
			}
		});
	}

	function setBreadcrumb(label) {
		var sep = qs("#crumb-sep-2");
		var current = qs("#crumb-current");
		if (label) {
			if (sep) sep.hidden = false;
			if (current) {
				current.hidden = false;
				current.textContent = label;
			}
		} else {
			if (sep) sep.hidden = true;
			if (current) {
				current.hidden = true;
				current.textContent = "";
			}
		}
	}

	function renderSoon(name) {
		var container = qs("#route-soon");
		if (!container) return;
		container.setAttribute("data-active", "true");
		var labels = {
			sessions: {
				eyebrow: "PR2",
				title: "Sessions",
				body: "A live view of every session the agent has had, with channels, costs, turn counts, and outcomes. Click through for full transcripts and the memories consolidated from each run.",
			},
			cost: {
				eyebrow: "PR2",
				title: "Cost",
				body: "Daily and weekly cost breakdowns with model-level detail. Charts across time so you can see where the agent's budget actually goes, and alerts when anything drifts out of its baseline.",
			},
			scheduler: {
				eyebrow: "PR3",
				title: "Scheduler",
				body: "Every cron and one-shot job the agent has created, with next-run times, recent outcomes, and the ability to edit or pause a schedule without asking the agent to do it for you.",
			},
			evolution: {
				eyebrow: "PR3",
				title: "Evolution timeline",
				body: "The 6-step self-evolution pipeline rendered as a timeline: reflections, judges, validated changes, version bumps, and rollback points. You see exactly how the agent is changing itself over time.",
			},
			memory: {
				eyebrow: "PR4",
				title: "Memory explorer",
				body: "A read view over every episode, fact, and procedure the agent has consolidated. Search, filter by decay, inspect provenance, and watch memories get reinforced as they get reused.",
			},
			settings: {
				eyebrow: "PR3",
				title: "Settings",
				body: "A curated form over the agent's Claude Code settings: permissions, MCP servers, hooks, and the knobs that actually change how it thinks. Raw JSON escape hatch for the power users.",
			},
		};
		var meta = labels[name] || { eyebrow: "Soon", title: name, body: "Coming in a later PR." };
		container.innerHTML = (
			'<div class="dash-soon">' +
			'<p class="dash-soon-eyebrow">' + esc(meta.eyebrow) + ' &middot; Coming soon</p>' +
			'<h1 class="dash-soon-title">' + esc(meta.title) + '</h1>' +
			'<p class="dash-soon-body">' + esc(meta.body) + '</p>' +
			'<a href="#/skills" class="dash-btn dash-btn-ghost">Back to skills</a>' +
			'</div>'
		);
		setBreadcrumb(meta.title);
	}

	function deactivateAllRoutes() {
		qsa(".dash-route").forEach(function (el) {
			el.removeAttribute("data-active");
			el.hidden = true;
		});
	}

	function navigate(hash) {
		if (anyDirty()) {
			var go = window.confirm("You have unsaved changes. Leave without saving?");
			if (!go) {
				window.history.replaceState(null, "", activeRoute || "#/skills");
				return;
			}
		}
		window.location.hash = hash;
	}

	function onHashChange() {
		var parsed = parseHash();
		var name = parsed.route;
		deactivateAllRoutes();

		var liveRoutes = ["skills", "memory-files", "plugins"];
		var comingSoon = ["sessions", "cost", "scheduler", "evolution", "memory", "settings"];

		if (liveRoutes.indexOf(name) >= 0 && routes[name]) {
			var containerId = "route-" + name;
			var container = qs("#" + containerId);
			if (container) {
				container.hidden = false;
				container.setAttribute("data-active", "true");
			}
			setActiveSidebar(name);
			routes[name].mount(container, parsed.arg, {
				esc: esc,
				api: api,
				toast: toast,
				openModal: openModal,
				navigate: navigate,
				setBreadcrumb: setBreadcrumb,
				registerDirtyChecker: registerDirtyChecker,
			});
			activeRoute = window.location.hash || ("#/" + name);
		} else if (comingSoon.indexOf(name) >= 0) {
			var soon = qs("#route-soon");
			if (soon) soon.hidden = false;
			setActiveSidebar(name);
			renderSoon(name);
			activeRoute = window.location.hash || ("#/" + name);
		} else {
			window.location.hash = "#/skills";
		}
	}

	function initThemeToggle() {
		var toggle = document.getElementById("theme-toggle");
		if (!toggle) return;
		var sun = document.getElementById("icon-sun");
		var moon = document.getElementById("icon-moon");
		function update() {
			var theme = document.documentElement.getAttribute("data-theme");
			var isDark = theme === "phantom-dark";
			if (sun) sun.style.display = isDark ? "inline" : "none";
			if (moon) moon.style.display = isDark ? "none" : "inline";
		}
		update();
		toggle.addEventListener("click", function () {
			var current = document.documentElement.getAttribute("data-theme");
			var next = current === "phantom-dark" ? "phantom-light" : "phantom-dark";
			document.documentElement.setAttribute("data-theme", next);
			localStorage.setItem("phantom-theme", next);
			update();
		});
	}

	function setNavDate() {
		var el = document.getElementById("nav-date");
		if (el) el.textContent = new Date().toISOString().split("T")[0];
	}

	function init() {
		setNavDate();
		initThemeToggle();

		window.addEventListener("beforeunload", function (e) {
			if (anyDirty()) {
				e.preventDefault();
				e.returnValue = "";
				return "";
			}
		});

		// Intercept sidebar clicks on Coming Soon items so their hash still updates
		qsa(".dash-sidebar-item").forEach(function (item) {
			item.addEventListener("click", function (e) {
				var target = item.getAttribute("href");
				if (!target) return;
				e.preventDefault();
				navigate(target);
			});
		});

		window.addEventListener("hashchange", onHashChange);
		if (!window.location.hash) {
			window.location.hash = "#/skills";
		} else {
			onHashChange();
		}
	}

	window.PhantomDashboard = {
		init: init,
		registerRoute: registerRoute,
		toast: toast,
		api: api,
		esc: esc,
		openModal: openModal,
		navigate: navigate,
	};
})();
