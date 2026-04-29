// UI API routes for the phantom.yaml operator-configuration surface (PR 6).
//
// All routes live under /ui/api/phantom-config and are cookie-auth gated by
// the dispatcher in src/ui/serve.ts. This endpoint replaces the earlier
// /ui/api/settings surface that edited ~/.claude/settings.json. Settings
// that belong to the Claude Agent SDK stay SSH-editable; everything here
// edits config/phantom.yaml (and its satellite overlay files) and is safe
// to change from a dashboard.
//
//   GET  /ui/api/phantom-config           -> full UI-visible config + last-modified
//   PUT  /ui/api/phantom-config           -> partial update, atomic YAML write, audit row
//   GET  /ui/api/phantom-config/audit     -> newest-first audit rows, limit capped
//
// Secrets never flow through this endpoint. PhantomConfigForUiSchema is
// .strict() at every level so unknown keys (ANTHROPIC_API_KEY, Slack tokens,
// webhook secrets, email passwords) reject at parse time. The Zod schema is
// the secrets denylist.
//
// Atomic write: writeAtomic() from src/config/atomic-write.ts uses tmp file +
// rename so a mid-write crash cannot leave a torn phantom.yaml on disk. A
// failed rename deletes the temp file; the original phantom.yaml is byte-
// identical to before. See __tests__/phantom-config.test.ts for the explicit
// failure-path assertions.

import type { Database } from "bun:sqlite";
import { stringify as stringifyYaml } from "yaml";
import type { z } from "zod";
import { writeAtomic } from "../../config/atomic-write.ts";
import {
	type AppliedChange,
	type PhantomConfigAuditEntry,
	PhantomConfigForUiSchema,
	type PhantomConfigPaths,
	PhantomConfigPutSchema,
} from "./phantom-config-schemas.ts";
import {
	applyPatch,
	loadAllConfig,
	planWrites,
	projectToUi,
	readYamlFile,
	resolvePaths,
} from "./phantom-config-storage.ts";

export type { PhantomConfigPaths } from "./phantom-config-schemas.ts";

const AUDIT_LIMIT_MAX = 100;
const AUDIT_LIMIT_DEFAULT = 20;

export type PhantomConfigApiDeps = {
	db: Database;
	paths?: Partial<PhantomConfigPaths>;
	// Test seam: lets phantom-config.test.ts simulate a mid-write rename
	// failure without a real readonly filesystem. Production wiring leaves
	// this undefined so writeAtomic uses fs.renameSync.
	renameImpl?: (from: string, to: string) => void;
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

function errJson(error: string, status: number, extras?: Record<string, unknown>): Response {
	return json({ error, ...(extras ?? {}) }, { status });
}

function zodErrorMessage(err: z.ZodError): { path: string; message: string } {
	const issue = err.issues[0];
	const path = issue?.path?.length ? issue.path.map((p) => String(p)).join(".") : "body";
	return { path, message: issue?.message ?? "invalid input" };
}

async function parseJsonBody<T>(
	req: Request,
	schema: z.ZodType<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: string; status: number; field?: string }> {
	let raw: unknown;
	try {
		raw = await req.json();
	} catch {
		return { ok: false, error: "Invalid JSON body", status: 400 };
	}
	const parsed = schema.safeParse(raw);
	if (!parsed.success) {
		const { path, message } = zodErrorMessage(parsed.error);
		return { ok: false, error: `${path}: ${message}`, status: 400, field: path };
	}
	return { ok: true, value: parsed.data };
}

// Known secret-shape prefixes. Defense in depth: the UI schema already rejects
// secret field names via .strict(), but an operator could still paste a token
// into a free-form field (name, role, domain). Redact the literal token from
// the audit before persisting so a screen-share of the history pane does not
// leak API keys or bot tokens.
const SECRET_PATTERN =
	/\b(sk-ant-[\w-]+|sk-[\w-]{20,}|xoxb-[\w-]+|xoxp-[\w-]+|xapp-[\w-]+|ghp_[\w]+|gho_[\w]+|ghu_[\w]+|ghs_[\w]+|ghr_[\w]+|bot\d+:[\w-]+)/g;

function redactSecretShapes(value: unknown): unknown {
	if (typeof value === "string") return value.replace(SECRET_PATTERN, "[redacted]");
	if (Array.isArray(value)) return value.map(redactSecretShapes);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) out[k] = redactSecretShapes(v);
		return out;
	}
	return value;
}

function serializeAuditValue(value: unknown): string | null {
	if (value === undefined) return null;
	return JSON.stringify(redactSecretShapes(value));
}

function recordAuditRows(db: Database, changes: AppliedChange[], actor: string): void {
	for (const change of changes) {
		db.run(
			`INSERT INTO settings_audit_log (field, previous_value, new_value, actor, section)
			 VALUES (?, ?, ?, ?, ?)`,
			[change.field, serializeAuditValue(change.previous), serializeAuditValue(change.next), actor, change.section],
		);
	}
}

function listAudit(db: Database, limit: number): PhantomConfigAuditEntry[] {
	return db
		.query(
			`SELECT id, section, field, previous_value, new_value, actor, created_at
			 FROM settings_audit_log
			 ORDER BY id DESC
			 LIMIT ?`,
		)
		.all(limit) as PhantomConfigAuditEntry[];
}

