// UI API routes for the plugins tab.
//
// All routes live under /ui/api/plugins and are cookie-auth gated by the
// dispatcher in src/ui/serve.ts.
//
//   GET    /ui/api/plugins/marketplace          -> normalized catalog (cached)
//   GET    /ui/api/plugins                       -> currently active enabledPlugins
//   POST   /ui/api/plugins/install               -> body { plugin, marketplace }
//   DELETE /ui/api/plugins/:plugin@:marketplace -> soft uninstall
//   GET    /ui/api/plugins/:plugin@:marketplace/audit -> audit timeline
//   POST   /ui/api/plugins/find                  -> body { query }, top-5 matches
//
// JSON in, JSON out. All errors are { error: string } with the appropriate
// HTTP status. The plugins-curated.json overlay is loaded transparently by the
// catalog fetcher; this layer does not handle merging.

import type { Database } from "bun:sqlite";
import { listPluginAudit, recordPluginInstall } from "../../plugins/audit.ts";
import { type FetchMarketplaceFn, getCatalog } from "../../plugins/marketplace.ts";
import { OFFICIAL_MARKETPLACE_ID, formatPluginKey, parsePluginKey } from "../../plugins/paths.ts";
import { installPlugin, listEnabledPlugins, uninstallPlugin } from "../../plugins/settings-io.ts";

export type PluginsApiDeps = {
	db: Database;
	// Test seam so __tests__/plugins.test.ts can pass a fake fetcher.
	fetcher?: FetchMarketplaceFn;
	settingsPath?: string;
	overlayPath?: string;
};

function json(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		...init,
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": "no-store",
			...((init?.headers as Record<string, string>) ?? {}),
		},
	});
}

async function readJson(req: Request): Promise<unknown | { __error: string }> {
	try {
		return await req.json();
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { __error: `Invalid JSON body: ${msg}` };
	}
}

type InstallBody = { plugin: string; marketplace?: string };

function parseInstallBody(raw: unknown): { ok: true; body: InstallBody } | { ok: false; error: string } {
	if (!raw || typeof raw !== "object") {
		return { ok: false, error: "Request body must be a JSON object" };
	}
	const shape = raw as { plugin?: unknown; marketplace?: unknown };
	if (typeof shape.plugin !== "string" || shape.plugin.length === 0) {
		return { ok: false, error: "plugin field is required and must be a non-empty string" };
	}
	if (shape.marketplace !== undefined && typeof shape.marketplace !== "string") {
		return { ok: false, error: "marketplace field, when present, must be a string" };
	}
	return { ok: true, body: { plugin: shape.plugin, marketplace: shape.marketplace ?? OFFICIAL_MARKETPLACE_ID } };
}

type FindBody = { query: string; limit?: number };

function parseFindBody(raw: unknown): { ok: true; body: FindBody } | { ok: false; error: string } {
	if (!raw || typeof raw !== "object") {
		return { ok: false, error: "Request body must be a JSON object" };
	}
	const shape = raw as { query?: unknown; limit?: unknown };
	if (typeof shape.query !== "string" || shape.query.trim().length === 0) {
		return { ok: false, error: "query field is required and must be a non-empty string" };
	}
	const limit =
		typeof shape.limit === "number" && Number.isFinite(shape.limit) && shape.limit > 0
			? Math.min(20, Math.floor(shape.limit))
			: 5;
	return { ok: true, body: { query: shape.query.trim(), limit } };
}

function activeKeys(deps: PluginsApiDeps): Set<string> {
	const list = listEnabledPlugins(deps.settingsPath);
	return new Set(Object.keys(list.active));
}

function fuzzyScore(query: string, plugin: { name: string; description: string; category: string | null }): number {
	const q = query.toLowerCase();
	const tokens = q.split(/\s+/).filter(Boolean);
	let score = 0;
	const haystack = `${plugin.name} ${plugin.description} ${plugin.category ?? ""}`.toLowerCase();
	for (const token of tokens) {
		if (plugin.name.toLowerCase().includes(token)) score += 5;
		if ((plugin.category ?? "").toLowerCase().includes(token)) score += 3;
		if (haystack.includes(token)) score += 1;
	}
	return score;
}

