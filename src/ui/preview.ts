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

export async function getOrCreateBrowser(): Promise<Browser> {
	if (browser) return browser;
	if (browserPromise) return browserPromise;
	browserPromise = (async () => {
		const b = await chromium.launch({
			headless: true,
			args: CHROMIUM_LAUNCH_ARGS,
		});
		browser = b;
		browserPromise = null;
		return b;
	})();
	return browserPromise;
}

export async function getOrCreatePreviewContext(): Promise<BrowserContext> {
	if (currentContext) return currentContext;
	if (currentContextPromise) return currentContextPromise;
	currentContextPromise = (async () => {
		const b = await getOrCreateBrowser();
		const ctx = await b.newContext();
		const { sessionToken } = createPreviewSession();
		// Scoped to localhost: external navigations initiated by any browser_*
		// tool will not see this cookie, so the auth surface stays identical to
		// the existing /ui/ cookie model.
		await ctx.addCookies([
			{
				name: "phantom_session",
				value: sessionToken,
				domain: "localhost",
				path: "/",
				httpOnly: true,
				secure: false,
				sameSite: "Strict",
			},
		]);
		currentContext = ctx;
		currentContextPromise = null;
		return ctx;
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
					(window as unknown as { EventSource: undefined }).EventSource = undefined;
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
					// Page already closed by cleanup path.
				}
			}
		},
	);

	return createSdkMcpServer({
		name: "phantom-preview",
		tools: [previewPageTool],
	});
}
