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
//  3. `@playwright/mcp@0.0.70` ships a nested `playwright-core` under its
//     own `node_modules`, so its `BrowserContext` type root is structurally
//     identical to but nominally disjoint from the top-level `playwright`
//     package's `BrowserContext`. At runtime they are the same object (the
//     nested playwright-core is never constructed; we pass in our own
//     context). We declare the `getContext` parameter against the top-level
//     type (what every caller in this codebase has on hand) and widen the
//     function reference to `unknown` at the `createConnection` boundary.
//     Any change to this line should preserve that single-point widening.

import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createConnection } from "@playwright/mcp";
import type { BrowserContext } from "playwright";

// @playwright/mcp's createConnection declares contextGetter against its own
// nested playwright-core types. At runtime both roots are structurally the
// same BrowserContext; see header note 3 for the full explanation.
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
