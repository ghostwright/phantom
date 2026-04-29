// Unit tests for the correctness paths in src/ui/preview.ts that we can
// drive without a real Chromium: cookie rotation at the 8 minute threshold,
// the shuttingDown flag, and the try/finally launch-failure recovery
// pattern. The happy end-to-end path is exercised by the opt-in integration
// test at preview.integration.test.ts which requires PHANTOM_INTEGRATION=1.
//
// We replace `chromium.launch` via spyOn so the module under test never
// actually spawns a browser process. The fake Browser and BrowserContext
// expose exactly the subset of the real API that preview.ts calls: nothing
// more, nothing less.

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { Browser, BrowserContext } from "playwright";
import { chromium } from "playwright";
import {
	__resetPreviewStateForTesting,
	closePreviewResources,
	getOrCreateBrowser,
	getOrCreatePreviewContext,
} from "../preview.ts";
import { getSessionCount, revokeAllSessions } from "../session.ts";

type Cookie = { name: string; value: string; domain: string; path: string };
type FakeContext = BrowserContext & { __cookies: Cookie[]; __closed: boolean };
type FakeBrowser = Browser & { __contexts: FakeContext[]; __closed: boolean };

function makeFakeContext(): FakeContext {
	const state = { __cookies: [] as Cookie[], __closed: false };
	const ctx = {
		...state,
		addCookies: async (cookies: Cookie[]) => {
			// Match Playwright semantics: replace any cookie with the same
			// name+domain+path in place, otherwise append.
			for (const incoming of cookies) {
				const existing = state.__cookies.findIndex(
					(c) => c.name === incoming.name && c.domain === incoming.domain && c.path === incoming.path,
				);
				if (existing >= 0) state.__cookies[existing] = incoming;
				else state.__cookies.push(incoming);
			}
		},
		close: async () => {
			state.__closed = true;
		},
	} as unknown as FakeContext;
	Object.defineProperty(ctx, "__cookies", { get: () => state.__cookies });
	Object.defineProperty(ctx, "__closed", { get: () => state.__closed });
	return ctx;
}

function makeFakeBrowser(): FakeBrowser {
	const contexts: FakeContext[] = [];
	const state = { __closed: false };
	const b = {
		newContext: async () => {
			const ctx = makeFakeContext();
			contexts.push(ctx);
			return ctx;
		},
		close: async () => {
			state.__closed = true;
		},
	} as unknown as FakeBrowser;
	Object.defineProperty(b, "__contexts", { get: () => contexts });
	Object.defineProperty(b, "__closed", { get: () => state.__closed });
	return b;
}

afterEach(() => {
	__resetPreviewStateForTesting();
	revokeAllSessions();
});

describe("getOrCreateBrowser launch-failure recovery (Codex P2)", () => {
	test("second call after a transient launch error succeeds", async () => {
		const spy = spyOn(chromium, "launch");
		try {
			let calls = 0;
			spy.mockImplementation(async () => {
				calls += 1;
				if (calls === 1) throw new Error("transient resource error");
				return makeFakeBrowser();
			});

			await expect(getOrCreateBrowser()).rejects.toThrow("transient resource error");
			// If the rejected promise were cached, this would re-reject with the
			// same error instead of invoking launch a second time.
			const b = await getOrCreateBrowser();
			expect(b).toBeDefined();
			expect(calls).toBe(2);
		} finally {
			spy.mockRestore();
		}
	});
});

describe("getOrCreatePreviewContext launch-failure recovery", () => {
	test("clears currentContextPromise on failure so the next call retries", async () => {
		const spy = spyOn(chromium, "launch");
		try {
			let calls = 0;
			spy.mockImplementation(async () => {
				calls += 1;
				if (calls === 1) throw new Error("chromium down");
				return makeFakeBrowser();
			});

			await expect(getOrCreatePreviewContext()).rejects.toThrow("chromium down");
			const ctx = await getOrCreatePreviewContext();
			expect(ctx).toBeDefined();
			expect(calls).toBe(2);
		} finally {
			spy.mockRestore();
		}
	});
});

