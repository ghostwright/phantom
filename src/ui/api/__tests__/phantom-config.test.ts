// Tests for the /ui/api/phantom-config endpoints. Exercise each contract
// line from src/ui/api/phantom-config.ts end to end: GET returns the
// projection, PUT performs atomic writes, secrets cannot be smuggled
// through, the mid-write failure path leaves the original file intact,
// and the audit drawer returns newest-first rows with a bounded limit.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { MIGRATIONS } from "../../../db/schema.ts";
import {
	clearPhantomConfigPathsForTests,
	handleUiRequest,
	setDashboardDb,
	setPhantomConfigPaths,
	setPublicDir,
} from "../../serve.ts";
import { createSession, revokeAllSessions } from "../../session.ts";

setPublicDir(resolve(import.meta.dir, "../../../../public"));

function runMigrations(target: Database): void {
	for (const migration of MIGRATIONS) {
		try {
			target.run(migration);
		} catch {
			// ignore idempotent ALTER failures on repeated runs
		}
	}
}

function seedPhantomYaml(path: string, overrides: Record<string, unknown> = {}): void {
	const base = {
		name: "phantom",
		port: 3100,
		role: "swe",
		model: "claude-opus-4-7",
		effort: "max",
		max_budget_usd: 0,
		timeout_minutes: 240,
		...overrides,
	};
	const lines = Object.entries(base)
		.map(([k, v]) => {
			if (typeof v === "string") return `${k}: ${v}`;
			if (typeof v === "number") return `${k}: ${v}`;
			if (typeof v === "boolean") return `${k}: ${v}`;
			return `${k}: ${JSON.stringify(v)}`;
		})
		.join("\n");
	writeFileSync(path, `${lines}\n`, "utf-8");
}

function seedChannelsYaml(path: string): void {
	const body = [
		"slack:",
		"  enabled: true",
		"  bot_token: xoxb-test-12345678901234567890",
		"  app_token: xapp-test-12345678901234567890",
		"  owner_user_id: U12345",
	].join("\n");
	writeFileSync(path, `${body}\n`, "utf-8");
}

function seedMemoryYaml(path: string): void {
	const body = [
		"qdrant:",
		"  url: http://localhost:6333",
		"ollama:",
		"  url: http://localhost:11434",
		"  model: nomic-embed-text",
		"collections:",
		"  episodes: episodes",
		"  semantic_facts: semantic_facts",
		"  procedures: procedures",
		"embedding:",
		"  dimensions: 768",
		"  batch_size: 32",
		"context:",
		"  max_tokens: 50000",
		"  episode_limit: 10",
		"  fact_limit: 20",
		"  procedure_limit: 5",
	].join("\n");
	writeFileSync(path, `${body}\n`, "utf-8");
}

let db: Database;
let sessionToken: string;
let tmpDir: string;
let phantomYamlPath: string;
let channelsYamlPath: string;
let memoryYamlPath: string;
let evolutionMetaPath: string;
let memoryYamlRealPath: string;
let prevCwd: string;

beforeEach(() => {
	db = new Database(":memory:");
	runMigrations(db);
	setDashboardDb(db);
	sessionToken = createSession().sessionToken;
	tmpDir = mkdtempSync(join(tmpdir(), "phantom-config-test-"));
	mkdirSync(join(tmpDir, "config"), { recursive: true });
	mkdirSync(join(tmpDir, "phantom-config", "meta"), { recursive: true });
	phantomYamlPath = join(tmpDir, "config", "phantom.yaml");
	channelsYamlPath = join(tmpDir, "config", "channels.yaml");
	memoryYamlPath = join(tmpDir, "config", "memory.yaml");
	evolutionMetaPath = join(tmpDir, "phantom-config", "meta", "evolution.json");
	seedPhantomYaml(phantomYamlPath);
	seedChannelsYaml(channelsYamlPath);
	seedMemoryYaml(memoryYamlPath);
	// memory.yaml path is currently hardcoded in the handler because it is
	// also shared with src/memory/config.ts. For the test, swap cwd so the
	// relative "config/memory.yaml" resolves inside the tmp dir.
	prevCwd = process.cwd();
	process.chdir(tmpDir);
	memoryYamlRealPath = resolve("config/memory.yaml");
	setPhantomConfigPaths({
		phantomYaml: phantomYamlPath,
		channelsYaml: channelsYamlPath,
		evolutionMeta: evolutionMetaPath,
	});
});

