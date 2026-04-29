import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MIGRATIONS } from "../../../db/schema.ts";
import { handleUiRequest, setDashboardDb, setPublicDir } from "../../serve.ts";
import { createSession, revokeAllSessions } from "../../session.ts";

setPublicDir(resolve(import.meta.dir, "../../../../public"));

let tmp: string;
let phantomConfigTmp: string;
let db: Database;
let sessionToken: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "phantom-memfiles-api-"));
	phantomConfigTmp = mkdtempSync(join(tmpdir(), "phantom-config-memory-api-"));
	process.env.PHANTOM_MEMORY_FILES_ROOT = tmp;
	// Sandbox the phantom-config memory root too so the walk does not pick up
	// the repo's real agent-notes.md during tests that assert on empty lists.
	process.env.PHANTOM_CONFIG_MEMORY_ROOT = phantomConfigTmp;
	db = new Database(":memory:");
	for (const migration of MIGRATIONS) {
		try {
			db.run(migration);
		} catch {
			// ignore ALTER TABLE duplicate failures
		}
	}
	setDashboardDb(db);
	sessionToken = createSession().sessionToken;
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	rmSync(phantomConfigTmp, { recursive: true, force: true });
	Reflect.deleteProperty(process.env, "PHANTOM_MEMORY_FILES_ROOT");
	Reflect.deleteProperty(process.env, "PHANTOM_CONFIG_MEMORY_ROOT");
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

describe("memory-files API", () => {
	test("401 without session cookie", async () => {
		const res = await handleUiRequest(
			new Request("http://localhost/ui/api/memory-files", { headers: { Accept: "application/json" } }),
		);
		expect(res.status).toBe(401);
	});

	test("GET /ui/api/memory-files returns empty list", async () => {
		const res = await handleUiRequest(req("/ui/api/memory-files"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { files: unknown[] };
		expect(body.files.length).toBe(0);
	});

	test("POST creates a memory file at a nested path", async () => {
		const res = await handleUiRequest(
			req("/ui/api/memory-files", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path: "memory/notes.md", content: "# Notes\n" }),
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { file: { path: string; content: string } };
		expect(body.file.path).toBe("memory/notes.md");
		expect(body.file.content).toBe("# Notes\n");
	});

	test("POST rejects skills/ paths", async () => {
		const res = await handleUiRequest(
			req("/ui/api/memory-files", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path: "skills/evil.md", content: "x" }),
			}),
		);
		expect(res.status).toBe(422);
	});

	test("GET encoded path returns the file", async () => {
		await handleUiRequest(
			req("/ui/api/memory-files", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path: "CLAUDE.md", content: "# Top\n" }),
			}),
		);
		const res = await handleUiRequest(req(`/ui/api/memory-files/${encodeURIComponent("CLAUDE.md")}`));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { file: { path: string; content: string } };
		expect(body.file.path).toBe("CLAUDE.md");
	});

	test("list includes agent-notes.md from phantom-config/memory as read-only", async () => {
		// Item 10: the dashboard memory-files tab surfaces the agent's own
		// append-only notes file so operators can watch the agent learn
		// without SSHing into the VM. The file lives outside the .claude
		// tree and is surfaced via a second, read-only root.
		writeFileSync(
			join(phantomConfigTmp, "agent-notes.md"),
			"# Agent notes\n\nA running log of things the agent has learned.\n",
			"utf-8",
		);

		const res = await handleUiRequest(req("/ui/api/memory-files"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			files: Array<{ path: string; top_level: string; read_only?: boolean; description?: string }>;
		};
		const agentNotes = body.files.find((f) => f.path === "phantom-config/memory/agent-notes.md");
		expect(agentNotes).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: asserted above
		const entry = agentNotes!;
		expect(entry.read_only).toBe(true);
		expect(entry.top_level).toBe("phantom-config");
		expect(entry.description).toContain("append-only");
	});

	test("GET reads agent-notes.md content through the phantom-config virtual path", async () => {
		writeFileSync(
			join(phantomConfigTmp, "agent-notes.md"),
			"# Agent notes\n\nLearned: operator prefers TypeScript.\n",
			"utf-8",
		);
		const res = await handleUiRequest(
			req(`/ui/api/memory-files/${encodeURIComponent("phantom-config/memory/agent-notes.md")}`),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { file: { content: string; read_only?: boolean } };
		expect(body.file.content).toContain("Learned: operator prefers TypeScript");
		expect(body.file.read_only).toBe(true);
	});

	test("PUT to agent-notes.md is rejected because it is read-only in the dashboard", async () => {
		writeFileSync(join(phantomConfigTmp, "agent-notes.md"), "# Agent notes\n", "utf-8");
		const res = await handleUiRequest(
			req(`/ui/api/memory-files/${encodeURIComponent("phantom-config/memory/agent-notes.md")}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content: "clobbered" }),
			}),
		);
		expect(res.status).toBe(400);
	});

	test("PUT updates and DELETE removes", async () => {
		await handleUiRequest(
			req("/ui/api/memory-files", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path: "CLAUDE.md", content: "first" }),
			}),
		);
		const put = await handleUiRequest(
			req(`/ui/api/memory-files/${encodeURIComponent("CLAUDE.md")}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content: "second" }),
			}),
		);
		expect(put.status).toBe(200);
		const del = await handleUiRequest(
			req(`/ui/api/memory-files/${encodeURIComponent("CLAUDE.md")}`, { method: "DELETE" }),
		);
		expect(del.status).toBe(200);
		const list = (await (await handleUiRequest(req("/ui/api/memory-files"))).json()) as { files: unknown[] };
		expect(list.files.length).toBe(0);
	});
});
