// UI API routes for the curated settings form. Cookie-auth gated at serve.ts.
//
//   GET   /ui/api/settings        -> full settings.json plus whitelist info
//   PUT   /ui/api/settings        -> diff-based write of a partial payload
//   GET   /ui/api/settings/audit  -> audit timeline
//
// Every write routes through src/plugins/settings-io.ts for atomic tmp+rename.
// Unknown fields are rejected at parse time via Zod .strict(); the deny-list
// is enforced by NOT being in the whitelist. Fields the user did not touch
// stay byte-for-byte identical.

import type { Database } from "bun:sqlite";
import { listSettingsAudit, recordSettingsEdit } from "../../settings-editor/audit.ts";
import { DENYLISTED_KEYS, WHITELISTED_KEYS } from "../../settings-editor/schema.ts";
import { readCurated, writeCurated } from "../../settings-editor/storage.ts";

type SettingsApiDeps = {
	db: Database;
	settingsPath?: string;
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

export async function handleSettingsApi(req: Request, url: URL, deps: SettingsApiDeps): Promise<Response | null> {
	const pathname = url.pathname;

	if (pathname === "/ui/api/settings" && req.method === "GET") {
		const result = readCurated(deps.settingsPath);
		if (!result.ok) return json({ error: result.error }, { status: 500 });
		return json({
			current: result.current,
			whitelist: WHITELISTED_KEYS,
			denylist: DENYLISTED_KEYS,
		});
	}

	if (pathname === "/ui/api/settings" && req.method === "PUT") {
		const body = await readJson(req);
		if (body && typeof body === "object" && "__error" in body) {
			return json({ error: (body as { __error: string }).__error }, { status: 400 });
		}
		const result = writeCurated(body, deps.settingsPath);
		if (!result.ok) return json({ error: result.error }, { status: result.status });
		for (const dirty of result.dirty) {
			recordSettingsEdit(deps.db, {
				field: String(dirty.key),
				previousValue: dirty.previous,
				newValue: dirty.next,
				actor: "user",
			});
		}
		return json({
			current: result.current,
			dirty_keys: result.dirty.map((d) => d.key),
		});
	}

	if (pathname === "/ui/api/settings/audit" && req.method === "GET") {
		return json({ entries: listSettingsAudit(deps.db, 100) });
	}

	return null;
}
