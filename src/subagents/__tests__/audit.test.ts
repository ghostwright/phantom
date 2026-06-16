import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestDatabase } from "../../db/connection.ts";
import { MIGRATIONS } from "../../db/schema.ts";
import { listSubagentEdits, recordSubagentEdit } from "../audit.ts";

let db: Database;

beforeEach(() => {
	db = createTestDatabase();
	for (const migration of MIGRATIONS) {
		db.run(migration);
	}
});

afterEach(() => {
	db.close();
});

describe("recordSubagentEdit", () => {
	test("inserts a create action", () => {
		recordSubagentEdit(db, {
			name: "test-agent",
			action: "create",
			previousBody: null,
			newBody: "# Test Agent\n\nDo stuff.",
			previousFrontmatterJson: null,
			newFrontmatterJson: JSON.stringify({ name: "test-agent", description: "A test." }),
			actor: "user",
		});
		const rows = db.query("SELECT * FROM subagent_audit_log").all() as { subagent_name: string; action: string }[];
		expect(rows).toHaveLength(1);
		expect(rows[0].subagent_name).toBe("test-agent");
		expect(rows[0].action).toBe("create");
	});

	test("inserts an update action with previous values", () => {
		recordSubagentEdit(db, {
			name: "my-agent",
			action: "update",
			previousBody: "# Old\n\nOld body.",
			newBody: "# New\n\nNew body.",
			previousFrontmatterJson: JSON.stringify({ name: "my-agent", description: "Old desc." }),
			newFrontmatterJson: JSON.stringify({ name: "my-agent", description: "New desc." }),
			actor: "user",
		});
		const rows = db.query("SELECT * FROM subagent_audit_log").all() as {
			previous_body: string | null;
			new_body: string | null;
		}[];
		expect(rows).toHaveLength(1);
		expect(rows[0].previous_body).toBe("# Old\n\nOld body.");
		expect(rows[0].new_body).toBe("# New\n\nNew body.");
	});

	test("inserts a delete action", () => {
		recordSubagentEdit(db, {
			name: "doomed",
			action: "delete",
			previousBody: "# Doomed\n\nGoodbye.",
			newBody: null,
			previousFrontmatterJson: JSON.stringify({ name: "doomed", description: "Will be deleted." }),
			newFrontmatterJson: null,
			actor: "system",
		});
		const rows = db.query("SELECT * FROM subagent_audit_log").all() as { action: string; actor: string }[];
		expect(rows).toHaveLength(1);
		expect(rows[0].action).toBe("delete");
		expect(rows[0].actor).toBe("system");
	});
});

describe("listSubagentEdits", () => {
	test("returns empty array when no edits exist", () => {
		const edits = listSubagentEdits(db);
		expect(edits).toEqual([]);
	});

	test("returns all edits ordered by id DESC", () => {
		recordSubagentEdit(db, {
			name: "agent-a",
			action: "create",
			previousBody: null,
			newBody: "body a",
			previousFrontmatterJson: null,
			newFrontmatterJson: "{}",
			actor: "user",
		});
		recordSubagentEdit(db, {
			name: "agent-b",
			action: "create",
			previousBody: null,
			newBody: "body b",
			previousFrontmatterJson: null,
			newFrontmatterJson: "{}",
			actor: "user",
		});
		const edits = listSubagentEdits(db);
		expect(edits).toHaveLength(2);
		expect(edits[0].subagent_name).toBe("agent-b");
		expect(edits[1].subagent_name).toBe("agent-a");
	});

	test("filters by subagent name", () => {
		recordSubagentEdit(db, {
			name: "agent-a",
			action: "create",
			previousBody: null,
			newBody: "a",
			previousFrontmatterJson: null,
			newFrontmatterJson: "{}",
			actor: "user",
		});
		recordSubagentEdit(db, {
			name: "agent-b",
			action: "create",
			previousBody: null,
			newBody: "b",
			previousFrontmatterJson: null,
			newFrontmatterJson: "{}",
			actor: "user",
		});
		const edits = listSubagentEdits(db, "agent-a");
		expect(edits).toHaveLength(1);
		expect(edits[0].subagent_name).toBe("agent-a");
	});

	test("respects limit parameter", () => {
		for (let i = 0; i < 10; i++) {
			recordSubagentEdit(db, {
				name: "agent",
				action: "update",
				previousBody: `v${i}`,
				newBody: `v${i + 1}`,
				previousFrontmatterJson: null,
				newFrontmatterJson: "{}",
				actor: "user",
			});
		}
		const edits = listSubagentEdits(db, undefined, 3);
		expect(edits).toHaveLength(3);
	});

	test("respects limit with name filter", () => {
		for (let i = 0; i < 10; i++) {
			recordSubagentEdit(db, {
				name: "agent",
				action: "update",
				previousBody: `v${i}`,
				newBody: `v${i + 1}`,
				previousFrontmatterJson: null,
				newFrontmatterJson: "{}",
				actor: "user",
			});
		}
		const edits = listSubagentEdits(db, "agent", 5);
		expect(edits).toHaveLength(5);
	});

	test("includes frontmatter json fields", () => {
		const prevFm = JSON.stringify({ name: "x", description: "old" });
		const newFm = JSON.stringify({ name: "x", description: "new", tools: ["Read"] });
		recordSubagentEdit(db, {
			name: "x",
			action: "update",
			previousBody: "old body",
			newBody: "new body",
			previousFrontmatterJson: prevFm,
			newFrontmatterJson: newFm,
			actor: "user",
		});
		const edits = listSubagentEdits(db, "x");
		expect(edits).toHaveLength(1);
		expect(edits[0].previous_frontmatter_json).toBe(prevFm);
		expect(edits[0].new_frontmatter_json).toBe(newFm);
	});
});
