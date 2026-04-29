import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MIGRATIONS } from "../../../db/schema.ts";
import { __resetCuratedCacheForTests } from "../../../plugins/curated.ts";
import type { FetchMarketplaceFn } from "../../../plugins/marketplace.ts";
import {
	clearPluginsApiOverridesForTests,
	handleUiRequest,
	setDashboardDb,
	setPluginsApiOverridesForTests,
	setPublicDir,
} from "../../serve.ts";
import { createSession, revokeAllSessions } from "../../session.ts";

setPublicDir(resolve(import.meta.dir, "../../../../public"));

const FIXTURE_BODY = JSON.stringify({
	$schema: "https://anthropic.com/claude-code/marketplace.schema.json",
	name: "claude-plugins-official",
	owner: { name: "Anthropic" },
	plugins: [
		{
			name: "notion",
			description: "Notion workspace integration.",
			category: "productivity",
			source: { source: "url", url: "https://github.com/makenotion/claude-code-notion-plugin.git" },
		},
		{
			name: "linear",
			description: "Linear issue tracking.",
			category: "productivity",
			source: "./external_plugins/linear",
		},
		{
			name: "expo",
			description: "Expo skills.",
			source: { source: "git-subdir", url: "expo/skills" },
		},
	],
});

const fixtureFetcher: FetchMarketplaceFn = async () => ({ ok: true, body: FIXTURE_BODY, etag: "x" });

let tmp: string;
let settingsPath: string;
let overlayPath: string;
let db: Database;
let sessionToken: string;

beforeEach(() => {
	__resetCuratedCacheForTests();
	tmp = mkdtempSync(join(tmpdir(), "phantom-plugins-api-"));
	settingsPath = join(tmp, "settings.json");
	overlayPath = join(tmp, "curated.json");
	writeFileSync(overlayPath, '{"version":1,"plugins":{}}');
	db = new Database(":memory:");
	for (const migration of MIGRATIONS) {
		try {
			db.run(migration);
		} catch {
			// ignore
		}
	}
	setDashboardDb(db);
	setPluginsApiOverridesForTests({ fetcher: fixtureFetcher, settingsPath, overlayPath });
	sessionToken = createSession().sessionToken;
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	clearPluginsApiOverridesForTests();
	db.close();
	revokeAllSessions();
});

function req(path: string, init?: RequestInit): Request {
	return new Request(`http://localhost${path}`, {
		...init,
		headers: {
			Cookie: `phantom_session=${encodeURIComponent(sessionToken)}`,
			Accept: "application/json",
			...((init?.headers as Record<string, string>) ?? {}),
		},
	});
}

