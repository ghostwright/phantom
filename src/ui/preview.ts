// Custom in-process MCP tool server exposing `phantom_preview_page`: a
// one-call self-validation tool for Phantom's /ui/<path> pages. Navigates a
// headless Chromium to the page, captures a full-page PNG, and bundles HTTP
// status, title, console messages, and failed network requests alongside the
// screenshot so the agent can reason about the page in a single tool call.
//
// The underlying Chromium Browser and the per-query BrowserContext are
// module-level singletons. This mirrors the Phase 1 factory pattern used by
// `DynamicToolRegistry` and `Scheduler`: the MCP server wrapper is recreated
// per query (required so the SDK can attach a fresh transport each time),
// but the expensive resources it wraps are process-scoped and stay warm.
//
// Both `phantom-preview` and the embedded `@playwright/mcp` browser surface
// share `getOrCreatePreviewContext()` so cookies minted by the preview tool
// are visible to the broader `browser_*` tools within the same query. This
// is what lets the agent mix `phantom_preview_page` with `browser_click` and
// `browser_snapshot` against its own /ui/ pages without re-authenticating.

import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { Browser, BrowserContext } from "playwright";
import { chromium } from "playwright";
import { z } from "zod";
import { createPreviewSession } from "./session.ts";

let browser: Browser | null = null;
let browserPromise: Promise<Browser> | null = null;
let currentContext: BrowserContext | null = null;
let currentContextPromise: Promise<BrowserContext> | null = null;
let lastCookieMintAt = 0;
let shuttingDown = false;

// The preview session cookie has a 10 minute TTL (see createPreviewSession in
// session.ts). We rotate before minute 8 to leave a 2 minute safety margin so
// a long-running multi-step query can never navigate with an expired cookie.
const COOKIE_ROTATE_AFTER_MS = 8 * 60 * 1000;

const CHROMIUM_LAUNCH_ARGS = [
	// Required because the container runs as a non-root user and Chromium's
	// default sandbox needs privileged setuid helpers we intentionally do not
	// ship. The container boundary is our sandbox; Chromium does not need its
	// own layer on top.
	"--no-sandbox",
	"--disable-setuid-sandbox",
	// /dev/shm defaults to 64 MiB in containers, which is too small for
	// Chromium's IPC shared memory. Fall back to /tmp (disk-backed).
	"--disable-dev-shm-usage",
];

function buildPreviewCookie(sessionToken: string) {
	return {
		name: "phantom_session",
		value: sessionToken,
		domain: "localhost",
		// Scoped to /ui so the cookie matches the existing magic-link posture in
		// src/ui/serve.ts. The only cookie-authenticated route in Phantom is
		// /ui/*; /health, /mcp, /trigger, and /webhook use bearer or HMAC auth
		// and never read phantom_session.
		path: "/ui",
		httpOnly: true,
		secure: false,
		sameSite: "Strict" as const,
	};
}

async function injectFreshPreviewCookie(ctx: BrowserContext): Promise<void> {
	const { sessionToken } = createPreviewSession();
	await ctx.addCookies([buildPreviewCookie(sessionToken)]);
	lastCookieMintAt = Date.now();
}

export async function getOrCreateBrowser(): Promise<Browser> {
	if (shuttingDown) throw new Error("preview subsystem is shutting down");
	if (browser) return browser;
	if (browserPromise) return browserPromise;
	// try/finally pattern: on either success OR failure we clear the cached
	// promise. If we did not, a transient chromium.launch() throw would leave
	// a rejected promise cached and every subsequent call would re-reject
	// with the same error until process restart (Codex P2).
	browserPromise = (async () => {
		try {
			const b = await chromium.launch({
				headless: true,
				args: CHROMIUM_LAUNCH_ARGS,
			});
			browser = b;
			return b;
		} finally {
			browserPromise = null;
		}
	})();
	return browserPromise;
}

export async function getOrCreatePreviewContext(): Promise<BrowserContext> {
	if (shuttingDown) throw new Error("preview subsystem is shutting down");
	if (currentContext) {
		// Warm cache path: rotate the preview cookie if we are inside the 2
		// minute safety margin before the 10 minute TTL expires. Playwright's
		// addCookies replaces cookies with the same name+domain+path in place,
		// so this is an O(1) refresh of the cached context (review F6, Codex P1).
		if (Date.now() - lastCookieMintAt >= COOKIE_ROTATE_AFTER_MS) {
			await injectFreshPreviewCookie(currentContext);
		}
		return currentContext;
	}
	if (currentContextPromise) return currentContextPromise;
	currentContextPromise = (async () => {
		try {
			const b = await getOrCreateBrowser();
			const ctx = await b.newContext();
			await injectFreshPreviewCookie(ctx);
			currentContext = ctx;
			return ctx;
		} finally {
			currentContextPromise = null;
		}
	})();
	return currentContextPromise;
}