afterEach(() => {
	clearPhantomConfigPathsForTests();
	db.close();
	revokeAllSessions();
	process.chdir(prevCwd);
	rmSync(tmpDir, { recursive: true, force: true });
});

function req(path: string, init?: RequestInit): Request {
	return new Request(`http://localhost${path}`, {
		...init,
		headers: {
			Cookie: `phantom_session=${encodeURIComponent(sessionToken)}`,
			Accept: "application/json",
			"Content-Type": "application/json",
			...((init?.headers as Record<string, string>) ?? {}),
		},
	});
}

describe("phantom-config API", () => {
	test("401 without session cookie", async () => {
		const res = await handleUiRequest(
			new Request("http://localhost/ui/api/phantom-config", { headers: { Accept: "application/json" } }),
		);
		expect(res.status).toBe(401);
	});

	test("GET returns the projected config and a null audit summary on first load", async () => {
		const res = await handleUiRequest(req("/ui/api/phantom-config"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			config: {
				name: string;
				model: string;
				permissions: { allow: string[] };
				channels: { slack: { enabled: boolean } };
			};
			audit: { last_modified_at: string | null; last_modified_by: string | null };
		};
		expect(body.config.name).toBe("phantom");
		expect(body.config.model).toBe("claude-opus-4-7");
		expect(body.config.permissions.allow).toEqual([]);
		expect(body.config.channels.slack.enabled).toBe(true);
		expect(body.audit.last_modified_at).toBeNull();
		expect(body.audit.last_modified_by).toBeNull();
	});

	test("GET response omits every env-only secret", async () => {
		// The Slack channel has bot_token and app_token in channels.yaml. The
		// endpoint MUST NOT leak them through the JSON payload.
		const res = await handleUiRequest(req("/ui/api/phantom-config"));
		const body = (await res.json()) as { config: Record<string, unknown> };
		const serialized = JSON.stringify(body);
		expect(serialized).not.toContain("xoxb-");
		expect(serialized).not.toContain("xapp-");
		expect(serialized).not.toContain("bot_token");
		expect(serialized).not.toContain("app_token");
	});

	test("PUT updates phantom.yaml atomically and writes one audit row", async () => {
		const before = readFileSync(phantomYamlPath, "utf-8");
		expect(before).toContain("name: phantom");

		const res = await handleUiRequest(
			req("/ui/api/phantom-config", {
				method: "PUT",
				body: JSON.stringify({ name: "ghost" }),
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { config: { name: string }; dirty_keys: string[] };
		expect(body.config.name).toBe("ghost");
		expect(body.dirty_keys).toEqual(["name"]);

		const after = readFileSync(phantomYamlPath, "utf-8");
		const parsed = parseYaml(after) as Record<string, unknown>;
		expect(parsed.name).toBe("ghost");
		expect(parsed.model).toBe("claude-opus-4-7");

		const auditRows = db
			.query("SELECT field, section, actor, previous_value, new_value FROM settings_audit_log ORDER BY id DESC")
			.all() as Array<{ field: string; section: string; actor: string; previous_value: string; new_value: string }>;
		expect(auditRows.length).toBe(1);
		expect(auditRows[0].field).toBe("name");
		expect(auditRows[0].section).toBe("identity");
		expect(auditRows[0].actor).toBe("user");
		expect(JSON.parse(auditRows[0].previous_value)).toBe("phantom");
		expect(JSON.parse(auditRows[0].new_value)).toBe("ghost");
	});

	test("PUT with nested permissions patch preserves sibling fields", async () => {
		// First save: set permissions.allow and permissions.default_mode to a
		// value that differs from the default (acceptEdits).
		const first = await handleUiRequest(
			req("/ui/api/phantom-config", {
				method: "PUT",
				body: JSON.stringify({
					permissions: { allow: ["Bash(git:*)"], default_mode: "acceptEdits" },
				}),
			}),
		);
		expect(first.status).toBe(200);

		// Second save: touch only permissions.deny. The previously-set allow
		// and default_mode must survive.
		const second = await handleUiRequest(
			req("/ui/api/phantom-config", {
				method: "PUT",
				body: JSON.stringify({ permissions: { deny: ["Bash(rm:*)"] } }),
			}),
		);
		expect(second.status).toBe(200);

		const finalYaml = parseYaml(readFileSync(phantomYamlPath, "utf-8")) as {
			permissions: { allow: string[]; deny: string[]; default_mode: string };
		};
		expect(finalYaml.permissions.allow).toEqual(["Bash(git:*)"]);
		expect(finalYaml.permissions.deny).toEqual(["Bash(rm:*)"]);
		expect(finalYaml.permissions.default_mode).toBe("acceptEdits");

		// Exactly three audit rows (allow, default_mode, deny), one per dirty
		// field. No spurious rows for slices the caller did not touch.
		const count = db.query("SELECT COUNT(*) AS n FROM settings_audit_log").get() as { n: number };
		expect(count.n).toBe(3);
	});

	test("PUT with out-of-range budget returns 400 and a field path", async () => {
		const res = await handleUiRequest(
			req("/ui/api/phantom-config", {
				method: "PUT",
				body: JSON.stringify({ max_budget_usd: -5 }),
			}),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; field: string };
		expect(body.field).toBe("max_budget_usd");
		expect(body.error).toContain("max_budget_usd");

		// No audit row, no on-disk change.
		const yamlAfter = readFileSync(phantomYamlPath, "utf-8");
		expect(yamlAfter).toContain("name: phantom");
		const count = db.query("SELECT COUNT(*) AS n FROM settings_audit_log").get() as { n: number };
		expect(count.n).toBe(0);
	});

	test("PUT with unknown top-level key returns 400 (strict schema)", async () => {
		const res = await handleUiRequest(
			req("/ui/api/phantom-config", {
				method: "PUT",
				body: JSON.stringify({ surprise_field: "nope" }),
			}),
		);
		expect(res.status).toBe(400);
		const count = db.query("SELECT COUNT(*) AS n FROM settings_audit_log").get() as { n: number };
		expect(count.n).toBe(0);
	});

	test("PUT attempting to set ANTHROPIC_API_KEY rejects at the schema layer", async () => {
		const res = await handleUiRequest(
			req("/ui/api/phantom-config", {
				method: "PUT",
				body: JSON.stringify({ ANTHROPIC_API_KEY: "sk-ant-test" }),
			}),
		);
		expect(res.status).toBe(400);
		const yamlAfter = readFileSync(phantomYamlPath, "utf-8");
		expect(yamlAfter).not.toContain("ANTHROPIC_API_KEY");
		expect(yamlAfter).not.toContain("sk-ant-test");
	});

	test("PUT attempting to write channels.slack.bot_token rejects at the schema layer", async () => {
		const res = await handleUiRequest(
			req("/ui/api/phantom-config", {
				method: "PUT",
				body: JSON.stringify({
					channels: { slack: { enabled: true, bot_token: "xoxb-evil" } },
				}),
			}),
		);
		expect(res.status).toBe(400);
		// channels.yaml must be byte-unchanged; the existing token is still in place.
		const channelsAfter = readFileSync(channelsYamlPath, "utf-8");
		expect(channelsAfter).toContain("xoxb-test-12345678901234567890");
		expect(channelsAfter).not.toContain("xoxb-evil");
	});

	test("PUT does not touch disk when mid-write rename fails; original phantom.yaml is byte-identical", async () => {
		// Simulate a filesystem crash between temp write and rename by handing
		// the handler a rename stub that throws.
		setPhantomConfigPaths({
			phantomYaml: phantomYamlPath,
			channelsYaml: channelsYamlPath,
			evolutionMeta: evolutionMetaPath,
		});
		const before = readFileSync(phantomYamlPath, "utf-8");
		const beforeStat = statSync(phantomYamlPath);

		// Inject the failing rename by extending the deps directly via a wrapper.
		// We re-import the handler bypassing the serve.ts dispatcher for this
		// one case so the renameImpl seam is reachable.
		const { handlePhantomConfigApi } = await import("../phantom-config.ts");
		const res = await handlePhantomConfigApi(
			new Request("http://localhost/ui/api/phantom-config", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "ghost" }),
			}),
			new URL("http://localhost/ui/api/phantom-config"),
			{
				db,
				paths: {
					phantomYaml: phantomYamlPath,
					channelsYaml: channelsYamlPath,
					evolutionMeta: evolutionMetaPath,
				},
				renameImpl: () => {
					throw new Error("simulated rename failure");
				},
			},
		);
		expect(res?.status).toBe(500);

		const after = readFileSync(phantomYamlPath, "utf-8");
		const afterStat = statSync(phantomYamlPath);
		expect(after).toBe(before);
		expect(afterStat.size).toBe(beforeStat.size);

		// No audit row, no temp file left behind.
		const count = db.query("SELECT COUNT(*) AS n FROM settings_audit_log").get() as { n: number };
		expect(count.n).toBe(0);
	});

	test("PUT with no net change returns 200 and writes no audit rows", async () => {
		const res = await handleUiRequest(
			req("/ui/api/phantom-config", {
				method: "PUT",
				body: JSON.stringify({ name: "phantom" }),
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { dirty_keys: string[] };
		expect(body.dirty_keys).toEqual([]);
		const count = db.query("SELECT COUNT(*) AS n FROM settings_audit_log").get() as { n: number };
		expect(count.n).toBe(0);
	});

	test("PUT evolution cadence writes phantom-config/meta/evolution.json", async () => {
		const res = await handleUiRequest(
			req("/ui/api/phantom-config", {
				method: "PUT",
				body: JSON.stringify({ evolution: { cadence_minutes: 45 } }),
			}),
		);
		expect(res.status).toBe(200);
		const metaRaw = readFileSync(evolutionMetaPath, "utf-8");
		const meta = JSON.parse(metaRaw) as { cadence_minutes: number };
		expect(meta.cadence_minutes).toBe(45);

		const yamlAfter = parseYaml(readFileSync(phantomYamlPath, "utf-8")) as { evolution: { cadence_minutes: number } };
		expect(yamlAfter.evolution.cadence_minutes).toBe(45);
	});

	test("PUT channels.slack.enabled=false writes channels.yaml and preserves secrets", async () => {
		const res = await handleUiRequest(
			req("/ui/api/phantom-config", {
				method: "PUT",
				body: JSON.stringify({ channels: { slack: { enabled: false } } }),
			}),
		);
		expect(res.status).toBe(200);
		const after = readFileSync(channelsYamlPath, "utf-8");
		// Secret is preserved; enabled flipped.
		expect(after).toContain("xoxb-test-12345678901234567890");
		expect(after).toContain("enabled: false");
	});

	test("PUT memory.episode_limit writes config/memory.yaml and preserves collections block", async () => {
		// The handler reads relative path "config/memory.yaml", and the test
		// cwd is tmpDir from beforeEach.
		const res = await handleUiRequest(
			req("/ui/api/phantom-config", {
				method: "PUT",
				body: JSON.stringify({ memory: { episode_limit: 25 } }),
			}),
		);
		expect(res.status).toBe(200);
		const yaml = parseYaml(readFileSync(memoryYamlRealPath, "utf-8")) as {
			context: { episode_limit: number; max_tokens: number };
			collections: { episodes: string };
		};
		expect(yaml.context.episode_limit).toBe(25);
		expect(yaml.context.max_tokens).toBe(50000);
		expect(yaml.collections.episodes).toBe("episodes");
	});

	test("GET /audit returns rows newest-first with a bounded limit", async () => {
		for (let i = 0; i < 25; i++) {
			db.run(
				"INSERT INTO settings_audit_log (field, previous_value, new_value, actor, section) VALUES (?, ?, ?, ?, ?)",
				[`field_${i}`, JSON.stringify(i), JSON.stringify(i + 1), "user", "identity"],
			);
		}
		const res = await handleUiRequest(req("/ui/api/phantom-config/audit?limit=10"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { entries: Array<{ id: number; field: string }> };
		expect(body.entries.length).toBe(10);
		expect(body.entries[0].field).toBe("field_24");
		expect(body.entries[9].field).toBe("field_15");
	});

	test("GET /audit caps limit at the hard ceiling", async () => {
		for (let i = 0; i < 150; i++) {
			db.run(
				"INSERT INTO settings_audit_log (field, previous_value, new_value, actor, section) VALUES (?, ?, ?, ?, ?)",
				[`f_${i}`, null, null, "user", "identity"],
			);
		}
		const res = await handleUiRequest(req("/ui/api/phantom-config/audit?limit=500"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { entries: unknown[] };
		// 500 is above the ceiling of 100.
		expect(body.entries.length).toBe(100);
	});

	test("GET /audit rejects non-positive limit", async () => {
		const res = await handleUiRequest(req("/ui/api/phantom-config/audit?limit=-1"));
		expect(res.status).toBe(400);
	});

	test("POST on /phantom-config returns 405", async () => {
		const res = await handleUiRequest(req("/ui/api/phantom-config", { method: "POST", body: JSON.stringify({}) }));
		expect(res.status).toBe(405);
	});

	test("DELETE on /phantom-config returns 405", async () => {
		const res = await handleUiRequest(req("/ui/api/phantom-config", { method: "DELETE" }));
		expect(res.status).toBe(405);
	});

	test("GET sees audit summary populated after a save", async () => {
		await handleUiRequest(
			req("/ui/api/phantom-config", {
				method: "PUT",
				body: JSON.stringify({ name: "ghost" }),
			}),
		);
		const res = await handleUiRequest(req("/ui/api/phantom-config"));
		const body = (await res.json()) as {
			audit: { last_modified_at: string | null; last_modified_by: string | null };
		};
		expect(body.audit.last_modified_by).toBe("user");
		expect(body.audit.last_modified_at).not.toBeNull();
	});

	test("Two sequential PUTs last-write-wins without dropping either audit row", async () => {
		const first = await handleUiRequest(
			req("/ui/api/phantom-config", {
				method: "PUT",
				body: JSON.stringify({ max_budget_usd: 100 }),
			}),
		);
		expect(first.status).toBe(200);
		const second = await handleUiRequest(
			req("/ui/api/phantom-config", {
				method: "PUT",
				body: JSON.stringify({ max_budget_usd: 200 }),
			}),
		);
		expect(second.status).toBe(200);
		const body = (await second.json()) as { config: { max_budget_usd: number } };
		expect(body.config.max_budget_usd).toBe(200);
		const rows = db.query("SELECT new_value FROM settings_audit_log ORDER BY id ASC").all() as Array<{
			new_value: string;
		}>;
		expect(rows.length).toBe(2);
		expect(JSON.parse(rows[0].new_value)).toBe(100);
		expect(JSON.parse(rows[1].new_value)).toBe(200);
	});

	test("Malformed phantom.yaml returns 500", async () => {
		writeFileSync(phantomYamlPath, "{{ this is: not yaml", "utf-8");
		const res = await handleUiRequest(req("/ui/api/phantom-config"));
		expect(res.status).toBe(500);
	});

	test("Invalid JSON body on PUT returns 400", async () => {
		const res = await handleUiRequest(req("/ui/api/phantom-config", { method: "PUT", body: "{ not json" }));
		expect(res.status).toBe(400);
	});

	test("Non-memory PUT does not read memory.yaml (tolerates a malformed memory.yaml)", async () => {
		// Corrupt memory.yaml. A non-memory save (e.g. model) must still succeed
		// and not brick unrelated fields just because memory.yaml is broken.
		writeFileSync(memoryYamlRealPath, "{{ absolutely: not yaml {{", "utf-8");
		const res = await handleUiRequest(
			req("/ui/api/phantom-config", {
				method: "PUT",
				body: JSON.stringify({ model: "claude-sonnet-4-6" }),
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { config: { model: string } };
		expect(body.config.model).toBe("claude-sonnet-4-6");
	});

	test("Memory PUT DOES read memory.yaml and surfaces parse failure as 500", async () => {
		writeFileSync(memoryYamlRealPath, "{{ absolutely: not yaml {{", "utf-8");
		const res = await handleUiRequest(
			req("/ui/api/phantom-config", {
				method: "PUT",
				body: JSON.stringify({ memory: { episode_limit: 25 } }),
			}),
		);
		expect(res.status).toBe(500);
	});

	test("Audit redacts secret-shape strings pasted into free-form fields", async () => {
		await handleUiRequest(
			req("/ui/api/phantom-config", {
				method: "PUT",
				body: JSON.stringify({ role: "leaked sk-ant-api03-deadbeefabcdef0123456789 role" }),
			}),
		);
		const rows = db
			.query("SELECT new_value FROM settings_audit_log WHERE field = ? ORDER BY id DESC LIMIT 1")
			.all("role") as Array<{ new_value: string }>;
		expect(rows.length).toBe(1);
		const logged = rows[0].new_value;
		expect(logged.includes("sk-ant-api03-deadbeef")).toBe(false);
		expect(logged.includes("[redacted]")).toBe(true);
	});

	test("Audit redacts Slack bot tokens pasted into free-form fields", async () => {
		await handleUiRequest(
			req("/ui/api/phantom-config", {
				method: "PUT",
				body: JSON.stringify({ role: "do not paste xoxb-123456789012-abcdefghij here" }),
			}),
		);
		const rows = db
			.query("SELECT new_value FROM settings_audit_log WHERE field = ? ORDER BY id DESC LIMIT 1")
			.all("role") as Array<{ new_value: string }>;
		const logged = rows[0].new_value;
		expect(logged.includes("xoxb-123456789012")).toBe(false);
		expect(logged.includes("[redacted]")).toBe(true);
	});
});
