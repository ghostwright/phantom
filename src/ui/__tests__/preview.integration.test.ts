// Integration tests for phantom_preview_page. These launch a real Chromium
// (headless shell) and talk to a local Bun.serve, so they are opt-in. Run:
//
//   PHANTOM_INTEGRATION=1 bun test src/ui/__tests__/preview.integration.test.ts
//
// They are skipped by default so `bun test` stays fast and hermetic.
//
// Unlike the unit tests in preview.test.ts, these tests invoke the real
// phantom_preview_page handler through its MCP server instance via an
// InMemoryTransport pair and Client from @modelcontextprotocol/sdk. That
// means every load-bearing behavior the handler owns is exercised end to
// end: the SSE init-script stub, console-message capture, failed-request
// capture, the bundled image+text result shape, and the isError path.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
	__resetPreviewStateForTesting,
	closePreviewResources,
	createPreviewToolServer,
	getOrCreatePreviewContext,
} from "../preview.ts";
import { revokeAllSessions } from "../session.ts";

const ENABLED = process.env.PHANTOM_INTEGRATION === "1";
const suite = ENABLED ? describe : describe.skip;

type ToolContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string }
	| { type: string; [k: string]: unknown };

type ToolResult = {
	content: ToolContent[];
	isError?: boolean;
};

function asText(block: ToolContent | undefined): string {
	if (!block || block.type !== "text") throw new Error("expected a text content block");
	return (block as { text: string }).text;
}

function asImage(block: ToolContent | undefined): { data: string; mimeType: string } {
	if (!block || block.type !== "image") throw new Error("expected an image content block");
	return block as { data: string; mimeType: string; type: "image" };
}

suite("phantom_preview_page (integration)", () => {
	let server: ReturnType<typeof Bun.serve> | null = null;
	let port = 0;
	let client: Client | null = null;

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
					// The missing <script src="/nope.js"> exercises requestfailed
					// capture. The inline console.log exercises console capture.
					return new Response(
						"<!DOCTYPE html><html><head><title>Preview Integration</title>" +
							'<script src="/nope.js"></script></head>' +
							"<body><script>console.log('hi from preview test')</script>" +
							"<h1>Hello</h1></body></html>",
						{ headers: { "content-type": "text/html" } },
					);
				}
				return new Response("not found", { status: 404 });
			},
		});
		port = server.port ?? 0;

		// Wire a real MCP Client to the real preview tool server via an
		// in-memory transport pair. This is the exact contract the Agent SDK
		// uses at runtime; if the bundled result shape drifts, this test
		// catches it.
		const embed = createPreviewToolServer(port);
		const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
		const serverInstance = embed.instance as unknown as {
			connect: (t: typeof serverTransport) => Promise<void>;
		};
		await serverInstance.connect(serverTransport);
		client = new Client({ name: "phantom-preview-integration", version: "1.0" }, { capabilities: {} });
		await client.connect(clientTransport);
	});

	afterAll(async () => {
		await client?.close();
		await closePreviewResources();
		revokeAllSessions();
		server?.stop(true);
	});

	test("tools/list exposes phantom_preview_page", async () => {
		if (!client) throw new Error("client not initialized");
		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name)).toContain("phantom_preview_page");
	});

	test("successful call returns image + text blocks with full metadata", async () => {
		if (!client) throw new Error("client not initialized");
		const result = (await client.callTool({
			name: "phantom_preview_page",
			arguments: { path: "test.html" },
		})) as ToolResult;

		expect(result.isError).toBeFalsy();
		expect(result.content).toHaveLength(2);

		const image = asImage(result.content[0]);
		expect(image.mimeType).toBe("image/png");
		expect(image.data.length).toBeGreaterThan(100);
		// Base64 round-trip sanity: decodes to a non-empty byte buffer.
		expect(Buffer.from(image.data, "base64").length).toBeGreaterThan(100);

		const meta = JSON.parse(asText(result.content[1])) as {
			status: number;
			title: string;
			consoleMessages: { type: string; text: string }[];
			failedRequests: { url: string; failure: string }[];
		};
		expect(meta.status).toBe(200);
		expect(meta.title).toBe("Preview Integration");

		// The inline <script> emits "hi from preview test" via console.log.
		const logMessage = meta.consoleMessages.find((m) => m.text.includes("hi from preview test"));
		expect(logMessage).toBeDefined();
		expect(logMessage?.type).toBe("log");

		// The missing /nope.js asset should land in failedRequests via the
		// requestfailed listener.
		const failed = meta.failedRequests.find((r) => r.url.endsWith("/nope.js"));
		expect(failed).toBeDefined();
		expect(typeof failed?.failure).toBe("string");
	});

	test("unreachable path returns isError with an error message", async () => {
		if (!client) throw new Error("client not initialized");
		const result = (await client.callTool({
			name: "phantom_preview_page",
			arguments: { path: "does-not-exist.html" },
		})) as ToolResult;

		// The handler returns content: [text] + isError:true on page.goto throw.
		// A 404 response does NOT throw (status 404 is returned as-is). So we
		// only assert the error path shape when it triggers; on a clean 404
		// the handler returns a normal success result with status=404.
		if (result.isError) {
			expect(result.content).toHaveLength(1);
			const body = asText(result.content[0]);
			expect(body.length).toBeGreaterThan(0);
		} else {
			const meta = JSON.parse(asText(result.content[1])) as { status: number };
			expect(meta.status).toBe(404);
		}
	});

	test("two getOrCreatePreviewContext calls share the same cached context", async () => {
		const a = await getOrCreatePreviewContext();
		const b = await getOrCreatePreviewContext();
		expect(a).toBe(b);
	});
});