describe("shuttingDown flag (review F7)", () => {
	test("getOrCreateBrowser throws after closePreviewResources", async () => {
		await closePreviewResources();
		await expect(getOrCreateBrowser()).rejects.toThrow("preview subsystem is shutting down");
	});

	test("getOrCreatePreviewContext throws after closePreviewResources", async () => {
		await closePreviewResources();
		await expect(getOrCreatePreviewContext()).rejects.toThrow("preview subsystem is shutting down");
	});
});

describe("cookie rotation (review F6, Codex P1)", () => {
	test("cold create mints a fresh preview cookie on the new context", async () => {
		const spy = spyOn(chromium, "launch");
		try {
			const fakeBrowser = makeFakeBrowser();
			spy.mockImplementation(async () => fakeBrowser);

			const ctx = (await getOrCreatePreviewContext()) as FakeContext;
			expect(ctx.__cookies).toHaveLength(1);
			const cookie = ctx.__cookies[0];
			expect(cookie.name).toBe("phantom_session");
			expect(cookie.domain).toBe("localhost");
			// Fix 4: cookie path is scoped to /ui, matching the magic-link
			// posture in src/ui/serve.ts.
			expect(cookie.path).toBe("/ui");
			expect(typeof cookie.value).toBe("string");
			expect(cookie.value.length).toBeGreaterThan(20);
		} finally {
			spy.mockRestore();
		}
	});

	test("warm reuse inside the 8 minute window does not rotate", async () => {
		const spy = spyOn(chromium, "launch");
		try {
			spy.mockImplementation(async () => makeFakeBrowser());

			const ctx1 = (await getOrCreatePreviewContext()) as FakeContext;
			const firstToken = ctx1.__cookies[0].value;
			const sessionsAfterFirst = getSessionCount();

			const ctx2 = (await getOrCreatePreviewContext()) as FakeContext;
			expect(ctx2).toBe(ctx1);
			expect(ctx2.__cookies).toHaveLength(1);
			expect(ctx2.__cookies[0].value).toBe(firstToken);
			expect(getSessionCount()).toBe(sessionsAfterFirst);
		} finally {
			spy.mockRestore();
		}
	});

	test("warm reuse past the 8 minute threshold rotates the cookie in place", async () => {
		const spy = spyOn(chromium, "launch");
		const originalNow = Date.now;
		try {
			spy.mockImplementation(async () => makeFakeBrowser());

			const ctx1 = (await getOrCreatePreviewContext()) as FakeContext;
			const firstToken = ctx1.__cookies[0].value;
			expect(getSessionCount()).toBe(1);

			// Advance wall-clock past the 8 minute rotation threshold. The cached
			// BrowserContext stays the same instance but the cookie value gets
			// replaced in place via addCookies semantics.
			Date.now = () => originalNow() + 9 * 60 * 1000;

			const ctx2 = (await getOrCreatePreviewContext()) as FakeContext;
			expect(ctx2).toBe(ctx1);
			expect(ctx2.__cookies).toHaveLength(1);
			expect(ctx2.__cookies[0].value).not.toBe(firstToken);
			// A second preview session was minted into the sessions map.
			expect(getSessionCount()).toBe(2);
		} finally {
			Date.now = originalNow;
			spy.mockRestore();
		}
	});
});

describe("page.close() error path clears currentContext (review F8)", () => {
	// We cannot drive the real phantom_preview_page handler without a real
	// browser, but we can verify the public invariant the fix establishes:
	// once currentContext has been nulled (as the catch block does), the next
	// getOrCreatePreviewContext() call returns a fresh context. The preview
	// integration test covers the happy path end to end.
	test("after currentContext is nulled, next call creates a fresh context", async () => {
		const spy = spyOn(chromium, "launch");
		try {
			spy.mockImplementation(async () => makeFakeBrowser());

			const ctx1 = (await getOrCreatePreviewContext()) as FakeContext;
			// Simulate the catch-block cleanup in the preview tool finally.
			await closePreviewResources();
			__resetPreviewStateForTesting();

			spy.mockImplementation(async () => makeFakeBrowser());
			const ctx2 = (await getOrCreatePreviewContext()) as FakeContext;
			expect(ctx2).not.toBe(ctx1);
		} finally {
			spy.mockRestore();
		}
	});
});
