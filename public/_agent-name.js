// Canonical agent-name and avatar customization IIFE for Phantom static pages.
//
// Loaded once per page with <script src="/ui/_agent-name.js"></script>.
// Replaces [data-agent-name], [data-agent-name-initial], [data-agent-name-lower]
// nodes with the deployed agent name and substitutes {{AGENT_NAME_CAPITALIZED}}
// in any <title data-agent-name-title> template.
//
// Avatar: if the operator has uploaded one, any [data-agent-avatar] element
// gets an <img src="/ui/avatar"> inserted. A sibling marked
// [data-agent-avatar-fallback] is hidden on successful load and un-hidden if
// the image errors (so the initial-letter badge still reads).
//
// Mirrors the server-side capitalizeAgentName contract: empty/whitespace name
// falls back to "Phantom" so the brand never reads as blank. Paints an
// optimistic value from localStorage (agent name AND avatar URL) on load, then
// swaps when /health resolves so warm loads have no flash.
(function () {
	var AVATAR_KEY = "phantom-agent-avatar";

	function cap(name) {
		if (!name) return "Phantom";
		var trimmed = String(name).trim();
		if (!trimmed) return "Phantom";
		return trimmed
			.split(/([-_])/)
			.map(function (part) {
				if (part === "-" || part === "_") return part;
				if (!part.length) return part;
				return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
			})
			.join("");
	}

	var titleEl = document.querySelector("title[data-agent-name-title]");
	var titleTemplate = titleEl ? titleEl.getAttribute("data-agent-name-title-template") : "";
	if (titleEl && !titleTemplate) {
		var initial = titleEl.textContent || "";
		if (initial.indexOf("{{AGENT_NAME_CAPITALIZED}}") !== -1) {
			titleTemplate = initial;
			titleEl.setAttribute("data-agent-name-title-template", initial);
		}
	}

	function applyName(name) {
		var display = cap(name);
		var initial = display.charAt(0).toUpperCase();
		var lower = display.toLowerCase();
		document.querySelectorAll("[data-agent-name]").forEach(function (el) {
			el.textContent = display;
		});
		document.querySelectorAll("[data-agent-name-initial]").forEach(function (el) {
			el.textContent = initial;
		});
		document.querySelectorAll("[data-agent-name-lower]").forEach(function (el) {
			el.textContent = lower;
		});
		if (titleEl && titleTemplate) {
			titleEl.textContent = titleTemplate.split("{{AGENT_NAME_CAPITALIZED}}").join(display);
		}
		try {
			if (name) localStorage.setItem("phantom-agent-name", name);
		} catch (e) {}
	}

	function applyAvatar(url) {
		// null means "no avatar uploaded", so make sure any previously-inserted
		// img is removed and fallbacks are visible.
		document.querySelectorAll("[data-agent-avatar]").forEach(function (slot) {
			var existing = slot.querySelector("img[data-agent-avatar-img]");
			var fallback = slot.querySelector("[data-agent-avatar-fallback]");
			if (!url) {
				if (existing) existing.remove();
				if (fallback) fallback.style.display = "";
				return;
			}
			if (existing) {
				if (existing.getAttribute("src") !== url) existing.setAttribute("src", url);
				return;
			}
			var img = document.createElement("img");
			img.setAttribute("data-agent-avatar-img", "");
			img.setAttribute("alt", "");
			img.className = "phantom-nav-logo-img";
			img.addEventListener("error", function () {
				img.remove();
				if (fallback) fallback.style.display = "";
			});
			img.addEventListener("load", function () {
				if (fallback) fallback.style.display = "none";
			});
			img.setAttribute("src", url);
			// Hide the fallback letter the moment we commit to inserting the
			// img. If it errors the listener above brings it back.
			if (fallback) fallback.style.display = "none";
			slot.insertBefore(img, fallback || null);
		});
		document.querySelectorAll("[data-agent-avatar-url]").forEach(function (el) {
			if (url) {
				el.setAttribute("content", url);
				el.setAttribute("href", url);
			}
		});
		try {
			if (url) localStorage.setItem(AVATAR_KEY, url);
			else localStorage.removeItem(AVATAR_KEY);
		} catch (e) {}
	}

	var cachedName = "";
	var cachedAvatar = null;
	try {
		cachedName = localStorage.getItem("phantom-agent-name") || "";
		cachedAvatar = localStorage.getItem(AVATAR_KEY);
	} catch (e) {}
	applyName(cachedName || "Phantom");
	if (cachedAvatar) applyAvatar(cachedAvatar);

	fetch("/health", { credentials: "same-origin", headers: { Accept: "application/json" } })
		.then(function (r) {
			return r.ok ? r.json() : null;
		})
		.then(function (d) {
			if (!d) return;
			if (d.agent) applyName(d.agent);
			// avatar_url is null when no upload, "/ui/avatar" otherwise.
			if (Object.prototype.hasOwnProperty.call(d, "avatar_url")) {
				applyAvatar(d.avatar_url || null);
			}
		})
		.catch(function () {});

	// Exposed so the dashboard Settings > Identity section can force the
	// surrounding navbar to repaint immediately after a successful upload,
	// without waiting for the 5-minute cache to expire.
	window.addEventListener("phantom:avatar-updated", function (ev) {
		var url = ev && ev.detail && ev.detail.url;
		applyAvatar(url === undefined ? "/ui/avatar" : url);
	});
})();
