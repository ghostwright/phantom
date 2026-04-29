// Integration tests for createBrowserToolServer. These exercise the real
// @playwright/mcp embed with a real BrowserContext. Opt-in:
//
//   PHANTOM_INTEGRATION=1 bun test src/ui/__tests__/browser-mcp.integration.test.ts
//
// Skipped by default so `bun test` stays hermetic.
//
// Two load-bearing invariants are enforced here:
//
//  1. The embed exposes exactly 21 tools. @playwright/mcp@0.0.70 is pinned
//     specifically so the tool surface cannot drift silently; this assertion
//     is the drift detector the pin was meant to anchor.
//
//  2. A real `browser_navigate` call succeeds against a BrowserContext
//     minted by the preview tool. This is the end-to-end verification of
//     the cross-version playwright-core boundary documented in
//     src/ui/browser-mcp.ts note 3: the context is an instance from
//     playwright-core@1.59.1 consumed by @playwright/mcp's hoisted
//     playwright-core@1.60.0-alpha SimpleBrowser wrapper.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBrowserToolServer } from "../browser-mcp.ts";
import { __resetPreviewStateForTesting, closePreviewResources, getOrCreatePreviewContext } from "../preview.ts";
import { revokeAllSessions } from "../session.ts";

const ENABLED = process.env.PHANTOM_INTEGRATION === "1";
const suite = ENABLED ? describe : describe.skip;

const EXPECTED_TOOL_NAMES = [
	"browser_click",
	"browser_close",
	"browser_console_messages",
	"browser_drag",
	"browser_evaluate",
	"browser_file_upload",
	"browser_fill_form",
	"browser_handle_dialog",
	"browser_hover",
	"browser_navigate",
	"browser_navigate_back",
	"browser_network_requests",
	"browser_press_key",
	"browser_resize",
	"browser_run_code",
	"browser_select_option",
	"browser_snapshot",
	"browser_tabs",
	"browser_take_screenshot",
	"browser_type",
	"browser_wait_for",
];

type CallResult = { isError?: boolean; content: unknown };

suite("createBrowserToolServer (integration)", () => {
	let server: ReturnType<typeof Bun.serve> | null = null;
	let port = 0;
	let client: Client | null = null;
	let embed: Awaited<ReturnType<typeof createBrowserToolServer>> | null = null;

	beforeAll(async () => {
		// Reset module-level preview state so running this file after any
		// other test file that called closePreviewResources() still starts
		// from a pristine state. Bun shares module instances across test
		// files inside the same process.
		__resetPreviewStateForTesting();
		server = Bun.serve({
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				if (url.pathname === "/ui/test.html") {
					return new Response(
						"<!DOCTYPE html><html><head><title>Browser MCP Integration</title></head>" +
							"<body><h1>Hello</h1></body></html>",
						{ headers: { "content-type": "text/html" } },
					);
				}
				return new Response("not found", { status: 404 });
			},
		});
		port = server.port ?? 0;

		embed = await createBrowserToolServer(() => getOrCreatePreviewContext());
		const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
		const serverInstance = embed.instance as unknown as {
			connect: (t: typeof serverTransport) => Promise<void>;
			close: () => Promise<void>;
		};
		await serverInstance.connect(serverTransport);
		client = new Client({ name: "phantom-browser-integration", version: "1.0" }, { capabilities: {} });
		await client.connect(clientTransport);
	});

	afterAll(async () => {
		await client?.close();
		if (embed) {
			const inst = embed.instance as unknown as { close: () => Promise<void> };
			await inst.close();
		}
		await closePreviewResources();
		revokeAllSessions();
		server?.stop(true);
	});

	test("listTools returns exactly the 21-tool @playwright/mcp surface", async () => {
		if (!client) throw new Error("client not initialized");
		const { tools } = await client.listTools();
		expect(tools).toHaveLength(21);
		const names = tools.map((t) => t.name).sort();
		expect(names).toEqual([...EXPECTED_TOOL_NAMES].sort());
	});

	test("browser_navigate succeeds across the cross-version BrowserContext boundary", async () => {
		if (!client) throw new Error("client not initialized");
		const result = (await client.callTool({
			name: "browser_navigate",
			arguments: { url: `http://localhost:${port}/ui/test.html` },
		})) as CallResult;
		// A successful navigate returns content with no isError flag set.
		// The exact content shape is @playwright/mcp's concern; we care only
		// that the call did not land in the error branch.
		expect(result.isError).toBeFalsy();
		expect(result.content).toBeDefined();
	});
});
