import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MIGRATIONS } from "../../../db/schema.ts";
import { handleUiRequest, setDashboardDb, setPublicDir } from "../../serve.ts";
import { createSession, revokeAllSessions } from "../../session.ts";

setPublicDir(resolve(import.meta.dir, "../../../../public"));

let tmp: string;
let db: Database;
let sessionToken: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "phantom-skills-api-"));
	process.env.PHANTOM_SKILLS_USER_ROOT = tmp;
	db = new Database(":memory:");
	for (const migration of MIGRATIONS) {
		try {
			db.run(migration);
		} catch {
			// ALTER TABLE may fail on a fresh schema; safe to ignore in tests
		}
	}
	setDashboardDb(db);
	const session = createSession();
	sessionToken = session.sessionToken;
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	Reflect.deleteProperty(process.env, "PHANTOM_SKILLS_USER_ROOT");
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

describe("skills API", () => {
	test("401 without session cookie", async () => {
		const res = await handleUiRequest(
			new Request("http://localhost/ui/api/skills", { headers: { Accept: "application/json" } }),
		);
		expect(res.status).toBe(401);
	});

	test("GET /ui/api/skills returns empty list initially", async () => {
		const res = await handleUiRequest(req("/ui/api/skills"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { skills: unknown[]; errors: unknown[] };
		expect(Array.isArray(body.skills)).toBe(true);
		expect(body.skills.length).toBe(0);
	});

	test("POST creates a new skill", async () => {
		const res = await handleUiRequest(
			req("/ui/api/skills", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					frontmatter: {
						name: "mirror",
						description: "weekly",
						when_to_use: "Use on Friday evening when the user asks for a mirror.",
					},
					body: "# Mirror\n\n## Goal\nA goal.\n",
				}),
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { skill: { name: string } };
		expect(body.skill.name).toBe("mirror");
	});

	test("GET /ui/api/skills/:name returns 404 when missing", async () => {
		const res = await handleUiRequest(req("/ui/api/skills/ghost"));
		expect(res.status).toBe(404);
	});

	test("PUT updates and records audit", async () => {
		await handleUiRequest(
			req("/ui/api/skills", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					frontmatter: {
						name: "mirror",
						description: "v1",
						when_to_use: "Use on Friday evening when the user asks.",
					},
					body: "# First\n",
				}),
			}),
		);
		const res = await handleUiRequest(
			req("/ui/api/skills/mirror", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					frontmatter: {
						name: "mirror",
						description: "v2",
						when_to_use: "Use on Friday evening when the user asks.",
					},
					body: "# Second\n",
				}),
			}),
		);
		expect(res.status).toBe(200);
		const rows = db.query("SELECT action, previous_body, new_body FROM skill_audit_log ORDER BY id").all() as Array<{
			action: string;
			previous_body: string | null;
			new_body: string | null;
		}>;
		expect(rows.length).toBeGreaterThanOrEqual(2);
		const update = rows.find((r) => r.action === "update");
		expect(update?.previous_body?.includes("First")).toBe(true);
		expect(update?.new_body?.includes("Second")).toBe(true);
	});

	test("PUT preserves x-phantom-source: built-in marker on written YAML file", async () => {
		// Seed a skill with the built-in marker directly on disk (mirrors
		// the shipped built-in skills that get copied into the user root
		// by the bootstrap seeder).
		const dir = join(tmp, "mirror");
		mkdirSync(dir, { recursive: true });
		const seeded = `---
name: mirror
x-phantom-source: built-in
description: v1
when_to_use: Use on Friday evening when the user asks.
---

# First
`;
		writeFileSync(join(dir, "SKILL.md"), seeded, "utf-8");

		// Simulate the dashboard PUT: fetch, mutate body, post back the
		// full baseline-merged frontmatter including x-phantom-source.
		const res = await handleUiRequest(
			req("/ui/api/skills/mirror", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					frontmatter: {
						name: "mirror",
						"x-phantom-source": "built-in",
						description: "v2",
						when_to_use: "Use on Friday evening when the user asks.",
					},
					body: "# Second\n",
				}),
			}),
		);
		expect(res.status).toBe(200);

		// The marker must survive the round trip on disk. Before the fix,
		// serializeSkill silently dropped x-phantom-source and every edit
		// demoted the skill to "user".
		const onDisk = readFileSync(join(dir, "SKILL.md"), "utf-8");
		expect(onDisk).toContain("x-phantom-source: built-in");

		// Re-fetch via the API and verify detectSource still reads built-in.
		const getRes = await handleUiRequest(req("/ui/api/skills/mirror"));
		const getBody = (await getRes.json()) as { skill: { source: string; frontmatter: Record<string, unknown> } };
		expect(getBody.skill.source).toBe("built-in");
		expect(getBody.skill.frontmatter["x-phantom-source"]).toBe("built-in");
	});

	test("DELETE removes the skill", async () => {
		await handleUiRequest(
			req("/ui/api/skills", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					frontmatter: {
						name: "mirror",
						description: "x",
						when_to_use: "Use when the user asks for it and trigger phrases match.",
					},
					body: "# T\n",
				}),
			}),
		);
		const res = await handleUiRequest(req("/ui/api/skills/mirror", { method: "DELETE" }));
		expect(res.status).toBe(200);
		const list = (await (await handleUiRequest(req("/ui/api/skills"))).json()) as { skills: unknown[] };
		expect(list.skills.length).toBe(0);
	});
});
