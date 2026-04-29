import { describe, expect, test } from "bun:test";
import * as eventsModule from "../../ui/events.ts";
import { emitPluginInitSnapshot, extractPluginKeys } from "../init-plugin-snapshot.ts";

// Real SDK init message shape: the CLI constructs each plugin entry as
// { name, path, source } where `name` is the bare plugin name and
// `source` is the fully-qualified marketplace key. Verified against
// node_modules/@anthropic-ai/claude-agent-sdk/cli.js near the init
// system message construction (`plugins: A.plugins.map((z) => ({name,
// path, source}))`).
function makeRealInitMessage() {
	return {
		plugins: [
			{
				name: "linear",
				path: "/home/phantom/.claude/plugins/cache/claude-plugins-official/linear",
				source: "linear@claude-plugins-official",
			},
			{
				name: "notion",
				path: "/home/phantom/.claude/plugins/cache/claude-plugins-official/notion",
				source: "notion@claude-plugins-official",
			},
			{
				name: "slack",
				path: "/home/phantom/.claude/plugins/cache/claude-plugins-official/slack",
				source: "slack@claude-plugins-official",
			},
		],
	};
}

describe("extractPluginKeys", () => {
	test("returns empty array on null", () => {
		expect(extractPluginKeys(null)).toEqual([]);
	});

	test("returns empty array on undefined", () => {
		expect(extractPluginKeys(undefined)).toEqual([]);
	});

	test("returns empty array when plugins field missing", () => {
		expect(extractPluginKeys({} as unknown as Parameters<typeof extractPluginKeys>[0])).toEqual([]);
	});

	test("returns empty array when plugins is not an array", () => {
		expect(
			extractPluginKeys({ plugins: "not-an-array" } as unknown as Parameters<typeof extractPluginKeys>[0]),
		).toEqual([]);
	});

	test("extracts fully-qualified source keys from a real SDK init message", () => {
		const result = extractPluginKeys(makeRealInitMessage() as unknown as Parameters<typeof extractPluginKeys>[0]);
		expect(result).toEqual([
			"linear@claude-plugins-official",
			"notion@claude-plugins-official",
			"slack@claude-plugins-official",
		]);
	});

	test("falls back to bare name when source is missing", () => {
		const result = extractPluginKeys({
			plugins: [{ name: "linear", path: "/p/linear" }],
		} as unknown as Parameters<typeof extractPluginKeys>[0]);
		expect(result).toEqual(["linear"]);
	});

	test("falls back to bare name when source is undefined explicitly", () => {
		const result = extractPluginKeys({
			plugins: [{ name: "linear", path: "/p/linear", source: undefined }],
		} as unknown as Parameters<typeof extractPluginKeys>[0]);
		expect(result).toEqual(["linear"]);
	});

	test("falls back to bare name when source is an empty string", () => {
		const result = extractPluginKeys({
			plugins: [{ name: "linear", path: "/p/linear", source: "" }],
		} as unknown as Parameters<typeof extractPluginKeys>[0]);
		expect(result).toEqual(["linear"]);
	});

	test("skips entries missing both source and name", () => {
		const result = extractPluginKeys({
			plugins: [{ path: "/p/x" }, null, "", { name: 42 as unknown as string }, { source: "real@m" }],
		} as unknown as Parameters<typeof extractPluginKeys>[0]);
		expect(result).toEqual(["real@m"]);
	});
});

describe("emitPluginInitSnapshot", () => {
	test("publishes fully-qualified keys from a well-formed real init message", () => {
		const received: Array<{ event: string; data: unknown }> = [];
		const unsub = eventsModule.subscribe((event, data) => {
			received.push({ event, data });
		});
		try {
			emitPluginInitSnapshot(makeRealInitMessage() as unknown as Parameters<typeof emitPluginInitSnapshot>[0]);
		} finally {
			unsub();
		}
		expect(received.length).toBe(1);
		expect(received[0].event).toBe("plugin_init_snapshot");
		expect(received[0].data).toEqual({
			keys: ["linear@claude-plugins-official", "notion@claude-plugins-official", "slack@claude-plugins-official"],
		});
	});

	test("publishes empty keys when plugins missing", () => {
		const received: Array<{ event: string; data: unknown }> = [];
		const unsub = eventsModule.subscribe((event, data) => {
			received.push({ event, data });
		});
		try {
			emitPluginInitSnapshot({} as unknown as Parameters<typeof emitPluginInitSnapshot>[0]);
		} finally {
			unsub();
		}
		expect(received.length).toBe(1);
		expect(received[0].data).toEqual({ keys: [] });
	});

	test("publishes empty keys on null input", () => {
		const received: Array<{ event: string; data: unknown }> = [];
		const unsub = eventsModule.subscribe((event, data) => {
			received.push({ event, data });
		});
		try {
			emitPluginInitSnapshot(null);
		} finally {
			unsub();
		}
		expect(received.length).toBe(1);
		expect(received[0].data).toEqual({ keys: [] });
	});

	test("does not throw when a subscriber throws", () => {
		const unsub = eventsModule.subscribe(() => {
			throw new Error("subscriber-boom");
		});
		try {
			expect(() =>
				emitPluginInitSnapshot(makeRealInitMessage() as unknown as Parameters<typeof emitPluginInitSnapshot>[0]),
			).not.toThrow();
		} finally {
			unsub();
		}
	});

	test("does not leak unhandled rejections when an async subscriber rejects", async () => {
		// Future-proof: if a subscriber returns a rejected promise, the
		// publish helper swallows it so process-level unhandled
		// rejection handlers do not fire. This test documents the
		// expected contract; see src/ui/events.ts publish().
		const rejectingListener = async () => {
			throw new Error("async-subscriber-boom");
		};
		const unsub = eventsModule.subscribe(rejectingListener);
		try {
			emitPluginInitSnapshot(makeRealInitMessage() as unknown as Parameters<typeof emitPluginInitSnapshot>[0]);
			// Wait a microtask so any rejected promise has a chance to
			// propagate. If publish() lacks the catch guard, the test
			// runner would surface it as a failure.
			await new Promise((resolve) => setTimeout(resolve, 10));
		} finally {
			unsub();
		}
	});
});
