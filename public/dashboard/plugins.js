// Plugins tab: marketplace browser, trust modal, install, uninstall, audit
// timeline, find-a-plugin search.
//
// Module contract: registers with PhantomDashboard via registerRoute('plugins').
// mount(container, arg, ctx) is called on hash change. ctx provides esc, api,
// toast, openModal, navigate, setBreadcrumb, registerDirtyChecker.
//
// Plugins is mostly read-only browsing with an install action, so this module
// does not register a dirty checker (no edit state to lose).

(function () {
	var state = {
		catalog: null,
		filter: "all", // all | installed | recommended
		category: null,
		search: "",
		loading: false,
		fetchedAt: null,
		hiddenByTransport: 0,
		fromStaleCache: false,
	};
	var ctx = null;
	var root = null;

	function esc(s) { return ctx.esc(s); }

	function renderHeader() {
		return (
			'<div class="dash-header">' +
			'<p class="dash-header-eyebrow">Plugins</p>' +
			'<h1 class="dash-header-title">Plugins</h1>' +
			'<p class="dash-header-lead">Install plugins from the claude-plugins-official marketplace. Each install runs through a trust modal and lands in your audit log. The agent picks up new plugins on its next message.</p>' +
			'<div class="dash-header-actions">' +
			'<button class="dash-btn dash-btn-ghost" id="plugins-find-btn">Ask Phantom what plugin I need</button>' +
			'<button class="dash-btn dash-btn-ghost" id="plugins-refresh-btn">Refresh marketplace</button>' +
			'</div>' +
			'</div>'
		);
	}

	function uniqueCategories(plugins) {
		var set = {};
		plugins.forEach(function (p) {
			if (p.category) set[p.category] = true;
		});
		return Object.keys(set).sort();
	}

	function renderFilters() {
		var plugins = (state.catalog && state.catalog.plugins) || [];
		var installedCount = plugins.filter(function (p) { return p.enabled; }).length;
		var recommendedCount = plugins.filter(function (p) {
			return (p.curated_tags || []).indexOf("phantom-recommended") >= 0;
		}).length;
		var cats = uniqueCategories(plugins);

		var parts = [];
		parts.push('<div class="plugins-filters">');
		parts.push('<div class="plugins-tabs" role="tablist">');
		parts.push(filterPill("all", "All " + plugins.length));
		parts.push(filterPill("installed", "Installed " + installedCount));
		parts.push(filterPill("recommended", "Recommended " + recommendedCount));
		parts.push('</div>');

		if (cats.length > 0) {
			parts.push('<div class="plugins-cats">');
			parts.push(catChip(null, "All categories"));
			cats.forEach(function (c) { parts.push(catChip(c, c)); });
			parts.push('</div>');
		}

		parts.push('<div class="plugins-search">');
		parts.push('<svg fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"/></svg>');
		parts.push('<input type="search" id="plugins-search" placeholder="Search by name, description, or category" value="' + esc(state.search) + '">');
		parts.push('</div>');
		parts.push('</div>');
		return parts.join("");
	}

	function filterPill(value, label) {
		var current = state.filter === value ? ' aria-current="true"' : "";
		return '<button class="plugins-tab" data-filter="' + esc(value) + '"' + current + '>' + esc(label) + '</button>';
	}

	function catChip(value, label) {
		var current = (state.category === value || (value === null && state.category === null)) ? ' data-active="true"' : "";
		return '<button class="plugins-cat-chip" data-cat="' + esc(value || "") + '"' + current + '>' + esc(label) + '</button>';
	}

	function filteredPlugins() {
		if (!state.catalog) return [];
		var list = state.catalog.plugins.slice();
		if (state.filter === "installed") {
			list = list.filter(function (p) { return p.enabled; });
		} else if (state.filter === "recommended") {
			list = list.filter(function (p) { return (p.curated_tags || []).indexOf("phantom-recommended") >= 0; });
		}
		if (state.category) {
			list = list.filter(function (p) { return p.category === state.category; });
		}
		var q = (state.search || "").trim().toLowerCase();
		if (q) {
			list = list.filter(function (p) {
				return (
					(p.name || "").toLowerCase().indexOf(q) >= 0 ||
					(p.description || "").toLowerCase().indexOf(q) >= 0 ||
					(p.category || "").toLowerCase().indexOf(q) >= 0
				);
			});
		}
		return list;
	}

	function renderCard(plugin) {
		var sourceClass = "plugins-source-" + plugin.source_type;
		var sourceLabel = plugin.source_type;
		var actionBtn = plugin.enabled
			? '<button class="dash-btn dash-btn-ghost dash-btn-sm" data-uninstall="' + esc(plugin.name) + '">Uninstall</button>'
			: '<button class="dash-btn dash-btn-primary dash-btn-sm" data-install="' + esc(plugin.name) + '">Install</button>';
		var statusBadge = plugin.enabled
			? '<span class="plugins-status-installed"><span class="plugins-status-dot"></span>installed</span>'
			: "";
		var pinnedBadge = plugin.pinned_version
			? '<span class="plugins-pin">v' + esc(plugin.pinned_version) + '</span>'
			: "";

		var curatedTags = (plugin.curated_tags || []).map(function (t) {
			return '<span class="plugins-curated-tag plugins-curated-' + esc(t) + '">' + esc(t.replace(/-/g, " ")) + '</span>';
		}).join("");

		var noteHtml = plugin.curated_note
			? '<p class="plugins-card-note">' + esc(plugin.curated_note) + '</p>'
			: "";

		return (
			'<article class="plugins-card" data-plugin="' + esc(plugin.name) + '">' +
			'<header class="plugins-card-header">' +
			'<h3 class="plugins-card-title">' + esc(plugin.name) + '</h3>' +
			'<div class="plugins-card-status">' + statusBadge + pinnedBadge + '</div>' +
			'</header>' +
			'<p class="plugins-card-desc">' + esc(plugin.description || "") + '</p>' +
			noteHtml +
			'<div class="plugins-card-badges">' +
			'<span class="plugins-source-badge ' + sourceClass + '">' + esc(sourceLabel) + '</span>' +
			(plugin.category ? '<span class="plugins-category-badge">' + esc(plugin.category) + '</span>' : "") +
			curatedTags +
			'</div>' +
			'<div class="plugins-card-actions">' +
			actionBtn +
			'<button class="plugins-history-link" data-history="' + esc(plugin.name) + '">history</button>' +
			'</div>' +
			'</article>'
		);
	}

	function renderGrid() {
		if (state.loading) {
			return renderSkeletons();
		}
		if (!state.catalog) {
			return (
				'<div class="dash-empty">' +
				'<h3 class="dash-empty-title">Marketplace unreachable</h3>' +
				'<p class="dash-empty-body">We could not fetch the plugin marketplace. Check your connection or try Refresh marketplace above.</p>' +
				'</div>'
			);
		}
		var plugins = filteredPlugins();
		if (plugins.length === 0) {
			return (
				'<div class="dash-empty">' +
				'<h3 class="dash-empty-title">No plugins match</h3>' +
				'<p class="dash-empty-body">Try a different filter, category, or search term.</p>' +
				'</div>'
			);
		}
		var cards = plugins.map(renderCard).join("");
		var staleNote = state.fromStaleCache
			? '<p class="plugins-stale">Showing cached marketplace, latest fetch failed.</p>'
			: "";
		var hiddenNote =
			state.hiddenByTransport > 0
				? '<p class="plugins-hidden-note">' + state.hiddenByTransport + ' plugin' + (state.hiddenByTransport === 1 ? "" : "s") + ' hidden because they use a transport (git-subdir, npm, pip, file) not supported in this release.</p>'
				: "";
		return staleNote + '<div class="plugins-grid">' + cards + '</div>' + hiddenNote;
	}

	function renderSkeletons() {
		var n = 6;
		var parts = ['<div class="plugins-grid">'];
		for (var i = 0; i < n; i++) {
			parts.push(
				'<div class="dash-skeleton-card">' +
				'<div class="dash-skeleton" style="width:40%;"></div>' +
				'<div class="dash-skeleton" style="width:90%;"></div>' +
				'<div class="dash-skeleton" style="width:60%;"></div>' +
				'</div>',
			);
		}
		parts.push('</div>');
		return parts.join("");
	}

	function render() {
		root.innerHTML = renderHeader() + renderFilters() + '<div id="plugins-grid-wrap">' + renderGrid() + '</div>';
		// Persistent listeners (header, search, tabs, category chips) bind once
		// per render. Grid listeners (install, uninstall, history) re-bind on
		// every rerenderGrid because the cards get replaced. Keeping them split
		// prevents the quadratic listener leak that fires when the user types
		// in the search box, since rerenderGrid only touches grid-internal
		// elements and never re-attaches listeners on persistent controls.
		wirePersistentEvents();
		wireGridEvents();
		ctx.setBreadcrumb("Plugins");
	}

	function wirePersistentEvents() {
		var refresh = document.getElementById("plugins-refresh-btn");
		if (refresh) refresh.addEventListener("click", function () { loadCatalog(true); });
		var find = document.getElementById("plugins-find-btn");
		if (find) find.addEventListener("click", openFindModal);

		var search = document.getElementById("plugins-search");
		if (search) {
			search.addEventListener("input", function () {
				state.search = search.value || "";
				rerenderGrid();
			});
		}

		Array.prototype.forEach.call(document.querySelectorAll(".plugins-tab"), function (btn) {
			btn.addEventListener("click", function () {
				state.filter = btn.getAttribute("data-filter");
				render();
			});
		});

		Array.prototype.forEach.call(document.querySelectorAll(".plugins-cat-chip"), function (btn) {
			btn.addEventListener("click", function () {
				var cat = btn.getAttribute("data-cat");
				state.category = cat || null;
				render();
			});
		});
	}

	function wireGridEvents() {
		Array.prototype.forEach.call(document.querySelectorAll("[data-install]"), function (btn) {
			btn.addEventListener("click", function () {
				openInstallModal(btn.getAttribute("data-install"));
			});
		});

		Array.prototype.forEach.call(document.querySelectorAll("[data-uninstall]"), function (btn) {
			btn.addEventListener("click", function () {
				openUninstallModal(btn.getAttribute("data-uninstall"));
			});
		});

		Array.prototype.forEach.call(document.querySelectorAll("[data-history]"), function (btn) {
			btn.addEventListener("click", function () {
				openHistoryPanel(btn.getAttribute("data-history"));
			});
		});
	}

	function rerenderGrid() {
		var wrap = document.getElementById("plugins-grid-wrap");
		if (!wrap) return;
		wrap.innerHTML = renderGrid();
		wireGridEvents();
	}

	function findPlugin(name) {
		if (!state.catalog) return null;
		for (var i = 0; i < state.catalog.plugins.length; i++) {
			if (state.catalog.plugins[i].name === name) return state.catalog.plugins[i];
		}
		return null;
	}

	function openInstallModal(name) {
		var plugin = findPlugin(name);
		if (!plugin) return;

		var body = document.createElement("div");
		body.innerHTML = (
			'<p class="plugins-modal-key">' + esc(plugin.name) + '@' + esc(plugin.marketplace) + '</p>' +
			'<p class="plugins-modal-source">Source: <span class="phantom-mono">' + esc(plugin.source_type) + (plugin.source_url ? ' &middot; ' + esc(plugin.source_url) : "") + '</span></p>' +
			'<p class="plugins-modal-desc">' + esc(plugin.description || "") + '</p>' +
			'<div class="plugins-modal-warning">' +
			'<p class="plugins-modal-warning-title">This plugin can:</p>' +
			'<ul>' +
			'<li>run shell commands via hooks</li>' +
			'<li>add skills and commands your agent will follow</li>' +
			'<li>install MCP servers with access to your environment</li>' +
			'<li>write to your agent\'s memory on first install</li>' +
			'</ul>' +
			'<p class="plugins-modal-warning-foot">Phantom loads the plugin on your next message. Review the source before you trust it.</p>' +
			'</div>' +
			'<label class="plugins-trust-row">' +
			'<input type="checkbox" id="plugins-trust-checkbox">' +
			'<span>I understand and I trust this plugin</span>' +
			'</label>'
		);

		var modal = ctx.openModal({
			title: "Install " + plugin.name + "?",
			body: body,
			actions: [
				{ label: "Cancel", className: "dash-btn-ghost", onClick: function () {} },
				{
					label: "Install",
					className: "dash-btn-primary",
					onClick: function () {
						var box = document.getElementById("plugins-trust-checkbox");
						if (!box || !box.checked) {
							ctx.toast("error", "Trust required", "Confirm you trust this plugin before installing.");
							return false;
						}
						return installPlugin(plugin);
					},
				},
			],
		});

		// Disable the install button until the checkbox is checked.
		setTimeout(function () {
			var actions = document.querySelectorAll(".dash-modal-actions .dash-btn-primary");
			var installBtn = actions[actions.length - 1];
			var box = document.getElementById("plugins-trust-checkbox");
			if (installBtn && box) {
				installBtn.disabled = true;
				box.addEventListener("change", function () {
					installBtn.disabled = !box.checked;
				});
			}
		}, 60);

		return modal;
	}

	function installPlugin(plugin) {
		return ctx.api("POST", "/ui/api/plugins/install", { plugin: plugin.name, marketplace: plugin.marketplace })
			.then(function (res) {
				if (res.already_installed) {
					ctx.toast("success", plugin.name + " already installed", "No changes needed.");
				} else {
					ctx.toast("success", plugin.name + " installed", "Your agent picks it up on its next message.");
				}
				return loadCatalog(false);
			})
			.catch(function (err) {
				ctx.toast("error", "Install failed", err.message || String(err));
				return false;
			});
	}

	function openUninstallModal(name) {
		var plugin = findPlugin(name);
		if (!plugin) return;
		var body = document.createElement("div");
		body.innerHTML = (
			'<p class="plugins-modal-desc">This disables the plugin on your next message. The cached files stay on disk and can be re-enabled with one click.</p>' +
			'<p class="plugins-modal-key">' + esc(plugin.name) + '@' + esc(plugin.marketplace) + '</p>'
		);
		ctx.openModal({
			title: "Uninstall " + plugin.name + "?",
			body: body,
			actions: [
				{ label: "Cancel", className: "dash-btn-ghost", onClick: function () {} },
				{
					label: "Uninstall",
					className: "dash-btn-danger",
					onClick: function () {
						var key = encodeURIComponent(plugin.name + "@" + plugin.marketplace);
						return ctx.api("DELETE", "/ui/api/plugins/" + key)
							.then(function () {
								ctx.toast("success", plugin.name + " uninstalled", "The plugin is disabled on your next message.");
								return loadCatalog(false);
							})
							.catch(function (err) {
								ctx.toast("error", "Uninstall failed", err.message || String(err));
								return false;
							});
					},
				},
			],
		});
	}

	function openHistoryPanel(name) {
		var plugin = findPlugin(name);
		if (!plugin) return;
		var key = plugin.name + "@" + plugin.marketplace;
		ctx.api("GET", "/ui/api/plugins/" + encodeURIComponent(key) + "/audit").then(function (res) {
			var rows = res.audit || [];
			var body = document.createElement("div");
			if (rows.length === 0) {
				body.innerHTML = '<p class="plugins-modal-desc">No audit entries yet.</p>';
			} else {
				var lines = rows.map(function (r) {
					return (
						'<div class="plugins-audit-row">' +
						'<span class="plugins-audit-time">' + esc(r.created_at) + '</span>' +
						'<span class="plugins-audit-action plugins-audit-' + esc(r.action) + '">' + esc(r.action) + '</span>' +
						'<span class="plugins-audit-actor">' + esc(r.actor) + '</span>' +
						'<span class="plugins-audit-diff">' +
						(r.previous_value ? esc(r.previous_value) : "absent") +
						' &rarr; ' +
						(r.new_value ? esc(r.new_value) : "absent") +
						'</span>' +
						'</div>'
					);
				}).join("");
				body.innerHTML = '<div class="plugins-audit-list">' + lines + '</div>';
			}
			ctx.openModal({
				title: name + " audit timeline",
				body: body,
				actions: [{ label: "Close", className: "dash-btn-ghost", onClick: function () {} }],
			});
		}).catch(function (err) {
			ctx.toast("error", "Failed to load audit", err.message || String(err));
		});
	}

	function openFindModal() {
		var body = document.createElement("div");
		body.innerHTML = (
			'<p class="plugins-modal-desc">Describe what you want a plugin to help with. Phantom searches the catalog for matches.</p>' +
			'<div class="dash-field">' +
			'<textarea class="dash-textarea" id="plugins-find-input" placeholder="Track customer support tickets across channels" style="min-height:90px;"></textarea>' +
			'</div>' +
			'<div id="plugins-find-results"></div>'
		);
		ctx.openModal({
			title: "Find a plugin",
			body: body,
			actions: [
				{ label: "Close", className: "dash-btn-ghost", onClick: function () {} },
				{
					label: "Search",
					className: "dash-btn-primary",
					onClick: function () {
						var input = document.getElementById("plugins-find-input");
						var query = (input.value || "").trim();
						if (!query) {
							ctx.toast("error", "Empty query", "Type what you are looking for first.");
							return false;
						}
						return ctx.api("POST", "/ui/api/plugins/find", { query: query }).then(function (res) {
							renderFindResults(res.results || []);
							return false;
						}).catch(function (err) {
							ctx.toast("error", "Find failed", err.message || String(err));
							return false;
						});
					},
				},
			],
		});
	}

	function renderFindResults(results) {
		var wrap = document.getElementById("plugins-find-results");
		if (!wrap) return;
		if (results.length === 0) {
			wrap.innerHTML = '<p class="plugins-modal-desc">No matches. Try different words.</p>';
			return;
		}
		wrap.innerHTML = '<p class="plugins-find-eyebrow">Top matches</p>' + results.map(function (r) {
			var status = r.enabled ? '<span class="plugins-status-installed"><span class="plugins-status-dot"></span>installed</span>' : "";
			return (
				'<div class="plugins-find-row">' +
				'<div class="plugins-find-row-head"><span class="plugins-find-name">' + esc(r.name) + '</span>' + status + '</div>' +
				'<div class="plugins-find-row-desc">' + esc(r.description || "") + '</div>' +
				'</div>'
			);
		}).join("");
	}

	function loadCatalog(forceRefresh) {
		state.loading = true;
		render();
		var path = "/ui/api/plugins/marketplace" + (forceRefresh ? "?refresh=1" : "");
		return ctx.api("GET", path).then(function (res) {
			state.catalog = { marketplace: res.marketplace, plugins: res.plugins };
			state.fetchedAt = res.fetched_at;
			state.hiddenByTransport = res.hidden_by_transport || 0;
			state.fromStaleCache = !!res.from_stale_cache;
			state.loading = false;
			render();
		}).catch(function (err) {
			state.loading = false;
			state.catalog = null;
			render();
			ctx.toast("error", "Failed to load marketplace", err.message || String(err));
		});
	}

	function mount(container, _arg, dashCtx) {
		ctx = dashCtx;
		root = container;
		ctx.setBreadcrumb("Plugins");
		return loadCatalog(false);
	}

	// Live install snapshot hook. Called by dashboard.js whenever the agent's
	// SDK init message reports the enabled-plugin set for a freshly-kicked
	// query. The emit side publishes fully-qualified keys in the format
	// `${name}@${marketplace}` (from cli.js, the init message constructor).
	// We match against the card's synthetic key computed the same way so
	// cards across marketplaces never collapse onto each other when two
	// share a bare plugin name. On a match we flip the card to
	// "installed" and surface a gentle toast.
	function onInitSnapshot(payload) {
		if (!payload || !Array.isArray(payload.keys) || payload.keys.length === 0) return;
		if (!state.catalog || !Array.isArray(state.catalog.plugins)) return;
		var seen = Object.create(null);
		for (var i = 0; i < payload.keys.length; i++) {
			seen[payload.keys[i]] = true;
		}
		var flipped = [];
		state.catalog.plugins.forEach(function (p) {
			var fqKey = (p.name || "") + "@" + (p.marketplace || "");
			if (seen[fqKey] && !p.enabled) {
				p.enabled = true;
				flipped.push(p.name || fqKey);
			}
		});
		if (flipped.length > 0) {
			// Re-render if we are currently mounted (root has content).
			if (root && root.getAttribute("data-active") === "true") {
				// Small delay so the card flip animation is perceptible
				// rather than instantaneous on fast connections.
				setTimeout(render, 120);
			}
			if (ctx && ctx.toast) {
				if (flipped.length === 1) {
					ctx.toast("success", "Plugin live", flipped[0] + " is now active.");
				} else {
					ctx.toast("success", "Plugins live", flipped.length + " plugins are now active.");
				}
			}
		}
	}

	window.PhantomDashboard.registerRoute("plugins", { mount: mount });
	window.PhantomPluginsModule = { onInitSnapshot: onInitSnapshot };
})();