export async function handlePluginsApi(req: Request, url: URL, deps: PluginsApiDeps): Promise<Response | null> {
	const pathname = url.pathname;

	// GET /ui/api/plugins/marketplace
	if (pathname === "/ui/api/plugins/marketplace" && req.method === "GET") {
		try {
			const catalog = await getCatalog({
				db: deps.db,
				fetcher: deps.fetcher,
				activeKeys: activeKeys(deps),
				overlayPath: deps.overlayPath,
				forceRefresh: url.searchParams.get("refresh") === "1",
			});
			return json({
				marketplace: catalog.marketplace,
				plugins: catalog.plugins,
				hidden_by_transport: catalog.hidden_by_transport,
				fetched_at: catalog.fetched_at,
				cache_hit: catalog.cache_hit,
				from_stale_cache: catalog.from_stale_cache,
			});
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			return json({ error: msg }, { status: 502 });
		}
	}

	// GET /ui/api/plugins
	if (pathname === "/ui/api/plugins" && req.method === "GET") {
		const list = listEnabledPlugins(deps.settingsPath);
		return json({
			active: Object.keys(list.active).sort(),
			disabled: list.disabled.sort(),
		});
	}

	// POST /ui/api/plugins/install
	if (pathname === "/ui/api/plugins/install" && req.method === "POST") {
		const raw = await readJson(req);
		if (raw && typeof raw === "object" && "__error" in raw) {
			return json({ error: (raw as { __error: string }).__error }, { status: 400 });
		}
		const parsed = parseInstallBody(raw);
		if (!parsed.ok) {
			return json({ error: parsed.error }, { status: 422 });
		}
		const { plugin, marketplace } = parsed.body;
		let key: string;
		try {
			key = formatPluginKey(plugin, marketplace ?? OFFICIAL_MARKETPLACE_ID);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			return json({ error: msg }, { status: 422 });
		}

		// Look up the upstream entry so we can record the source URL in the audit.
		let sourceType: string | null = null;
		let sourceUrl: string | null = null;
		try {
			const catalog = await getCatalog({
				db: deps.db,
				fetcher: deps.fetcher,
				activeKeys: activeKeys(deps),
				overlayPath: deps.overlayPath,
			});
			const entry = catalog.plugins.find(
				(p) => p.name === plugin && p.marketplace === (marketplace ?? OFFICIAL_MARKETPLACE_ID),
			);
			if (!entry) {
				return json(
					{ error: `Plugin ${plugin} not found in marketplace ${marketplace ?? OFFICIAL_MARKETPLACE_ID}` },
					{ status: 404 },
				);
			}
			sourceType = entry.source_type;
			sourceUrl = entry.source_url;
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			return json({ error: `Marketplace unreachable: ${msg}` }, { status: 502 });
		}

		const result = installPlugin(key, deps.settingsPath);
		if (!result.ok) {
			return json({ error: result.error }, { status: result.status });
		}

		recordPluginInstall(deps.db, {
			plugin,
			marketplace: marketplace ?? OFFICIAL_MARKETPLACE_ID,
			action: result.already_installed ? "reinstall" : "install",
			sourceType,
			sourceUrl,
			previousValue: result.previous_value,
			newValue: result.new_value,
			actor: "user",
		});

		return json({
			ok: true,
			key,
			already_installed: result.already_installed,
			previous_value: result.previous_value,
			new_value: result.new_value,
			source_type: sourceType,
			source_url: sourceUrl,
		});
	}

	// POST /ui/api/plugins/find
	if (pathname === "/ui/api/plugins/find" && req.method === "POST") {
		const raw = await readJson(req);
		if (raw && typeof raw === "object" && "__error" in raw) {
			return json({ error: (raw as { __error: string }).__error }, { status: 400 });
		}
		const parsed = parseFindBody(raw);
		if (!parsed.ok) {
			return json({ error: parsed.error }, { status: 422 });
		}
		try {
			const catalog = await getCatalog({
				db: deps.db,
				fetcher: deps.fetcher,
				activeKeys: activeKeys(deps),
				overlayPath: deps.overlayPath,
			});
			const scored = catalog.plugins
				.map((p) => ({ plugin: p, score: fuzzyScore(parsed.body.query, p) }))
				.filter((s) => s.score > 0)
				.sort((a, b) => b.score - a.score)
				.slice(0, parsed.body.limit ?? 5);
			return json({
				query: parsed.body.query,
				results: scored.map((s) => ({
					name: s.plugin.name,
					marketplace: s.plugin.marketplace,
					description: s.plugin.description,
					source_type: s.plugin.source_type,
					source_url: s.plugin.source_url,
					category: s.plugin.category,
					curated_tags: s.plugin.curated_tags,
					enabled: s.plugin.enabled,
					score: s.score,
				})),
			});
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			return json({ error: `Marketplace unreachable: ${msg}` }, { status: 502 });
		}
	}

	// /ui/api/plugins/<plugin@marketplace>/audit
	const auditMatch = pathname.match(/^\/ui\/api\/plugins\/([^/]+)\/audit$/);
	if (auditMatch) {
		const decoded = decodeURIComponent(auditMatch[1]);
		const parsed = parsePluginKey(decoded);
		if (!parsed) {
			return json({ error: `Invalid plugin key: ${decoded}` }, { status: 422 });
		}
		if (req.method === "GET") {
			const rows = listPluginAudit(deps.db, { plugin: parsed.plugin, marketplace: parsed.marketplace });
			return json({ key: decoded, audit: rows });
		}
		return json({ error: "Method not allowed" }, { status: 405 });
	}

	// /ui/api/plugins/<plugin@marketplace>
	const itemMatch = pathname.match(/^\/ui\/api\/plugins\/([^/]+)$/);
	if (itemMatch) {
		const decoded = decodeURIComponent(itemMatch[1]);
		const parsed = parsePluginKey(decoded);
		if (!parsed) {
			return json({ error: `Invalid plugin key: ${decoded}` }, { status: 422 });
		}
		if (req.method === "DELETE") {
			const result = uninstallPlugin(decoded, deps.settingsPath);
			if (!result.ok) {
				return json({ error: result.error }, { status: result.status });
			}
			recordPluginInstall(deps.db, {
				plugin: parsed.plugin,
				marketplace: parsed.marketplace,
				action: "uninstall",
				sourceType: null,
				sourceUrl: null,
				previousValue: result.previous_value,
				newValue: result.new_value,
				actor: "user",
			});
			return json({
				ok: true,
				key: decoded,
				was_active: result.was_active,
				previous_value: result.previous_value,
				new_value: result.new_value,
			});
		}
		return json({ error: "Method not allowed" }, { status: 405 });
	}

	return null;
}
