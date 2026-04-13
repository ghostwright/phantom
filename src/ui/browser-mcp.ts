// Embed factory for the first-party `@playwright/mcp` 21-tool surface. We
// host it in-process via `createConnection(config, contextGetter)` rather
// than spawning it as a stdio subprocess: the subprocess path hangs on
// Linux amd64 under Bun (see research 01b, five-probe trace in findings
// Section 3), and the in-process path lets us share one Chromium Browser
// and one BrowserContext with `phantom_preview_page`.
//
// Two load-bearing details:
//
//  1. `browser.isolated: false` is mandatory when using `contextGetter`.
//     Playwright MCP's SimpleBrowser.newContext() throws
//     ("Creating a new context is not supported in SimpleBrowserContextFactory")
//     and the MCP backend only calls `newContext` when `isolated` is true.
//     With `isolated: false`, the backend defers to our contextGetter and
//     never touches its own context factory.
//
//  2. The return type of `createConnection` is the low-level
//     `Server` class from `@modelcontextprotocol/sdk`, not the high-level
//     `McpServer`. Both inherit `.connect(transport)` from `Protocol`, and
//     the Agent SDK's `connectSdkMcpServer` only ever calls
//     `.connect(transport)` on the stored instance. The declared
//     `McpSdkServerConfigWithInstance.instance: McpServer` type is narrower
//     than the runtime contract. We widen with a single
//     `as unknown as McpServer` cast, which is the minimum-surface type
//     escape hatch the CLAUDE.md standards allow for this exact case.
//     See findings 01b Section 3.3 for the source citation.
//
//  3. Two `playwright-core` versions coexist in `node_modules`. `src/ui/preview.ts`
//     launches via `playwright@1.59.1 -> nested playwright-core@1.59.1` at
//     `node_modules/playwright/node_modules/playwright-core`, while
//     `@playwright/mcp@0.0.70` resolves via the hoisted top-level
//     `playwright-core@1.60.0-alpha-1774999321000` at `node_modules/playwright-core`.
//     No `playwright-core` is nested under `@playwright/mcp/node_modules`
//     itself; only a nested `playwright` wrapper is there. The `BrowserContext`
//     we hand across the boundary is an instance from `1.59.1` consumed by
//     `1.60.0-alpha`'s `SimpleBrowser` wrapper. The public `BrowserContext`
//     API (`contexts()`, `addCookies`, `newPage`) is stable across this
//     version range. The cross-version bridge is verified end to end by the
//     integration test at `src/ui/__tests__/browser-mcp.integration.test.ts`,
//     which drives a real `browser_navigate` through the embed against a
//     context minted by `getOrCreatePreviewContext()`. We declare the
//     `getContext` parameter against the top-level `playwright` type (what
//     every caller in this codebase has on hand) and widen the function
//     reference at the `createConnection` boundary. Any change to this line
//     should preserve that single-point widening.

import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createConnection } from "@playwright/mcp";
import type { BrowserContext } from "playwright";

// @playwright/mcp's createConnection declares contextGetter against the
// hoisted playwright-core@1.60.0-alpha types, while our callers hold a
// BrowserContext from the nested playwright-core@1.59.1. The public surface
// SimpleBrowser touches is stable across both versions. See header note 3
// for the full explanation and the runtime verification path.
type AnyContextGetter = Parameters<typeof createConnection>[1];

export async function createBrowserToolServer(
	getContext: () => Promise<BrowserContext>,
): Promise<McpSdkServerConfigWithInstance> {
	const server = await createConnection(
		{
			browser: {
				// Mandatory: see file header for the newContext() throw.
				isolated: false,
			},
			outputDir: "/tmp/phantom-browser-mcp-out",
			imageResponses: "allow",
		},
		getContext as unknown as AnyContextGetter,
	);
	return {
		type: "sdk" as const,
		name: "phantom-browser",
		// Structural widening: Server has the same .connect(transport) the
		// Agent SDK calls on McpServer. See file header for the full
		// justification and the source citation.
		instance: server as unknown as McpServer,
	};
}
