// UI API routes for skills CRUD.
//
// All routes live under /ui/api/skills and are cookie-auth gated at the
// serve.ts level (the router dispatches only after isAuthenticated passes).
//
//   GET    /ui/api/skills              -> list
//   GET    /ui/api/skills/:name        -> read one
//   POST   /ui/api/skills              -> create (body: { name, frontmatter, body })
//   PUT    /ui/api/skills/:name        -> update (body: { frontmatter, body })
//   DELETE /ui/api/skills/:name        -> delete
//
// JSON bodies in and out. All error responses are { error: string }.

import type { Database } from "bun:sqlite";
import { recordSkillEdit } from "../../skills/audit.ts";
import {
	MAX_BODY_BYTES,
	type SkillFrontmatter,
	SkillFrontmatterSchema,
	getBodyByteLength,
} from "../../skills/frontmatter.ts";
import { lintSkill } from "../../skills/linter.ts";
import {
	type DeleteResult,
	type ReadResult,
	type WriteResult,
	deleteSkill,
	listSkills,
	readSkill,
	writeSkill,
} from "../../skills/storage.ts";

type SkillsApiDeps = {
	db: Database;
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

function parseWriteBody(
	raw: unknown,
): { ok: true; frontmatter: SkillFrontmatter; body: string } | { ok: false; error: string } {
	if (!raw || typeof raw !== "object") {
		return { ok: false, error: "Request body must be a JSON object" };
	}
	const shape = raw as { frontmatter?: unknown; body?: unknown };
	if (typeof shape.body !== "string") {
		return { ok: false, error: "body field must be a string" };
	}
	if (shape.frontmatter == null || typeof shape.frontmatter !== "object") {
		return { ok: false, error: "frontmatter field must be an object" };
	}
	const parsed = SkillFrontmatterSchema.safeParse(shape.frontmatter);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const path = issue.path.length > 0 ? issue.path.join(".") : "frontmatter";
		return { ok: false, error: `${path}: ${issue.message}` };
	}
	return { ok: true, frontmatter: parsed.data, body: shape.body };
}

function readResponse(result: ReadResult): Response {
	if (!result.ok) {
		return json({ error: result.error }, { status: result.status });
	}
	return json({
		skill: {
			name: result.skill.name,
			description: result.skill.description,
			when_to_use: result.skill.when_to_use,
			source: result.skill.source,
			path: result.skill.path,
			mtime: result.skill.mtime,
			size: result.skill.size,
			has_allowed_tools: result.skill.has_allowed_tools,
			disable_model_invocation: result.skill.disable_model_invocation,
			frontmatter: result.skill.frontmatter,
			body: result.skill.body,
			lint: lintSkill(result.skill.frontmatter, result.skill.body),
		},
	});
}

function writeResponse(result: WriteResult): Response {
	if (!result.ok) {
		return json({ error: result.error }, { status: result.status });
	}
	return json({
		skill: {
			name: result.skill.name,
			description: result.skill.description,
			when_to_use: result.skill.when_to_use,
			source: result.skill.source,
			path: result.skill.path,
			mtime: result.skill.mtime,
			size: result.skill.size,
			has_allowed_tools: result.skill.has_allowed_tools,
			disable_model_invocation: result.skill.disable_model_invocation,
			frontmatter: result.skill.frontmatter,
			body: result.skill.body,
			lint: lintSkill(result.skill.frontmatter, result.skill.body),
		},
	});
}

function deleteResponse(result: DeleteResult): Response {
	if (!result.ok) {
		return json({ error: result.error }, { status: result.status });
	}
	return json({ deleted: result.deleted });
}

async function readJson(req: Request): Promise<unknown | { __error: string }> {
	try {
		return await req.json();
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { __error: `Invalid JSON body: ${msg}` };
	}
}

export async function handleSkillsApi(req: Request, url: URL, deps: SkillsApiDeps): Promise<Response | null> {
	const pathname = url.pathname;

	// GET /ui/api/skills
	if (pathname === "/ui/api/skills" && req.method === "GET") {
		const result = listSkills();
		return json({
			skills: result.skills,
			errors: result.errors,
			limits: { max_body_bytes: MAX_BODY_BYTES },
		});
	}

	// POST /ui/api/skills
	if (pathname === "/ui/api/skills" && req.method === "POST") {
		const body = await readJson(req);
		if (body && typeof body === "object" && "__error" in body) {
			return json({ error: (body as { __error: string }).__error }, { status: 400 });
		}
		const parsed = parseWriteBody(body);
		if (!parsed.ok) {
			return json({ error: parsed.error }, { status: 422 });
		}
		const result = writeSkill(
			{ name: parsed.frontmatter.name, frontmatter: parsed.frontmatter, body: parsed.body },
			{ mustExist: false },
		);
		if (result.ok) {
			recordSkillEdit(deps.db, {
				name: result.skill.name,
				action: "create",
				previousBody: null,
				newBody: result.skill.body,
				actor: "user",
			});
		}
		return writeResponse(result);
	}

	// /ui/api/skills/:name
	const match = pathname.match(/^\/ui\/api\/skills\/([^/]+)$/);
	if (match) {
		const name = decodeURIComponent(match[1]);

		if (req.method === "GET") {
			return readResponse(readSkill(name));
		}

		if (req.method === "PUT") {
			const body = await readJson(req);
			if (body && typeof body === "object" && "__error" in body) {
				return json({ error: (body as { __error: string }).__error }, { status: 400 });
			}
			const parsed = parseWriteBody(body);
			if (!parsed.ok) {
				return json({ error: parsed.error }, { status: 422 });
			}
			if (parsed.frontmatter.name !== name) {
				return json(
					{ error: `Frontmatter name '${parsed.frontmatter.name}' does not match path name '${name}'` },
					{ status: 422 },
				);
			}
			const bytes = getBodyByteLength(parsed.body);
			if (bytes > MAX_BODY_BYTES) {
				return json(
					{ error: `Body is ${(bytes / 1024).toFixed(1)} KB, over the ${MAX_BODY_BYTES / 1024} KB limit.` },
					{ status: 413 },
				);
			}
			const result = writeSkill({ name, frontmatter: parsed.frontmatter, body: parsed.body }, { mustExist: true });
			if (result.ok) {
				recordSkillEdit(deps.db, {
					name,
					action: "update",
					previousBody: result.previousBody,
					newBody: result.skill.body,
					actor: "user",
				});
			}
			return writeResponse(result);
		}

		if (req.method === "DELETE") {
			const result = deleteSkill(name);
			if (result.ok) {
				recordSkillEdit(deps.db, {
					name,
					action: "delete",
					previousBody: result.previousBody,
					newBody: null,
					actor: "user",
				});
			}
			return deleteResponse(result);
		}

		return json({ error: "Method not allowed" }, { status: 405 });
	}

	return null;
}
