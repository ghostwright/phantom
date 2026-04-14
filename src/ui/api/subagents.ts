// UI API routes for subagents CRUD.
//
// All routes live under /ui/api/subagents and are cookie-auth gated by the
// dispatcher in src/ui/serve.ts.
//
//   GET    /ui/api/subagents              -> list
//   GET    /ui/api/subagents/:name        -> read one
//   POST   /ui/api/subagents              -> create (body: { frontmatter, body })
//   PUT    /ui/api/subagents/:name        -> update (body: { frontmatter, body })
//   DELETE /ui/api/subagents/:name        -> delete
//   GET    /ui/api/subagents/:name/audit  -> edit history for that subagent
//
// JSON bodies in and out. All error responses are { error: string }.

import type { Database } from "bun:sqlite";
import { listSubagentEdits, recordSubagentEdit } from "../../subagents/audit.ts";
import {
	MAX_BODY_BYTES,
	type SubagentFrontmatter,
	SubagentFrontmatterSchema,
	getBodyByteLength,
} from "../../subagents/frontmatter.ts";
import { lintSubagent } from "../../subagents/linter.ts";
import {
	type DeleteResult,
	type ReadResult,
	type WriteResult,
	deleteSubagent,
	listSubagents,
	readSubagent,
	writeSubagent,
} from "../../subagents/storage.ts";

type SubagentsApiDeps = {
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
): { ok: true; frontmatter: SubagentFrontmatter; body: string } | { ok: false; error: string } {
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
	const parsed = SubagentFrontmatterSchema.safeParse(shape.frontmatter);
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
		subagent: {
			name: result.subagent.name,
			description: result.subagent.description,
			path: result.subagent.path,
			mtime: result.subagent.mtime,
			size: result.subagent.size,
			has_tools: result.subagent.has_tools,
			model: result.subagent.model,
			effort: result.subagent.effort,
			color: result.subagent.color,
			frontmatter: result.subagent.frontmatter,
			body: result.subagent.body,
			lint: lintSubagent(result.subagent.frontmatter, result.subagent.body),
		},
	});
}

function writeResponse(result: WriteResult): Response {
	if (!result.ok) {
		return json({ error: result.error }, { status: result.status });
	}
	return json({
		subagent: {
			name: result.subagent.name,
			description: result.subagent.description,
			path: result.subagent.path,
			mtime: result.subagent.mtime,
			size: result.subagent.size,
			has_tools: result.subagent.has_tools,
			model: result.subagent.model,
			effort: result.subagent.effort,
			color: result.subagent.color,
			frontmatter: result.subagent.frontmatter,
			body: result.subagent.body,
			lint: lintSubagent(result.subagent.frontmatter, result.subagent.body),
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

export async function handleSubagentsApi(req: Request, url: URL, deps: SubagentsApiDeps): Promise<Response | null> {
	const pathname = url.pathname;

	// GET /ui/api/subagents
	if (pathname === "/ui/api/subagents" && req.method === "GET") {
		const result = listSubagents();
		return json({
			subagents: result.subagents,
			errors: result.errors,
			limits: { max_body_bytes: MAX_BODY_BYTES },
		});
	}

	// POST /ui/api/subagents
	if (pathname === "/ui/api/subagents" && req.method === "POST") {
		const body = await readJson(req);
		if (body && typeof body === "object" && "__error" in body) {
			return json({ error: (body as { __error: string }).__error }, { status: 400 });
		}
		const parsed = parseWriteBody(body);
		if (!parsed.ok) {
			return json({ error: parsed.error }, { status: 422 });
		}
		const result = writeSubagent(
			{ name: parsed.frontmatter.name, frontmatter: parsed.frontmatter, body: parsed.body },
			{ mustExist: false },
		);
		if (result.ok) {
			recordSubagentEdit(deps.db, {
				name: result.subagent.name,
				action: "create",
				previousBody: null,
				newBody: result.subagent.body,
				previousFrontmatterJson: null,
				newFrontmatterJson: JSON.stringify(result.subagent.frontmatter),
				actor: "user",
			});
		}
		return writeResponse(result);
	}

	// /ui/api/subagents/:name/audit
	const auditMatch = pathname.match(/^\/ui\/api\/subagents\/([^/]+)\/audit$/);
	if (auditMatch && req.method === "GET") {
		const name = decodeURIComponent(auditMatch[1]);
		const entries = listSubagentEdits(deps.db, name, 50);
		return json({ entries });
	}

	// /ui/api/subagents/:name
	const match = pathname.match(/^\/ui\/api\/subagents\/([^/]+)$/);
	if (match) {
		const name = decodeURIComponent(match[1]);

		if (req.method === "GET") {
			return readResponse(readSubagent(name));
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
			// Capture the previous frontmatter before writing so we can
			// record a diff in the audit log. The subagent storage layer
			// returns previousBody but not previousFrontmatter; read it
			// inline here via readSubagent so we do not widen the storage
			// return shape.
			const preRead = readSubagent(name);
			const previousFrontmatterJson = preRead.ok ? JSON.stringify(preRead.subagent.frontmatter) : null;
			const result = writeSubagent({ name, frontmatter: parsed.frontmatter, body: parsed.body }, { mustExist: true });
			if (result.ok) {
				recordSubagentEdit(deps.db, {
					name,
					action: "update",
					previousBody: result.previousBody,
					newBody: result.subagent.body,
					previousFrontmatterJson,
					newFrontmatterJson: JSON.stringify(result.subagent.frontmatter),
					actor: "user",
				});
			}
			return writeResponse(result);
		}

		if (req.method === "DELETE") {
			// Snapshot the frontmatter before the file is removed so the
			// audit row can render "this is what the subagent looked like
			// before the delete".
			const preRead = readSubagent(name);
			const previousFrontmatterJson = preRead.ok ? JSON.stringify(preRead.subagent.frontmatter) : null;
			const result = deleteSubagent(name);
			if (result.ok) {
				recordSubagentEdit(deps.db, {
					name,
					action: "delete",
					previousBody: result.previousBody,
					newBody: null,
					previousFrontmatterJson,
					newFrontmatterJson: null,
					actor: "user",
				});
			}
			return deleteResponse(result);
		}

		return json({ error: "Method not allowed" }, { status: 405 });
	}

	return null;
}
