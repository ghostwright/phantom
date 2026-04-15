import type { Database } from "bun:sqlite";
import { relative, resolve } from "node:path";
import { createSSEResponse } from "./events.ts";
import { loginPageHtml } from "./login-page.ts";
import { consumeMagicLink, createSession, isValidSession } from "./session.ts";

import { secretsExpiredHtml, secretsFormHtml } from "../secrets/form-page.ts";
import { getSecretRequest, saveSecrets, validateMagicToken } from "../secrets/store.ts";
import { handleHooksApi } from "./api/hooks.ts";
import { handleMemoryFilesApi } from "./api/memory-files.ts";
import { type PluginsApiDeps, handlePluginsApi } from "./api/plugins.ts";
import { handleSettingsApi } from "./api/settings.ts";
import { handleSkillsApi } from "./api/skills.ts";
import { handleSubagentsApi } from "./api/subagents.ts";

const COOKIE_NAME = "phantom_session";
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60; // 7 days in seconds

let publicDir = resolve(process.cwd(), "public");
let secretsDb: Database | null = null;
let dashboardDb: Database | null = null;
let pluginsApiOverrides: Pick<PluginsApiDeps, "fetcher" | "settingsPath" | "overlayPath"> = {};

type SecretSavedCallback = (requestId: string, secretNames: string[]) => Promise<void>;
let onSecretSaved: SecretSavedCallback | null = null;

export function setSecretsDb(db: Database): void {
	secretsDb = db;
}

export function setDashboardDb(db: Database): void {
	dashboardDb = db;
}

// Test-only seam. Production wiring leaves these undefined and the plugins
// API uses the default GitHub fetcher and the canonical settings.json /
// curated overlay paths.
export function setPluginsApiOverridesForTests(
	overrides: Pick<PluginsApiDeps, "fetcher" | "settingsPath" | "overlayPath">,
): void {
	pluginsApiOverrides = overrides;
}

export function clearPluginsApiOverridesForTests(): void {
	pluginsApiOverrides = {};
}

export function setSecretSavedCallback(fn: SecretSavedCallback): void {
	onSecretSaved = fn;
}

export function setPublicDir(dir: string): void {
	publicDir = dir;
}

export function getPublicDir(): string {
	return publicDir;
}

export function getSessionCookie(req: Request): string | null {
	const cookies = req.headers.get("Cookie") ?? "";
	const match = cookies.match(/(?:^|;\s*)phantom_session=([^;]*)/);
	return match ? decodeURIComponent(match[1]) : null;
}

export function isAuthenticated(req: Request): boolean {
	const token = getSessionCookie(req);
	return token !== null && isValidSession(token);
}

function isPathSafe(urlPath: string): string | null {
	try {
		const decoded = decodeURIComponent(urlPath);

		// Reject null bytes
		if (decoded.includes("\0")) return null;

		const cleaned = decoded.replace(/^\/ui\/?/, "/");
		const target = resolve(publicDir, cleaned.replace(/^\/+/, ""));
		const rel = relative(publicDir, target);

		// Must be within publicDir (no ../ traversal)
		if (rel.startsWith("..") || rel.includes("..")) return null;

		return target;
	} catch {
		return null;
	}
}

function buildSetCookieHeader(sessionToken: string): string {
	return `${COOKIE_NAME}=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}`;
}

