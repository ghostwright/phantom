import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../../db/migrate.ts";
import { getHookTrustMap, hasAcceptedHookTrust, listHookAudit, recordHookEdit } from "../audit.ts";

let db: Database;

beforeEach(() => {
	db = new Database(":memory:");
	db.run("PRAGMA journal_mode = WAL");
	db.run("PRAGMA foreign_keys = ON");
	runMigrations(db);
});

describe("hasAcceptedHookTrust per type", () => {
	test("returns false before any trust is recorded", () => {
		expect(hasAcceptedHookTrust(db)).toBe(false);
		expect(hasAcceptedHookTrust(db, "command")).toBe(false);
		expect(hasAcceptedHookTrust(db, "http")).toBe(false);
	});

	test("command trust does not satisfy http trust", () => {
		recordHookEdit(db, {
			event: "<trust>",
			matcher: undefined,
			hookType: "command",
			action: "trust_accepted",
			previousSlice: null,
			newSlice: null,
			definition: null,
			actor: "user",
		});
		expect(hasAcceptedHookTrust(db, "command")).toBe(true);
		expect(hasAcceptedHookTrust(db, "http")).toBe(false);
		expect(hasAcceptedHookTrust(db, "prompt")).toBe(false);
		expect(hasAcceptedHookTrust(db, "agent")).toBe(false);
		// Legacy "any trust" check still fires.
		expect(hasAcceptedHookTrust(db)).toBe(true);
	});

	test("http trust does not satisfy command trust", () => {
		recordHookEdit(db, {
			event: "<trust>",
			matcher: undefined,
			hookType: "http",
			action: "trust_accepted",
			previousSlice: null,
			newSlice: null,
			definition: null,
			actor: "user",
		});
		expect(hasAcceptedHookTrust(db, "http")).toBe(true);
		expect(hasAcceptedHookTrust(db, "command")).toBe(false);
	});

	test("per-type acceptance persists across re-queries", () => {
		recordHookEdit(db, {
			event: "<trust>",
			matcher: undefined,
			hookType: "command",
			action: "trust_accepted",
			previousSlice: null,
			newSlice: null,
			definition: null,
			actor: "user",
		});
		recordHookEdit(db, {
			event: "<trust>",
			matcher: undefined,
			hookType: "prompt",
			action: "trust_accepted",
			previousSlice: null,
			newSlice: null,
			definition: null,
			actor: "user",
		});
		const map = getHookTrustMap(db);
		expect(map.command).toBe(true);
		expect(map.prompt).toBe(true);
		expect(map.agent).toBe(false);
		expect(map.http).toBe(false);
	});
});

describe("recordHookEdit: matcher capture on update and delete", () => {
	test("update rows record the previous matcher so audit lines are unambiguous", () => {
		recordHookEdit(db, {
			event: "PreToolUse",
			matcher: "Bash",
			hookType: "command",
			action: "update",
			previousSlice: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "old" }] }] },
			newSlice: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "new" }] }] },
			definition: { type: "command", command: "new" },
			actor: "user",
		});
		const entries = listHookAudit(db, 10);
		expect(entries.length).toBe(1);
		expect(entries[0].matcher).toBe("Bash");
		expect(entries[0].action).toBe("update");
		expect(entries[0].hook_type).toBe("command");
	});

	test("uninstall rows record both the matcher and the hook_type", () => {
		recordHookEdit(db, {
			event: "PreToolUse",
			matcher: "Write",
			hookType: "http",
			action: "uninstall",
			previousSlice: { PreToolUse: [{ matcher: "Write", hooks: [{ type: "http", url: "https://x" }] }] },
			newSlice: {},
			definition: null,
			actor: "user",
		});
		const entries = listHookAudit(db, 10);
		expect(entries[0].matcher).toBe("Write");
		expect(entries[0].hook_type).toBe("http");
		expect(entries[0].action).toBe("uninstall");
	});

	test("relocate rows capture the previous matcher coordinate", () => {
		recordHookEdit(db, {
			event: "PreToolUse",
			matcher: "Bash",
			hookType: "command",
			action: "relocate",
			previousSlice: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "run" }] }] },
			newSlice: { PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "run" }] }] },
			definition: { type: "command", command: "run" },
			actor: "user",
		});
		const entries = listHookAudit(db, 10);
		expect(entries[0].action).toBe("relocate");
		expect(entries[0].matcher).toBe("Bash");
	});
});
