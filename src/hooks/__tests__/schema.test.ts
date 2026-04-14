import { describe, expect, test } from "bun:test";
import {
	EVENTS_SUPPORTING_MATCHER,
	HOOK_EVENTS,
	HookDefinitionSchema,
	HookEventSchema,
	HookMatcherGroupSchema,
	HooksSliceSchema,
	isHttpUrlAllowed,
} from "../schema.ts";

describe("HOOK_EVENTS", () => {
	test("contains exactly 26 events per sdk.d.ts:551", () => {
		expect(HOOK_EVENTS.length).toBe(26);
	});

	test("includes the pre/post tool use events", () => {
		expect(HOOK_EVENTS).toContain("PreToolUse");
		expect(HOOK_EVENTS).toContain("PostToolUse");
		expect(HOOK_EVENTS).toContain("PostToolUseFailure");
	});

	test("includes subagent and session events", () => {
		expect(HOOK_EVENTS).toContain("SubagentStart");
		expect(HOOK_EVENTS).toContain("SubagentStop");
		expect(HOOK_EVENTS).toContain("SessionStart");
		expect(HOOK_EVENTS).toContain("SessionEnd");
	});
});

describe("EVENTS_SUPPORTING_MATCHER", () => {
	test("includes tool-use events", () => {
		expect(EVENTS_SUPPORTING_MATCHER.has("PreToolUse")).toBe(true);
		expect(EVENTS_SUPPORTING_MATCHER.has("PostToolUse")).toBe(true);
	});

	test("does not include session or notification events", () => {
		expect(EVENTS_SUPPORTING_MATCHER.has("SessionStart")).toBe(false);
		expect(EVENTS_SUPPORTING_MATCHER.has("Notification")).toBe(false);
	});
});

describe("HookDefinitionSchema: command", () => {
	test("accepts a minimal command hook", () => {
		const r = HookDefinitionSchema.safeParse({ type: "command", command: "echo hi" });
		expect(r.success).toBe(true);
	});

	test("accepts a command hook with all optional fields", () => {
		const r = HookDefinitionSchema.safeParse({
			type: "command",
			command: "bash -c 'echo hi'",
			shell: "bash",
			timeout: 60,
			statusMessage: "Running precheck",
			once: true,
			async: false,
			asyncRewake: false,
		});
		expect(r.success).toBe(true);
	});

	test("rejects empty command", () => {
		const r = HookDefinitionSchema.safeParse({ type: "command", command: "" });
		expect(r.success).toBe(false);
	});

	test("rejects unknown fields via strict", () => {
		const r = HookDefinitionSchema.safeParse({ type: "command", command: "x", unknown_field: 1 });
		expect(r.success).toBe(false);
	});

	test("rejects timeout over 3600", () => {
		const r = HookDefinitionSchema.safeParse({ type: "command", command: "x", timeout: 7200 });
		expect(r.success).toBe(false);
	});
});

describe("HookDefinitionSchema: prompt", () => {
	test("accepts a valid prompt hook", () => {
		const r = HookDefinitionSchema.safeParse({ type: "prompt", prompt: "Evaluate this." });
		expect(r.success).toBe(true);
	});

	test("rejects empty prompt", () => {
		const r = HookDefinitionSchema.safeParse({ type: "prompt", prompt: "" });
		expect(r.success).toBe(false);
	});
});

describe("HookDefinitionSchema: agent", () => {
	test("accepts a valid agent hook", () => {
		const r = HookDefinitionSchema.safeParse({ type: "agent", prompt: "Verify tests passed." });
		expect(r.success).toBe(true);
	});
});

describe("HookDefinitionSchema: http", () => {
	test("accepts a valid http hook", () => {
		const r = HookDefinitionSchema.safeParse({
			type: "http",
			url: "https://hooks.example.com/event",
			headers: { "X-Source": "phantom" },
		});
		expect(r.success).toBe(true);
	});

	test("rejects non-URL", () => {
		const r = HookDefinitionSchema.safeParse({ type: "http", url: "not-a-url" });
		expect(r.success).toBe(false);
	});

	test("rejects env var names with lowercase", () => {
		const r = HookDefinitionSchema.safeParse({
			type: "http",
			url: "https://x.example.com/",
			allowedEnvVars: ["my_token"],
		});
		expect(r.success).toBe(false);
	});

	test("accepts allcaps env var names", () => {
		const r = HookDefinitionSchema.safeParse({
			type: "http",
			url: "https://x.example.com/",
			allowedEnvVars: ["MY_TOKEN"],
		});
		expect(r.success).toBe(true);
	});
});

describe("HookMatcherGroupSchema", () => {
	test("accepts a group with one command hook", () => {
		const r = HookMatcherGroupSchema.safeParse({
			matcher: "Bash",
			hooks: [{ type: "command", command: "echo" }],
		});
		expect(r.success).toBe(true);
	});

	test("rejects a group with empty hooks array", () => {
		const r = HookMatcherGroupSchema.safeParse({ matcher: "Bash", hooks: [] });
		expect(r.success).toBe(false);
	});

	test("accepts a group with no matcher (undefined)", () => {
		const r = HookMatcherGroupSchema.safeParse({ hooks: [{ type: "command", command: "echo" }] });
		expect(r.success).toBe(true);
	});
});

describe("HooksSliceSchema", () => {
	test("accepts a full slice with two events", () => {
		const r = HooksSliceSchema.safeParse({
			PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo" }] }],
			PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "format.sh" }] }],
		});
		expect(r.success).toBe(true);
	});

	test("rejects unknown event names", () => {
		const r = HooksSliceSchema.safeParse({
			NotARealEvent: [{ hooks: [{ type: "command", command: "echo" }] }],
		});
		expect(r.success).toBe(false);
	});
});

describe("HookEventSchema", () => {
	test("accepts every known event", () => {
		for (const ev of HOOK_EVENTS) {
			expect(HookEventSchema.safeParse(ev).success).toBe(true);
		}
	});
});

describe("isHttpUrlAllowed", () => {
	test("allows any URL when allowlist is undefined", () => {
		expect(isHttpUrlAllowed("https://any.example.com/x", undefined)).toBe(true);
	});

	test("blocks all URLs when allowlist is empty array", () => {
		expect(isHttpUrlAllowed("https://any.example.com/x", [])).toBe(false);
	});

	test("allows exact match", () => {
		expect(isHttpUrlAllowed("https://hooks.example.com/x", ["https://hooks.example.com/x"])).toBe(true);
	});

	test("allows wildcard match", () => {
		expect(isHttpUrlAllowed("https://hooks.example.com/event", ["https://hooks.example.com/*"])).toBe(true);
	});

	test("blocks non-match", () => {
		expect(isHttpUrlAllowed("https://evil.example.com/x", ["https://hooks.example.com/*"])).toBe(false);
	});

	test("escapes regex metachars in the pattern", () => {
		expect(isHttpUrlAllowed("https://a.com/x", ["https://a.com/x"])).toBe(true);
		expect(isHttpUrlAllowed("https://aXcom/x", ["https://a.com/x"])).toBe(false);
	});
});