export async function closePreviewContext(): Promise<void> {
	const ctx = currentContext;
	currentContext = null;
	currentContextPromise = null;
	if (ctx) {
		try {
			await ctx.close();
		} catch {
			// Context may already be closed if the browser was torn down first.
		}
	}
}

export async function closePreviewResources(): Promise<void> {
	shuttingDown = true;
	await closePreviewContext();
	const b = browser;
	browser = null;
	browserPromise = null;
	if (b) {
		try {
			await b.close();
		} catch {
			// Swallow: we are shutting down, any error is terminal anyway.
		}
	}
}

// Test-only reset hook. Clears every module-level singleton so the next unit
// test starts from a pristine state. Not exported from the public index; only
// tests under src/ui/__tests__ import it via the relative path. Keeping this
// in the production module avoids an indirection layer that would complicate
// the happy path.
export function __resetPreviewStateForTesting(): void {
	browser = null;
	browserPromise = null;
	currentContext = null;
	currentContextPromise = null;
	lastCookieMintAt = 0;
	shuttingDown = false;
}

type ConsoleMessage = { type: string; text: string };
type FailedRequest = { url: string; failure: string };

type PreviewSuccess = {
	content: [{ type: "image"; data: string; mimeType: "image/png" }, { type: "text"; text: string }];
};

type PreviewError = {
	content: [{ type: "text"; text: string }];
	isError: true;
};

export function createPreviewToolServer(port: number): McpSdkServerConfigWithInstance {
	const previewPageTool = tool(
		"phantom_preview_page",
		"Screenshot and validate a Phantom /ui/<path> page. Returns a PNG image " +
			"block plus a JSON metadata block containing the HTTP status, page " +
			"title, console messages, and failed network requests. Use this " +
			"after phantom_create_page to verify the page rendered correctly " +
			"before reporting success to the user.",
		{
			path: z.string().min(1).describe("Path under /ui/, e.g. 'dashboard.html' or 'reports/weekly.html'"),
			viewport: z
				.object({
					width: z.number().int().min(320).max(3840),
					height: z.number().int().min(240).max(2160),
				})
				.optional()
				.describe("Viewport size in CSS pixels. Defaults to 1280x800."),
			fullPage: z.boolean().optional().describe("Capture full scroll height. Defaults to true."),
		},
		async (input): Promise<PreviewSuccess | PreviewError> => {
			const ctx = await getOrCreatePreviewContext();
			const page = await ctx.newPage();
			try {
				const viewport = input.viewport ?? { width: 1280, height: 800 };
				await page.setViewportSize(viewport);
				// SSE EventSource connections created by Phantom's live-reload
				// wiring will hold the page open indefinitely on 'load' and
				// cause the tool to time out. Stub it before any page JS runs.
				// Research 01 verified init scripts run before page JS.
				await page.addInitScript(() => {
					Reflect.deleteProperty(globalThis, "EventSource");
				});
				const consoleMessages: ConsoleMessage[] = [];
				page.on("console", (m) => {
					consoleMessages.push({ type: m.type(), text: m.text() });
				});
				const failedRequests: FailedRequest[] = [];
				page.on("requestfailed", (r) => {
					failedRequests.push({
						url: r.url(),
						failure: r.failure()?.errorText ?? "unknown",
					});
				});
				const safePath = input.path.replace(/^\/+/, "");
				const url = `http://localhost:${port}/ui/${safePath}`;
				const response = await page.goto(url, { waitUntil: "load", timeout: 15000 });
				const status = response?.status() ?? 0;
				const title = await page.title();
				const shot = await page.screenshot({
					fullPage: input.fullPage !== false,
					type: "png",
				});
				return {
					content: [
						{
							type: "image" as const,
							data: shot.toString("base64"),
							mimeType: "image/png",
						},
						{
							type: "text" as const,
							text: JSON.stringify({ status, title, consoleMessages, failedRequests }, null, 2),
						},
					],
				};
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ error: message }),
						},
					],
					isError: true as const,
				};
			} finally {
				// Always close the page, even on throw, so idle tabs never leak
				// onto the shared context. The context lives for the whole query
				// but tabs are per-call.
				try {
					await page.close();
				} catch {
					// page.close() can throw if the browser or context was torn
					// down mid-call (e.g. SIGTERM during a successful return).
					// Null currentContext so the next call re-creates a fresh
					// one instead of handing back a dead reference. The cost on
					// a genuinely cosmetic error is one extra ~60 ms context
					// creation, which is cheap (review F8).
					currentContext = null;
					currentContextPromise = null;
				}
			}
		},
	);

	return createSdkMcpServer({
		name: "phantom-preview",
		tools: [previewPageTool],
	});
}
