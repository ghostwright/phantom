import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MIGRATIONS } from "../../db/schema.ts";
import { listPluginAudit, recordPluginInstall } from "../audit.ts";

function createTestDb(): Database {
	const db = new Database(":memory:");
	for (const stmt of MIGRATIONS) {
		db.run(stmt);
	}
	return db;
}

let db: Database;

beforeEach(() => {
	db = createTestDb();
});

afterEach(() => {
	db.close();
});

describe("plugin_install_audit_log", () => {
	test("records and lists a single install", () => {
		recordPluginInstall(db, {
			plugin: "notion",
			marketplace: "claude-plugins-official",
			action: "install",
			sourceType: "url",
			sourceUrl: "https://github.com/makenotion/claude-code-notion-plugin.git",
			previousValue: null,
			newValue: true,
			actor: "user",
		});
		const rows = listPluginAudit(db);
		expect(rows).toHaveLength(1);
		expect(rows[0].plugin_name).toBe("notion");
		expect(rows[0].marketplace).toBe("claude-plugins-official");
		expect(rows[0].action).toBe("install");
		expect(rows[0].actor).toBe("user");
		expect(rows[0].new_value).toBe("true");
		expect(rows[0].previous_value).toBeNull();
	});

	test("encodes complex previous/new values as JSON strings", () => {
		recordPluginInstall(db, {
			plugin: "notion",
			marketplace: "claude-plugins-official",
			action: "reinstall",
			sourceType: "url",
			sourceUrl: null,
			previousValue: false,
			newValue: { pinned: "1.2.3" },
			actor: "user",
		});
		const rows = listPluginAudit(db);
		expect(rows[0].previous_value).toBe("false");
		expect(rows[0].new_value).toBe('{"pinned":"1.2.3"}');
	});

	test("orders rows by id desc", () => {
		for (let i = 0; i < 3; i++) {
			recordPluginInstall(db, {
				plugin: "notion",
				marketplace: "claude-plugins-official",
				action: "install",
				sourceType: "url",
				sourceUrl: "https://example.com",
				previousValue: null,
				newValue: true,
				actor: "user",
			});
		}
		const rows = listPluginAudit(db);
		expect(rows).toHaveLength(3);
		expect(rows[0].id).toBeGreaterThan(rows[1].id);
		expect(rows[1].id).toBeGreaterThan(rows[2].id);
	});

	test("filters by plugin name", () => {
		recordPluginInstall(db, {
			plugin: "notion",
			marketplace: "claude-plugins-official",
			action: "install",
			sourceType: "url",
			sourceUrl: null,
			previousValue: null,
			newValue: true,
			actor: "user",
		});
		recordPluginInstall(db, {
			plugin: "linear",
			marketplace: "claude-plugins-official",
			action: "install",
			sourceType: "local",
			sourceUrl: null,
			previousValue: null,
			newValue: true,
			actor: "user",
		});
		expect(listPluginAudit(db, { plugin: "notion" })).toHaveLength(1);
		expect(listPluginAudit(db, { plugin: "linear" })).toHaveLength(1);
		expect(listPluginAudit(db)).toHaveLength(2);
	});

	test("filters by plugin and marketplace together", () => {
		recordPluginInstall(db, {
			plugin: "notion",
			marketplace: "claude-plugins-official",
			action: "install",
			sourceType: "url",
			sourceUrl: null,
			previousValue: null,
			newValue: true,
			actor: "user",
		});
		recordPluginInstall(db, {
			plugin: "notion",
			marketplace: "other-marketplace",
			action: "install",
			sourceType: "url",
			sourceUrl: null,
			previousValue: null,
			newValue: true,
			actor: "user",
		});
		expect(listPluginAudit(db, { plugin: "notion", marketplace: "claude-plugins-official" })).toHaveLength(1);
	});

	test("respects limit", () => {
		for (let i = 0; i < 5; i++) {
			recordPluginInstall(db, {
				plugin: "notion",
				marketplace: "claude-plugins-official",
				action: "install",
				sourceType: "url",
				sourceUrl: null,
				previousValue: null,
				newValue: true,
				actor: "user",
			});
		}
		expect(listPluginAudit(db, { limit: 2 })).toHaveLength(2);
	});
});
