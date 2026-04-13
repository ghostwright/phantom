// Integration tests for phantom_preview_page. These launch a real Chromium
// (headless shell) and talk to a local Bun.serve, so they are opt-in. Run:
//
//   PHANTOM_INTEGRATION=1 bun test src/ui/__tests__/preview.integration.test.ts
//
// They are skipped by default so `bun test` stays fast and hermetic.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closePreviewResources, getOrCreatePreviewContext } from "../preview.ts";
import { revokeAllSessions } from "../session.ts";

const ENABLED = process.env.PHANTOM_INTEGRATION === "1";
const suite = ENABLED ? describe : describe.skip;

suite("phantom_preview_page (integration)", () => {
	let server: ReturnType<typeof Bun.serve> | null = null;
	let port = 0;

	beforeAll(() => {
		server = Bun.serve({
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				if (url.pathname === "/ui/test.html") {
					return new Response(
						"<!DOCTYPE html><html><head><title>Preview Integration</title></head>" +
							"<body><script>console.log('hi from preview test')</script>" +
							"<h1>Hello</h1></body></html>",
						{ headers: { "content-type": "text/html" } },
					);
				}
				return new Response("not found", { status: 404 });
			},
		});
		port = server.port ?? 0;
	});

	afterAll(async () => {
		await closePreviewResources();
		revokeAllSessions();
		server?.stop(true);
	});

	test("navigates and screenshots a live page", async () => {
		const ctx = await getOrCreatePreviewContext();
		const page = await ctx.newPage();
		try {
			const response = await page.goto(`http://localhost:${port}/ui/test.html`);
			expect(response?.status()).toBe(200);
			expect(await page.title()).toBe("Preview Integration");
			const shot = await page.screenshot({ type: "png" });
			expect(shot.length).toBeGreaterThan(100);
		} finally {
			await page.close();
		}
	});

	test("two preview calls share the same BrowserContext", async () => {
		const a = await getOrCreatePreviewContext();
		const b = await getOrCreatePreviewContext();
		expect(a).toBe(b);
	});
});