describe("plugins API", () => {
	test("401 without session cookie", async () => {
		const res = await handleUiRequest(
			new Request("http://localhost/ui/api/plugins/marketplace", { headers: { Accept: "application/json" } }),
		);
		expect(res.status).toBe(401);
	});

	test("GET marketplace returns normalized catalog", async () => {
		const res = await handleUiRequest(req("/ui/api/plugins/marketplace"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			marketplace: string;
			plugins: Array<{ name: string; enabled: boolean; source_type: string }>;
			hidden_by_transport: number;
		};
		expect(body.marketplace).toBe("claude-plugins-official");
		// 3 fixtures, expo filtered -> 2 visible
		expect(body.plugins).toHaveLength(2);
		expect(body.hidden_by_transport).toBe(1);
		const names = body.plugins.map((p) => p.name).sort();
		expect(names).toEqual(["linear", "notion"]);
	});

	test("GET /ui/api/plugins returns empty active list initially", async () => {
		const res = await handleUiRequest(req("/ui/api/plugins"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { active: string[]; disabled: string[] };
		expect(body.active).toEqual([]);
		expect(body.disabled).toEqual([]);
	});

	test("POST install writes settings.json and audit", async () => {
		const res = await handleUiRequest(
			req("/ui/api/plugins/install", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ plugin: "notion" }),
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; key: string; already_installed: boolean };
		expect(body.ok).toBe(true);
		expect(body.key).toBe("notion@claude-plugins-official");
		expect(body.already_installed).toBe(false);
		const written = JSON.parse(readFileSync(settingsPath, "utf-8"));
		expect(written.enabledPlugins["notion@claude-plugins-official"]).toBe(true);
	});

	test("POST install is idempotent on second call", async () => {
		await handleUiRequest(
			req("/ui/api/plugins/install", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ plugin: "notion" }),
			}),
		);
		const res = await handleUiRequest(
			req("/ui/api/plugins/install", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ plugin: "notion" }),
			}),
		);
		const body = (await res.json()) as { already_installed: boolean };
		expect(body.already_installed).toBe(true);
	});

	test("POST install 404 when plugin not in marketplace", async () => {
		const res = await handleUiRequest(
			req("/ui/api/plugins/install", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ plugin: "ghost" }),
			}),
		);
		expect(res.status).toBe(404);
	});

	test("POST install 422 with missing plugin field", async () => {
		const res = await handleUiRequest(
			req("/ui/api/plugins/install", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ marketplace: "claude-plugins-official" }),
			}),
		);
		expect(res.status).toBe(422);
	});

	test("DELETE soft-uninstalls", async () => {
		await handleUiRequest(
			req("/ui/api/plugins/install", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ plugin: "notion" }),
			}),
		);
		const res = await handleUiRequest(
			req(`/ui/api/plugins/${encodeURIComponent("notion@claude-plugins-official")}`, { method: "DELETE" }),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; was_active: boolean; new_value: unknown };
		expect(body.ok).toBe(true);
		expect(body.was_active).toBe(true);
		expect(body.new_value).toBe(false);
		const written = JSON.parse(readFileSync(settingsPath, "utf-8"));
		expect(written.enabledPlugins["notion@claude-plugins-official"]).toBe(false);
	});

	test("DELETE rejects malformed key", async () => {
		const res = await handleUiRequest(req("/ui/api/plugins/notion-without-marketplace", { method: "DELETE" }));
		expect(res.status).toBe(422);
	});

	test("GET audit returns full timeline for a plugin", async () => {
		await handleUiRequest(
			req("/ui/api/plugins/install", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ plugin: "notion" }),
			}),
		);
		await handleUiRequest(
			req(`/ui/api/plugins/${encodeURIComponent("notion@claude-plugins-official")}`, { method: "DELETE" }),
		);
		const res = await handleUiRequest(
			req(`/ui/api/plugins/${encodeURIComponent("notion@claude-plugins-official")}/audit`),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { audit: Array<{ action: string }> };
		expect(body.audit).toHaveLength(2);
		expect(body.audit[0].action).toBe("uninstall");
		expect(body.audit[1].action).toBe("install");
	});

	test("POST find returns ranked matches", async () => {
		const res = await handleUiRequest(
			req("/ui/api/plugins/find", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ query: "linear" }),
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { results: Array<{ name: string; score: number }> };
		expect(body.results.length).toBeGreaterThan(0);
		expect(body.results[0].name).toBe("linear");
	});

	test("POST find 422 on empty query", async () => {
		const res = await handleUiRequest(
			req("/ui/api/plugins/find", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ query: "" }),
			}),
		);
		expect(res.status).toBe(422);
	});

	test("install records source URL in audit log", async () => {
		await handleUiRequest(
			req("/ui/api/plugins/install", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ plugin: "notion" }),
			}),
		);
		const res = await handleUiRequest(
			req(`/ui/api/plugins/${encodeURIComponent("notion@claude-plugins-official")}/audit`),
		);
		const body = (await res.json()) as { audit: Array<{ source_type: string; source_url: string }> };
		expect(body.audit[0].source_type).toBe("url");
		expect(body.audit[0].source_url).toContain("makenotion");
	});

	test("install preserves unrelated settings.json fields", async () => {
		writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ["Read"] }, model: "claude-opus-4-6" }));
		await handleUiRequest(
			req("/ui/api/plugins/install", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ plugin: "notion" }),
			}),
		);
		const written = JSON.parse(readFileSync(settingsPath, "utf-8"));
		expect(written.permissions).toEqual({ allow: ["Read"] });
		expect(written.model).toBe("claude-opus-4-6");
		expect(written.enabledPlugins["notion@claude-plugins-official"]).toBe(true);
	});
});
