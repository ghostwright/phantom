// UI API routes for the Memory explorer dashboard tab.
//
// All routes live under /ui/api/memory and are cookie-auth gated by the
// dispatcher in src/ui/serve.ts.
//
//   GET    /ui/api/memory/health
//   GET    /ui/api/memory/:type?q=&limit=&offset=
//   GET    /ui/api/memory/:type/:id
//   DELETE /ui/api/memory/:type/:id
//
// When q is present the list endpoint runs a hybrid recall via MemorySystem.
// When q is absent it falls back to Qdrant scroll ordered by recency. Detail
// and delete route through MemorySystem helpers that wrap the per-store
// scroll/get/delete primitives. Memory is the only tab with a write action
// (DELETE), gated through an operator-facing confirmation modal on the
// frontend.

import { z } from "zod";
import type { MemorySystem } from "../../memory/system.ts";
import type { Episode, Procedure, SemanticFact } from "../../memory/types.ts";

export type MemoryApiDeps = {
	memory: MemorySystem;
};

type MemoryType = "episodes" | "facts" | "procedures";
type MemoryItem = Episode | SemanticFact | Procedure;

// Scroll mode (empty query) orders by a payload date field, which disables
// Qdrant's cursor pagination: next_page_offset is null on every call. Load
// More therefore never renders in scroll mode and the operator sees at most
// LIST_DEFAULT_LIMIT items until they search. Default to the hard cap so the
// browse view shows the freshest 100. Cursor-style pagination across
// order_by (filter by { key: order_field, range: { lt: lastSeenValue } } on
// each subsequent call) is a documented follow-up.
const LIST_DEFAULT_LIMIT = 100;
const LIST_MAX_LIMIT = 100;
const Q_MAX = 200;
const ID_MAX = 200;

const TypeSchema = z.enum(["episodes", "facts", "procedures"]);

const ListQuerySchema = z.object({
	q: z.string().max(Q_MAX).optional(),
	limit: z.coerce.number().int().min(1).max(LIST_MAX_LIMIT).optional(),
	offset: z.string().min(1).max(ID_MAX).optional(),
});