// Build a Headers object that sets the new cookie AND expires the old
// Path=/ui cookie. Browsers that upgraded from the pre-PR1 cookie path
// have both a Path=/ui and a Path=/ cookie. Per RFC 6265, the more
// specific path takes precedence in the Cookie header, so the stale
// token gets matched by getSessionCookie first. Expiring the old one
// on every successful login clears this.
function buildCookieHeaders(sessionToken: string): Headers {
	const headers = new Headers();
	headers.append("Set-Cookie", buildSetCookieHeader(sessionToken));
	headers.append("Set-Cookie", `${COOKIE_NAME}=; Path=/ui; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
	return headers;
}

export async function handleUiRequest(req: Request): Promise<Response> {
	const url = new URL(req.url);

	// Login page - always accessible (GET)
	if (url.pathname === "/ui/login" && req.method === "GET") {
		return new Response(loginPageHtml(), {
			headers: { "Content-Type": "text/html; charset=utf-8" },
		});
	}

	// Login action (POST) - validates token, sets cookie
	if (url.pathname === "/ui/login" && req.method === "POST") {
		return handleLoginPost(req);
	}

	// Secret collection form - magic link IS the auth, must be before general auth check
	const secretFormMatch = url.pathname.match(/^\/ui\/secrets\/([a-z0-9_]+)$/);
	if (secretFormMatch && req.method === "GET") {
		return handleSecretFormGet(req, url, secretFormMatch[1]);
	}

	// Secret save API
	const secretSaveMatch = url.pathname.match(/^\/ui\/api\/secrets\/([a-z0-9_]+)$/);
	if (secretSaveMatch && req.method === "POST") {
		if (!isAuthenticated(req)) {
			return Response.json({ error: "Unauthorized" }, { status: 401 });
		}
		return handleSecretSave(req, secretSaveMatch[1]);
	}

	// Public assets (logo, favicon) - no auth needed
	if (url.pathname === "/ui/phantom-logo.svg") {
		const filePath = isPathSafe(url.pathname);
		if (filePath) {
			const file = Bun.file(filePath);
			if (await file.exists()) {
				return new Response(file, {
					headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" },
				});
			}
		}
	}

	// Everything else requires auth
	if (!isAuthenticated(req)) {
		// For HTML requests, redirect. For others, return 401.
		const accept = req.headers.get("Accept") ?? "";
		if (accept.includes("text/html")) {
			return Response.redirect("/ui/login", 302);
		}
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	// SSE endpoint
	if (url.pathname === "/ui/api/events") {
		return createSSEResponse();
	}

	// Dashboard API routes (PR1). Return as soon as one matches so the static
	// file fallthrough below never sees them.
	if (url.pathname.startsWith("/ui/api/skills")) {
		if (!dashboardDb) {
			return Response.json({ error: "Dashboard API not initialized" }, { status: 503 });
		}
		const apiResponse = await handleSkillsApi(req, url, { db: dashboardDb });
		if (apiResponse) return apiResponse;
	}
	if (url.pathname.startsWith("/ui/api/memory-files")) {
		if (!dashboardDb) {
			return Response.json({ error: "Dashboard API not initialized" }, { status: 503 });
		}
		const apiResponse = await handleMemoryFilesApi(req, url, { db: dashboardDb });
		if (apiResponse) return apiResponse;
	}
	if (url.pathname.startsWith("/ui/api/plugins")) {
		if (!dashboardDb) {
			return Response.json({ error: "Dashboard API not initialized" }, { status: 503 });
		}
		const apiResponse = await handlePluginsApi(req, url, { db: dashboardDb, ...pluginsApiOverrides });
		if (apiResponse) return apiResponse;
	}
	if (url.pathname.startsWith("/ui/api/subagents")) {
		if (!dashboardDb) {
			return Response.json({ error: "Dashboard API not initialized" }, { status: 503 });
		}
		const apiResponse = await handleSubagentsApi(req, url, { db: dashboardDb });
		if (apiResponse) return apiResponse;
	}
	if (url.pathname.startsWith("/ui/api/hooks")) {
		if (!dashboardDb) {
			return Response.json({ error: "Dashboard API not initialized" }, { status: 503 });
		}
		const apiResponse = await handleHooksApi(req, url, { db: dashboardDb });
		if (apiResponse) return apiResponse;
	}
	if (url.pathname.startsWith("/ui/api/settings")) {
		if (!dashboardDb) {
			return Response.json({ error: "Dashboard API not initialized" }, { status: 503 });
		}
		const apiResponse = await handleSettingsApi(req, url, { db: dashboardDb });
		if (apiResponse) return apiResponse;
	}

	// Static files
	const filePath = isPathSafe(url.pathname);
	if (!filePath) {
		return new Response("Forbidden", { status: 403 });
	}

	const file = Bun.file(filePath);
	if (await file.exists()) {
		return new Response(file, {
			headers: { "Cache-Control": "no-cache" },
		});
	}

	// Try index.html for directory-like paths
	const indexFile = Bun.file(resolve(filePath, "index.html"));
	if (await indexFile.exists()) {
		return new Response(indexFile, {
			headers: { "Cache-Control": "no-cache" },
		});
	}

	return new Response("Not found", { status: 404 });
}

function handleSecretFormGet(_req: Request, url: URL, requestId: string): Response {
	if (!secretsDb) {
		return Response.json({ error: "Secrets not configured" }, { status: 500 });
	}

	const magicToken = url.searchParams.get("magic");
	const request = getSecretRequest(secretsDb, requestId);

	if (!request) {
		return new Response(secretsExpiredHtml(), {
			status: 404,
			headers: { "Content-Type": "text/html; charset=utf-8" },
		});
	}

	if (request.status === "completed") {
		return new Response(secretsExpiredHtml(), {
			headers: { "Content-Type": "text/html; charset=utf-8" },
		});
	}

	if (new Date(request.expiresAt) < new Date()) {
		return new Response(secretsExpiredHtml(), {
			headers: { "Content-Type": "text/html; charset=utf-8" },
		});
	}

	// Authenticate via magic token and set session cookie
	if (magicToken && validateMagicToken(secretsDb, requestId, magicToken)) {
		const { sessionToken } = createSession();
		const cookieHeaders = buildCookieHeaders(sessionToken);
		cookieHeaders.set("Content-Type", "text/html; charset=utf-8");
		return new Response(secretsFormHtml(request), {
			headers: cookieHeaders,
		});
	}

	// If already authenticated via cookie, show the form
	if (_req && isAuthenticated(_req)) {
		return new Response(secretsFormHtml(request), {
			headers: { "Content-Type": "text/html; charset=utf-8" },
		});
	}

	// No valid auth
	return new Response(secretsExpiredHtml(), {
		status: 401,
		headers: { "Content-Type": "text/html; charset=utf-8" },
	});
}

async function handleSecretSave(req: Request, requestId: string): Promise<Response> {
	if (!secretsDb) {
		return Response.json({ error: "Secrets not configured" }, { status: 500 });
	}

	let body: { secrets?: Record<string, string> };
	try {
		body = (await req.json()) as { secrets?: Record<string, string> };
	} catch {
		return Response.json({ error: "Invalid request body" }, { status: 400 });
	}

	if (!body.secrets || typeof body.secrets !== "object") {
		return Response.json({ error: "secrets field is required" }, { status: 400 });
	}

	try {
		const { saved } = saveSecrets(secretsDb, requestId, body.secrets);

		// Fire notification callback (non-blocking)
		if (onSecretSaved) {
			onSecretSaved(requestId, saved).catch((error: unknown) => {
				const msg = error instanceof Error ? error.message : String(error);
				console.warn(`[secrets] Notification callback failed: ${msg}`);
			});
		}

		return Response.json({ ok: true, saved });
	} catch (error: unknown) {
		const msg = error instanceof Error ? error.message : String(error);
		return Response.json({ error: msg }, { status: 400 });
	}
}

async function handleLoginPost(req: Request): Promise<Response> {
	let body: { token?: string };
	try {
		body = (await req.json()) as { token?: string };
	} catch {
		return Response.json({ error: "Invalid request body" }, { status: 400 });
	}

	if (!body.token || typeof body.token !== "string") {
		return Response.json({ error: "Token is required" }, { status: 400 });
	}

	// Try as magic link token first
	const sessionToken = consumeMagicLink(body.token);
	if (sessionToken) {
		const cookieHeaders = buildCookieHeaders(sessionToken);
		cookieHeaders.set("Content-Type", "application/json");
		return new Response(JSON.stringify({ ok: true }), {
			headers: cookieHeaders,
		});
	}

	// Try as direct session token
	if (isValidSession(body.token)) {
		const cookieHeaders = buildCookieHeaders(body.token);
		cookieHeaders.set("Content-Type", "application/json");
		return new Response(JSON.stringify({ ok: true }), {
			headers: cookieHeaders,
		});
	}

	return Response.json({ error: "Invalid or expired token" }, { status: 401 });
}
