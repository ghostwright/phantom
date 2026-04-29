// UI API routes for the hooks tab. Cookie-auth gated at serve.ts.
//
//   GET    /ui/api/hooks                  -> list slice + allowlist + trust state + count
//   POST   /ui/api/hooks                  -> install (body: { event, matcher?, definition })
//   PUT    /ui/api/hooks/:event/:g/:h     -> update the hook at position (g, h)
//                                            If the body also carries a `to`
//                                            coordinate with a different event
//                                            or matcher, the call is routed
//                                            through relocateHook instead for
//                                            an atomic event/matcher change.
//   DELETE /ui/api/hooks/:event/:g/:h     -> uninstall
//   POST   /ui/api/hooks/trust            -> record first-install trust acceptance
//                                            (body: { hook_type }) scoped per type.
//   GET    /ui/api/hooks/audit            -> audit timeline
//
// JSON in, JSON out. All writes route through src/plugins/settings-io.ts which
// writes only the slice the caller touches; every other settings.json field
// stays byte-for-byte identical.

import type { Database } from "bun:sqlite";
import { getHookTrustMap, hasAcceptedHookTrust, listHookAudit, recordHookEdit } from "../../hooks/audit.ts";
import { HookDefinitionSchema, type HookEvent, HookEventSchema } from "../../hooks/schema.ts";
import { installHook, listHooks, relocateHook, uninstallHook, updateHook } from "../../hooks/storage.ts";

