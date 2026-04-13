// Integration tests for createBrowserToolServer. These exercise the real
// @playwright/mcp embed with a real BrowserContext. Opt-in:
//
//   PHANTOM_INTEGRATION=1 bun test src/ui/__tests__/browser-mcp.integration.test.ts
//
// Skipped by default so `bun test` stays hermetic.

import { afterAll, describe, expect, test } from "bun:test";
import { createBrowserToolServer } from "../browser-mcp.ts";
import { closePreviewResources, getOrCreatePreviewContext } from "../preview.ts";
import { revokeAllSessions } from "../session.ts";

const ENABLED = process.env.PHANTOM_INTEGRATION === "1";
const suite = ENABLED ? describe : describe.skip;

suite("createBrowserToolServer (integration)", () => {
	afterAll(async () => {
		await closePreviewResources();
		revokeAllSessions();
	});

	test("builds an embed server wired to a shared BrowserContext", async () => {
		const embed = await createBrowserToolServer(() => getOrCreatePreviewContext());
		expect(embed.type).toBe("sdk");
		expect(embed.name).toBe("phantom-browser");
		const inst = embed.instance as unknown as {
			connect: unknown;
			close: () => Promise<void>;
		};
		expect(typeof inst.connect).toBe("function");
		await inst.close();
	});
});
