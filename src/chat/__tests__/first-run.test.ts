import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MIGRATIONS } from "../../db/schema.ts";
import { revokeAllSessions } from "../../ui/session.ts";
import { checkBootstrapMagicHash, handleFirstRun } from "../first-run.ts";

let db: Database;
const originalEnv = { ...process.env };

beforeEach(() => {
	db = new Database(":memory:");
	for (const migration of MIGRATIONS) {
		db.run(migration);
	}
	// Ensure the secrets table migration ran (migration index 7)
	// and the first_run_state table (migration index 40)

	process.env.OWNER_EMAIL = "owner@example.com";
	process.env.RESEND_API_KEY = undefined;
});

afterEach(() => {
	revokeAllSessions();
	db.close();
	process.env.OWNER_EMAIL = originalEnv.OWNER_EMAIL;
	process.env.RESEND_API_KEY = originalEnv.RESEND_API_KEY;
});

describe("handleFirstRun", () => {
	test("skips when OWNER_EMAIL is not set", async () => {
		process.env.OWNER_EMAIL = undefined;
		// Should not throw, just log error and return
		await handleFirstRun(db, { name: "TestAgent" });
		const state = db.query("SELECT * FROM first_run_state WHERE id = 1").get() as Record<string, unknown> | null;
		// Row may or may not exist, but no email should have been sent
		expect(state?.email_sent_at ?? null).toBeNull();
	});

	test("prints bootstrap banner without Resend", async () => {
		const config = { name: "TestAgent" };
		await handleFirstRun(db, config);

		const state = db.query("SELECT * FROM first_run_state WHERE id = 1").get() as Record<string, unknown>;
		expect(state).toBeTruthy();
		expect(state.stdout_printed_at).not.toBeNull();
		expect(state.bootstrap_magic_hash).not.toBeNull();
	});

	test("does not re-print banner on second boot", async () => {
		const config = { name: "TestAgent" };
		await handleFirstRun(db, config);

		const state1 = db.query("SELECT stdout_printed_at FROM first_run_state WHERE id = 1").get() as {
			stdout_printed_at: string;
		};
		const firstPrintedAt = state1.stdout_printed_at;

		// Second boot
		await handleFirstRun(db, config);

		const state2 = db.query("SELECT stdout_printed_at FROM first_run_state WHERE id = 1").get() as {
			stdout_printed_at: string;
		};
		expect(state2.stdout_printed_at).toBe(firstPrintedAt);
	});

	test("prints link with public_url when available", async () => {
		const config = { name: "TestAgent", public_url: "https://phantom.example.com" };
		await handleFirstRun(db, config);

		const state = db.query("SELECT * FROM first_run_state WHERE id = 1").get() as Record<string, unknown>;
		expect(state.stdout_printed_at).not.toBeNull();
	});
});

describe("checkBootstrapMagicHash", () => {
	test("returns false when no hash stored", () => {
		db.run("INSERT OR IGNORE INTO first_run_state (id) VALUES (1)");
		expect(checkBootstrapMagicHash(db, "any-token")).toBe(false);
	});

	test("returns false for wrong token", async () => {
		await handleFirstRun(db, { name: "TestAgent" });
		expect(checkBootstrapMagicHash(db, "wrong-token")).toBe(false);
	});

	test("consumes the hash (one-time use)", async () => {
		// We need to intercept the magic token. We can test the hash path
		// by directly inserting a known hash.
		const { createHash } = await import("node:crypto");
		const knownToken = "test-magic-token-12345";
		const hash = createHash("sha256").update(knownToken).digest("hex");

		db.run("INSERT OR IGNORE INTO first_run_state (id) VALUES (1)");
		db.run("UPDATE first_run_state SET bootstrap_magic_hash = ?, stdout_printed_at = datetime('now') WHERE id = 1", [
			hash,
		]);

		// First use succeeds
		expect(checkBootstrapMagicHash(db, knownToken)).toBe(true);

		// Second use fails (consumed)
		expect(checkBootstrapMagicHash(db, knownToken)).toBe(false);
	});
});