type HooksApiDeps = {
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

function parseInstallBody(
	raw: unknown,
):
	| { ok: true; event: HookEvent; matcher?: string; definition: ReturnType<typeof HookDefinitionSchema.parse> }
	| { ok: false; error: string } {
	if (!raw || typeof raw !== "object") return { ok: false, error: "body must be an object" };
	const shape = raw as { event?: unknown; matcher?: unknown; definition?: unknown };
	const evParsed = HookEventSchema.safeParse(shape.event);
	if (!evParsed.success) return { ok: false, error: `event: ${evParsed.error.issues[0].message}` };
	if (shape.matcher !== undefined && typeof shape.matcher !== "string") {
		return { ok: false, error: "matcher must be a string if present" };
	}
	const defParsed = HookDefinitionSchema.safeParse(shape.definition);
	if (!defParsed.success) {
		const issue = defParsed.error.issues[0];
		const path = issue.path.length > 0 ? issue.path.join(".") : "definition";
		return { ok: false, error: `${path}: ${issue.message}` };
	}
	return {
		ok: true,
		event: evParsed.data,
		matcher: shape.matcher as string | undefined,
		definition: defParsed.data,
	};
}

export async function handleHooksApi(req: Request, url: URL, deps: HooksApiDeps): Promise<Response | null> {
	const pathname = url.pathname;

	if (pathname === "/ui/api/hooks" && req.method === "GET") {
		const result = listHooks(deps.settingsPath);
		if (!result.ok) return json({ error: result.error }, { status: 500 });
		return json({
			slice: result.slice,
			total: result.total,
			allowed_http_hook_urls: result.allowedHttpHookUrls ?? null,
			trust_accepted: hasAcceptedHookTrust(deps.db),
			trust_by_type: getHookTrustMap(deps.db),
		});
	}

	if (pathname === "/ui/api/hooks" && req.method === "POST") {
		const body = await readJson(req);
		if (body && typeof body === "object" && "__error" in body) {
			return json({ error: (body as { __error: string }).__error }, { status: 400 });
		}
		const parsed = parseInstallBody(body);
		if (!parsed.ok) return json({ error: parsed.error }, { status: 422 });
		const result = installHook(
			{ event: parsed.event, matcher: parsed.matcher, definition: parsed.definition },
			deps.settingsPath,
		);
		if (!result.ok) return json({ error: result.error }, { status: result.status });
		recordHookEdit(deps.db, {
			event: parsed.event,
			matcher: parsed.matcher,
			hookType: parsed.definition.type,
			action: "install",
			previousSlice: result.previousSlice,
			newSlice: result.slice,
			definition: parsed.definition,
			actor: "user",
		});
		return json({
			slice: result.slice,
			event: parsed.event,
			groupIndex: result.groupIndex,
			hookIndex: result.hookIndex,
		});
	}

	if (pathname === "/ui/api/hooks/trust" && req.method === "POST") {
		const body = await readJson(req);
		const hookType =
			body && typeof body === "object" && "hook_type" in body ? (body as { hook_type?: unknown }).hook_type : undefined;
		// Default to "command" if the client did not specify a type so
		// pre-fix clients keep working. New clients pass the type
		// explicitly for per-type scoping.
		const typed =
			typeof hookType === "string" && ["command", "prompt", "agent", "http"].includes(hookType)
				? (hookType as "command" | "prompt" | "agent" | "http")
				: "command";
		recordHookEdit(deps.db, {
			event: "<trust>",
			matcher: undefined,
			hookType: typed,
			action: "trust_accepted",
			previousSlice: null,
			newSlice: null,
			definition: null,
			actor: "user",
		});
		return json({ ok: true });
	}

	if (pathname === "/ui/api/hooks/audit" && req.method === "GET") {
		return json({ entries: listHookAudit(deps.db, 100) });
	}

	const match = pathname.match(/^\/ui\/api\/hooks\/([A-Za-z]+)\/(\d+)\/(\d+)$/);
	if (match) {
		const evParsed = HookEventSchema.safeParse(match[1]);
		if (!evParsed.success) return json({ error: `Unknown hook event: ${match[1]}` }, { status: 422 });
		const event = evParsed.data;
		const groupIndex = Number.parseInt(match[2], 10);
		const hookIndex = Number.parseInt(match[3], 10);

		if (req.method === "PUT") {
			const body = await readJson(req);
			if (body && typeof body === "object" && "__error" in body) {
				return json({ error: (body as { __error: string }).__error }, { status: 400 });
			}
			const shape = body as { definition?: unknown; to?: { event?: unknown; matcher?: unknown } } | null;
			const defShape = shape?.definition;
			const defParsed = HookDefinitionSchema.safeParse(defShape);
			if (!defParsed.success) {
				const issue = defParsed.error.issues[0];
				const path = issue.path.length > 0 ? issue.path.join(".") : "definition";
				return json({ error: `${path}: ${issue.message}` }, { status: 422 });
			}

			// Detect whether the caller is asking for a relocate. If the
			// `to` coordinate pair is present and either the event or
			// matcher differs from the source, we route through
			// relocateHook so the move is a single atomic write.
			const toRaw = shape?.to;
			if (toRaw && typeof toRaw === "object") {
				const toEvParsed = HookEventSchema.safeParse((toRaw as { event?: unknown }).event);
				if (!toEvParsed.success) {
					return json({ error: `to.event: ${toEvParsed.error.issues[0].message}` }, { status: 422 });
				}
				const toMatcherRaw = (toRaw as { matcher?: unknown }).matcher;
				if (toMatcherRaw !== undefined && toMatcherRaw !== null && typeof toMatcherRaw !== "string") {
					return json({ error: "to.matcher must be a string if present" }, { status: 422 });
				}
				const toMatcher = typeof toMatcherRaw === "string" && toMatcherRaw.length > 0 ? toMatcherRaw : undefined;

				const result = relocateHook(
					{
						fromEvent: event,
						fromGroupIndex: groupIndex,
						fromHookIndex: hookIndex,
						toEvent: toEvParsed.data,
						toMatcher,
						definition: defParsed.data,
					},
					deps.settingsPath,
				);
				if (!result.ok) return json({ error: result.error }, { status: result.status });
				recordHookEdit(deps.db, {
					event,
					matcher: result.previousMatcher,
					hookType: defParsed.data.type,
					action: "relocate",
					previousSlice: result.previousSlice,
					newSlice: result.slice,
					definition: defParsed.data,
					actor: "user",
				});
				return json({
					slice: result.slice,
					event: toEvParsed.data,
					groupIndex: result.newGroupIndex,
					hookIndex: result.newHookIndex,
				});
			}

			const result = updateHook({ event, groupIndex, hookIndex, definition: defParsed.data }, deps.settingsPath);
			if (!result.ok) return json({ error: result.error }, { status: result.status });
			recordHookEdit(deps.db, {
				event,
				matcher: result.previousMatcher,
				hookType: defParsed.data.type,
				action: "update",
				previousSlice: result.previousSlice,
				newSlice: result.slice,
				definition: defParsed.data,
				actor: "user",
			});
			return json({ slice: result.slice });
		}

		if (req.method === "DELETE") {
			const result = uninstallHook({ event, groupIndex, hookIndex }, deps.settingsPath);
			if (!result.ok) return json({ error: result.error }, { status: result.status });
			recordHookEdit(deps.db, {
				event,
				matcher: result.previousMatcher,
				hookType: result.previousHookType ?? null,
				action: "uninstall",
				previousSlice: result.previousSlice,
				newSlice: result.slice,
				definition: null,
				actor: "user",
			});
			return json({ slice: result.slice });
		}

		return json({ error: "Method not allowed" }, { status: 405 });
	}

	return null;
}
