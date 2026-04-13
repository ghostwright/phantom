import { describe, expect, test } from "bun:test";
import type { BrowserContext } from "playwright";
import { createBrowserToolServer } from "../browser-mcp.ts";

// The real @playwright/mcp createConnection is lazy: it wires a backend
// factory that will call the contextGetter only when a client actually
// requests a tool. Constructing the embed does not require a live
// BrowserContext, so these tests never touch Chromium.
function fakeContextGetter(): Promise<BrowserContext> {
	return Promise.reject(new Error("contextGetter should not run in unit tests"));
}

describe("createBrowserToolServer", () => {
	test("returns an SDK MCP server config with the phantom-browser name", async () => {
		const config = await createBrowserToolServer(fakeContextGetter);
		expect(config.type).toBe("sdk");
		expect(config.name).toBe("phantom-browser");
		expect(config.instance).toBeDefined();
	});

	test("instance exposes the MCP connect() contract used by the Agent SDK", async () => {
		const config = await createBrowserToolServer(fakeContextGetter);
		const inst = config.instance as unknown as { connect: unknown; close: unknown };
		expect(typeof inst.connect).toBe("function");
		expect(typeof inst.close).toBe("function");
	});

	test("each call returns a distinct underlying Server instance", async () => {
		const a = await createBrowserToolServer(fakeContextGetter);
		const b = await createBrowserToolServer(fakeContextGetter);
		// Factory pattern: the phantom-browser wrapper must be fresh per query.
		// If the same instance leaks across calls the SDK will throw "Already
		// connected to a transport" on the second run. See src/index.ts for
		// the cardinal rule citation.
		expect(a.instance).not.toBe(b.instance);
	});
});
