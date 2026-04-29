// UI API routes for memory files CRUD.
//
// All routes live under /ui/api/memory-files and are cookie-auth gated.
//
//   GET    /ui/api/memory-files            -> list
//   GET    /ui/api/memory-files/<path>     -> read one
//   POST   /ui/api/memory-files            -> create (body: { path, content })
//   PUT    /ui/api/memory-files/<path>     -> update (body: { content })
//   DELETE /ui/api/memory-files/<path>     -> delete
//
// `<path>` is a URL-encoded relative path from the memory files root. The path
// may include forward slashes. We extract it by stripping the route prefix.

import type { Database } from "bun:sqlite";
import { recordMemoryFileEdit } from "../../memory-files/audit.ts";
import {
	type DeleteResult,
	MEMORY_FILE_MAX_BYTES,
	type MemoryFileDetail,
	type ReadResult,
	type WriteResult,
	deleteMemoryFile,
	listMemoryFiles,
	readMemoryFile,
	writeMemoryFile,
} from "../../memory-files/storage.ts";

type MemoryFilesApiDeps = {
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

async function readJson(req: Request): Promise<unknown | { __error: string }> {
	try {
		return await req.json();
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { __error: `Invalid JSON body: ${msg}` };
	}
}

function detailJson(file: MemoryFileDetail): Record<string, unknown> {
	return {
		path: file.path,
		size: file.size,
		mtime: file.mtime,
		top_level: file.top_level,
		content: file.content,
		read_only: file.read_only === true,
		description: file.description,
	};
}

function readResponse(result: ReadResult): Response {
	if (!result.ok) return json({ error: result.error }, { status: result.status });
	return json({ file: detailJson(result.file) });
}

function writeResponse(result: WriteResult): Response {
	if (!result.ok) return json({ error: result.error }, { status: result.status });
	return json({ file: detailJson(result.file) });
}

function deleteResponse(result: DeleteResult): Response {
	if (!result.ok) return json({ error: result.error }, { status: result.status });
	return json({ deleted: result.deleted });
}

function parseWriteBody(raw: unknown): { ok: true; content: string } | { ok: false; error: string } {
	if (!raw || typeof raw !== "object") {
		return { ok: false, error: "Request body must be a JSON object" };
	}
	const shape = raw as { content?: unknown };
	if (typeof shape.content !== "string") {
		return { ok: false, error: "content field must be a string" };
	}
	return { ok: true, content: shape.content };
}

function parseCreateBody(raw: unknown): { ok: true; path: string; content: string } | { ok: false; error: string } {
	if (!raw || typeof raw !== "object") {
		return { ok: false, error: "Request body must be a JSON object" };
	}
	const shape = raw as { path?: unknown; content?: unknown };
	if (typeof shape.path !== "string") {
		return { ok: false, error: "path field must be a string" };
	}
	if (typeof shape.content !== "string") {
		return { ok: false, error: "content field must be a string" };
	}
	return { ok: true, path: shape.path, content: shape.content };
}

export async function handleMemoryFilesApi(req: Request, url: URL, deps: MemoryFilesApiDeps): Promise<Response | null> {
	const pathname = url.pathname;

	// GET /ui/api/memory-files
	if (pathname === "/ui/api/memory-files" && req.method === "GET") {
		const result = listMemoryFiles();
		return json({
			files: result.files,
			limits: { max_content_bytes: MEMORY_FILE_MAX_BYTES },
		});
	}

	// POST /ui/api/memory-files
	if (pathname === "/ui/api/memory-files" && req.method === "POST") {
		const body = await readJson(req);
		if (body && typeof body === "object" && "__error" in body) {
			return json({ error: (body as { __error: string }).__error }, { status: 400 });
		}
		const parsed = parseCreateBody(body);
		if (!parsed.ok) return json({ error: parsed.error }, { status: 422 });
		const result = writeMemoryFile({ path: parsed.path, content: parsed.content }, { mustExist: false });
		if (result.ok) {
			recordMemoryFileEdit(deps.db, {
				path: parsed.path,
				action: "create",
				previousContent: null,
				newContent: result.file.content,
				actor: "user",
			});
		}
		return writeResponse(result);
	}

	// /ui/api/memory-files/<encoded-path>
	if (pathname.startsWith("/ui/api/memory-files/")) {
		const encoded = pathname.slice("/ui/api/memory-files/".length);
		let relative: string;
		try {
			relative = decodeURIComponent(encoded);
		} catch {
			return json({ error: "Invalid URL-encoded path" }, { status: 400 });
		}

		if (req.method === "GET") {
			return readResponse(readMemoryFile(relative));
		}

		if (req.method === "PUT") {
			const body = await readJson(req);
			if (body && typeof body === "object" && "__error" in body) {
				return json({ error: (body as { __error: string }).__error }, { status: 400 });
			}
			const parsed = parseWriteBody(body);
			if (!parsed.ok) return json({ error: parsed.error }, { status: 422 });
			const result = writeMemoryFile({ path: relative, content: parsed.content }, { mustExist: true });
			if (result.ok) {
				recordMemoryFileEdit(deps.db, {
					path: relative,
					action: "update",
					previousContent: result.previousContent,
					newContent: result.file.content,
					actor: "user",
				});
			}
			return writeResponse(result);
		}

		if (req.method === "DELETE") {
			const result = deleteMemoryFile(relative);
			if (result.ok) {
				recordMemoryFileEdit(deps.db, {
					path: relative,
					action: "delete",
					previousContent: result.previousContent,
					newContent: null,
					actor: "user",
				});
			}
			return deleteResponse(result);
		}

		return json({ error: "Method not allowed" }, { status: 405 });
	}

	return null;
}