function hasControlCharacter(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

const IdSchema = z
	.string()
	.min(1)
	.max(ID_MAX)
	.refine((s) => !hasControlCharacter(s), "id contains control characters");

type ListQuery = z.infer<typeof ListQuerySchema>;

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

function zodMessage(error: z.ZodError): string {
	const issue = error.issues[0];
	const path = issue.path.length > 0 ? issue.path.join(".") : "input";
	return `${path}: ${issue.message}`;
}

function parseType(raw: string): MemoryType | null {
	const parsed = TypeSchema.safeParse(raw);
	return parsed.success ? parsed.data : null;
}

function parseListQuery(url: URL): { ok: true; value: ListQuery } | { ok: false; error: string } {
	const raw: Record<string, string> = {};
	const q = url.searchParams.get("q");
	const limit = url.searchParams.get("limit");
	const offset = url.searchParams.get("offset");
	if (q !== null && q.length > 0) raw.q = q;
	if (limit !== null && limit.length > 0) raw.limit = limit;
	if (offset !== null && offset.length > 0) raw.offset = offset;
	const parsed = ListQuerySchema.safeParse(raw);
	if (!parsed.success) return { ok: false, error: zodMessage(parsed.error) };
	return { ok: true, value: parsed.data };
}

async function handleHealth(deps: MemoryApiDeps): Promise<Response> {
	const health = await deps.memory.healthCheck();
	let episodes = 0;
	let facts = 0;
	let procedures = 0;
	if (health.qdrant) {
		const results = await Promise.allSettled([
			deps.memory.countEpisodes(),
			deps.memory.countFacts(),
			deps.memory.countProcedures(),
		]);
		if (results[0].status === "fulfilled") episodes = results[0].value;
		if (results[1].status === "fulfilled") facts = results[1].value;
		if (results[2].status === "fulfilled") procedures = results[2].value;
	}
	return json({
		qdrant: health.qdrant,
		ollama: health.ollama,
		counts: { episodes, facts, procedures },
	});
}

async function runList(
	deps: MemoryApiDeps,
	type: MemoryType,
	query: ListQuery,
): Promise<{ items: MemoryItem[]; nextOffset: string | number | null }> {
	const limit = query.limit ?? LIST_DEFAULT_LIMIT;
	if (query.q && query.q.trim().length > 0) {
		const qstr = query.q.trim();
		if (type === "episodes") {
			const items = await deps.memory.recallEpisodes(qstr, { limit });
			return { items, nextOffset: null };
		}
		if (type === "facts") {
			const items = await deps.memory.recallFacts(qstr, { limit });
			return { items, nextOffset: null };
		}
		const procedure = await deps.memory.findProcedure(qstr);
		return { items: procedure ? [procedure] : [], nextOffset: null };
	}
	const opts = query.offset ? { limit, offset: query.offset } : { limit };
	if (type === "episodes") return deps.memory.scrollEpisodes(opts);
	if (type === "facts") return deps.memory.scrollFacts(opts);
	return deps.memory.scrollProcedures(opts);
}

async function handleList(deps: MemoryApiDeps, type: MemoryType, url: URL): Promise<Response> {
	const parsed = parseListQuery(url);
	if (!parsed.ok) return json({ error: parsed.error }, { status: 422 });
	const { items, nextOffset } = await runList(deps, type, parsed.value);
	return json({ items, nextOffset });
}

async function getItemById(deps: MemoryApiDeps, type: MemoryType, id: string): Promise<MemoryItem | null> {
	if (type === "episodes") return deps.memory.getEpisodeById(id);
	if (type === "facts") return deps.memory.getFactById(id);
	return deps.memory.getProcedureById(id);
}

async function deleteItemById(deps: MemoryApiDeps, type: MemoryType, id: string): Promise<void> {
	if (type === "episodes") return deps.memory.deleteEpisode(id);
	if (type === "facts") return deps.memory.deleteFact(id);
	return deps.memory.deleteProcedure(id);
}

async function handleDetail(deps: MemoryApiDeps, type: MemoryType, rawId: string): Promise<Response> {
	const idParsed = IdSchema.safeParse(rawId);
	if (!idParsed.success) return json({ error: zodMessage(idParsed.error) }, { status: 400 });
	const item = await getItemById(deps, type, idParsed.data);
	if (!item) return json({ error: "Memory not found" }, { status: 404 });
	return json({ item });
}

async function handleDelete(deps: MemoryApiDeps, type: MemoryType, rawId: string): Promise<Response> {
	const idParsed = IdSchema.safeParse(rawId);
	if (!idParsed.success) return json({ error: zodMessage(idParsed.error) }, { status: 400 });
	const existing = await getItemById(deps, type, idParsed.data);
	if (!existing) return json({ error: "Memory not found" }, { status: 404 });
	await deleteItemById(deps, type, idParsed.data);
	return json({ deleted: true, id: idParsed.data });
}

export async function handleMemoryApi(req: Request, url: URL, deps: MemoryApiDeps): Promise<Response | null> {
	const pathname = url.pathname;

	if (pathname === "/ui/api/memory/health") {
		if (req.method !== "GET") return json({ error: "Method not allowed" }, { status: 405 });
		return handleHealth(deps);
	}

	const detailMatch = pathname.match(/^\/ui\/api\/memory\/(episodes|facts|procedures)\/(.+)$/);
	if (detailMatch) {
		const type = parseType(detailMatch[1]);
		if (!type) return json({ error: "Unknown memory type" }, { status: 404 });
		let rawId: string;
		try {
			rawId = decodeURIComponent(detailMatch[2]);
		} catch {
			return json({ error: "Invalid URL-encoded id" }, { status: 400 });
		}
		if (req.method === "GET") return handleDetail(deps, type, rawId);
		if (req.method === "DELETE") return handleDelete(deps, type, rawId);
		return json({ error: "Method not allowed" }, { status: 405 });
	}

	const listMatch = pathname.match(/^\/ui\/api\/memory\/(episodes|facts|procedures)$/);
	if (listMatch) {
		const type = parseType(listMatch[1]);
		if (!type) return json({ error: "Unknown memory type" }, { status: 404 });
		if (req.method !== "GET") return json({ error: "Method not allowed" }, { status: 405 });
		return handleList(deps, type, url);
	}

	if (pathname.startsWith("/ui/api/memory/")) {
		return json({ error: "Unknown memory type" }, { status: 404 });
	}

	return null;
}