function lastModified(db: Database): { last_modified_at: string | null; last_modified_by: string | null } {
	const row = db.query("SELECT created_at, actor FROM settings_audit_log ORDER BY id DESC LIMIT 1").get() as {
		created_at: string;
		actor: string;
	} | null;
	if (!row) return { last_modified_at: null, last_modified_by: null };
	return { last_modified_at: row.created_at, last_modified_by: row.actor };
}

export async function handlePhantomConfigApi(
	req: Request,
	url: URL,
	deps: PhantomConfigApiDeps,
): Promise<Response | null> {
	const pathname = url.pathname;
	const paths = resolvePaths(deps.paths);

	if (pathname === "/ui/api/phantom-config" && req.method === "GET") {
		return handleGet(deps, paths);
	}
	if (pathname === "/ui/api/phantom-config" && req.method === "PUT") {
		return handlePut(req, deps, paths);
	}
	if (pathname === "/ui/api/phantom-config/audit" && req.method === "GET") {
		return handleAuditGet(url, deps);
	}
	if (pathname === "/ui/api/phantom-config" || pathname === "/ui/api/phantom-config/audit") {
		return errJson("Method not allowed", 405);
	}
	return null;
}

function handleGet(deps: PhantomConfigApiDeps, paths: PhantomConfigPaths): Response {
	const loaded = loadAllConfig(paths);
	if (!loaded.ok) return errJson(loaded.error, 500);
	const ui = projectToUi(loaded.value);
	return json({ config: ui, audit: lastModified(deps.db) });
}

async function handlePut(req: Request, deps: PhantomConfigApiDeps, paths: PhantomConfigPaths): Promise<Response> {
	const parsed = await parseJsonBody(req, PhantomConfigPutSchema);
	if (!parsed.ok) {
		return errJson(parsed.error, parsed.status, parsed.field ? { field: parsed.field } : undefined);
	}

	const loaded = loadAllConfig(paths);
	if (!loaded.ok) return errJson(loaded.error, 500);
	const current = projectToUi(loaded.value);

	const { merged, changes } = applyPatch(current, parsed.value);

	// Validate the merged object against the full UI schema so invalid cross-field
	// combinations are caught (e.g. empty string name after a patch) before we
	// touch disk. This is the second line of defense behind the per-field Zod
	// validation already run on the patch itself.
	const fullCheck = PhantomConfigForUiSchema.safeParse(merged);
	if (!fullCheck.success) {
		const { path: errPath, message } = zodErrorMessage(fullCheck.error);
		return errJson(`${errPath}: ${message}`, 400, { field: errPath });
	}

	if (changes.length === 0) {
		return json({ config: current, dirty_keys: [] });
	}

	// Only read memory.yaml when the patch actually touches the memory section.
	// Otherwise a malformed memory.yaml would 500 unrelated saves (identity,
	// model, permissions) and brick the dashboard for fields that have nothing
	// to do with memory.
	const memoryChanged = changes.some((c) => c.section === "memory");
	let memorySource: Record<string, unknown> | null = null;
	if (memoryChanged) {
		const memRes = readYamlFile("config/memory.yaml");
		if (!memRes.ok) return errJson(memRes.error, 500);
		memorySource = (memRes.value ?? null) as Record<string, unknown> | null;
	}
	const plan = planWrites(loaded.value, merged, memorySource);

	// Write order: phantom.yaml first (identity, cost, permissions, evolution
	// mirror). If that succeeds, channels, memory, evolution overlay.
	// Each write is individually atomic; if the second one fails we STOP so
	// the DB audit row count matches what actually made it to disk.
	const phantomYamlText = stringifyYaml(plan.phantom, { lineWidth: 120 });
	const phantomRes = writeAtomic(paths.phantomYaml, phantomYamlText, deps.renameImpl);
	if (!phantomRes.ok) return errJson(phantomRes.error, 500);

	const channelsChanged = changes.some((c) => c.section === "channels");
	if (channelsChanged) {
		const channelsText = stringifyYaml(plan.channels, { lineWidth: 120 });
		const res = writeAtomic(paths.channelsYaml, channelsText, deps.renameImpl);
		if (!res.ok) return errJson(res.error, 500);
	}

	if (memoryChanged) {
		const memText = stringifyYaml(plan.memory, { lineWidth: 120 });
		const res = writeAtomic("config/memory.yaml", memText, deps.renameImpl);
		if (!res.ok) return errJson(res.error, 500);
	}

	const evolutionChanged = changes.some((c) => c.section === "evolution");
	if (evolutionChanged) {
		const evText = `${JSON.stringify(plan.evolutionMeta, null, 2)}\n`;
		const res = writeAtomic(paths.evolutionMeta, evText, deps.renameImpl);
		if (!res.ok) return errJson(res.error, 500);
	}

	recordAuditRows(deps.db, changes, "user");

	// Re-project from disk so the returned config reflects whatever coercion
	// Zod applied (trimming, defaults).
	const reloaded = loadAllConfig(paths);
	if (!reloaded.ok) return errJson(reloaded.error, 500);
	const after = projectToUi(reloaded.value);

	return json({
		config: after,
		dirty_keys: changes.map((c) => c.field),
	});
}

function handleAuditGet(url: URL, deps: PhantomConfigApiDeps): Response {
	const raw = url.searchParams.get("limit");
	const asNum = raw === null ? AUDIT_LIMIT_DEFAULT : Number(raw);
	if (!Number.isFinite(asNum) || asNum <= 0) {
		return errJson("limit must be a positive integer", 400);
	}
	const limit = Math.min(Math.floor(asNum), AUDIT_LIMIT_MAX);
	return json({ entries: listAudit(deps.db, limit) });
}
