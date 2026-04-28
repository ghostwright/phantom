import { describe, expect, test } from "bun:test";
import type { HookInput } from "../agent-sdk.ts";
import { createDangerousCommandBlocker, createFileTracker } from "../hooks.ts";

function makeHookInput(overrides: Record<string, unknown>): HookInput {
	return {
		hook_event_name: "PostToolUse",
		tool_name: "Edit",
		tool_input: {},
		...overrides,
	} as unknown as HookInput;
}

describe("createFileTracker", () => {
	test("tracks file paths from Edit/Write tool uses", async () => {
		const { hook, getTrackedFiles } = createFileTracker();
		const callback = hook.hooks[0];

		await callback(
			makeHookInput({
				hook_event_name: "PostToolUse",
				tool_name: "Write",
				tool_input: { file_path: "/src/index.ts" },
			}),
			undefined,
			{ signal: new AbortController().signal },
		);

		await callback(
			makeHookInput({
				hook_event_name: "PostToolUse",
				tool_name: "Edit",
				tool_input: { file_path: "/src/types.ts" },
			}),
			undefined,
			{ signal: new AbortController().signal },
		);

		const files = getTrackedFiles();
		expect(files).toContain("/src/index.ts");
		expect(files).toContain("/src/types.ts");
		expect(files.length).toBe(2);
	});

	test("ignores non-PostToolUse events", async () => {
		const { hook, getTrackedFiles } = createFileTracker();
		const callback = hook.hooks[0];

		await callback(
			makeHookInput({
				hook_event_name: "PreToolUse",
				tool_input: { file_path: "/src/index.ts" },
			}),
			undefined,
			{ signal: new AbortController().signal },
		);

		expect(getTrackedFiles().length).toBe(0);
	});

	test("deduplicates file paths", async () => {
		const { hook, getTrackedFiles } = createFileTracker();
		const callback = hook.hooks[0];

		const input = makeHookInput({
			hook_event_name: "PostToolUse",
			tool_input: { file_path: "/src/same.ts" },
		});

		await callback(input, undefined, { signal: new AbortController().signal });
		await callback(input, undefined, { signal: new AbortController().signal });

		expect(getTrackedFiles().length).toBe(1);
	});
});

describe("createDangerousCommandBlocker", () => {
	test("blocks rm -rf /", async () => {
		const hook = createDangerousCommandBlocker();
		const callback = hook.hooks[0];

		const result = await callback(
			makeHookInput({
				hook_event_name: "PreToolUse",
				tool_name: "Bash",
				tool_input: { command: "rm -rf /" },
			}),
			undefined,
			{ signal: new AbortController().signal },
		);

		expect(result).toHaveProperty("decision", "block");
	});

	test("blocks git push --force", async () => {
		const hook = createDangerousCommandBlocker();
		const callback = hook.hooks[0];

		const result = await callback(
			makeHookInput({
				hook_event_name: "PreToolUse",
				tool_name: "Bash",
				tool_input: { command: "git push --force origin main" },
			}),
			undefined,
			{ signal: new AbortController().signal },
		);

		expect(result).toHaveProperty("decision", "block");
	});

	test("blocks docker system prune", async () => {
		const hook = createDangerousCommandBlocker();
		const callback = hook.hooks[0];

		const result = await callback(
			makeHookInput({
				hook_event_name: "PreToolUse",
				tool_name: "Bash",
				tool_input: { command: "docker system prune -af" },
			}),
			undefined,
			{ signal: new AbortController().signal },
		);

		expect(result).toHaveProperty("decision", "block");
	});

	test("blocks rm -rf /home", async () => {
		const hook = createDangerousCommandBlocker();
		const callback = hook.hooks[0];

		const result = await callback(
			makeHookInput({
				hook_event_name: "PreToolUse",
				tool_name: "Bash",
				tool_input: { command: "rm -rf /home" },
			}),
			undefined,
			{ signal: new AbortController().signal },
		);

		expect(result).toHaveProperty("decision", "block");
	});

	test("blocks mkfs commands", async () => {
		const hook = createDangerousCommandBlocker();
		const callback = hook.hooks[0];

		const result = await callback(
			makeHookInput({
				hook_event_name: "PreToolUse",
				tool_name: "Bash",
				tool_input: { command: "mkfs.ext4 /dev/sda1" },
			}),
			undefined,
			{ signal: new AbortController().signal },
		);

		expect(result).toHaveProperty("decision", "block");
	});

	test("blocks dd to device", async () => {
		const hook = createDangerousCommandBlocker();
		const callback = hook.hooks[0];

		const result = await callback(
			makeHookInput({
				hook_event_name: "PreToolUse",
				tool_name: "Bash",
				tool_input: { command: "dd if=/dev/zero of=/dev/sda" },
			}),
			undefined,
			{ signal: new AbortController().signal },
		);

		expect(result).toHaveProperty("decision", "block");
	});

	test("allows safe commands", async () => {
		const hook = createDangerousCommandBlocker();
		const callback = hook.hooks[0];

		const result = await callback(
			makeHookInput({
				hook_event_name: "PreToolUse",
				tool_name: "Bash",
				tool_input: { command: "ls -la" },
			}),
			undefined,
			{ signal: new AbortController().signal },
		);

		expect(result).toEqual({ continue: true });
	});

	test("ignores non-PreToolUse events", async () => {
		const hook = createDangerousCommandBlocker();
		const callback = hook.hooks[0];

		const result = await callback(
			makeHookInput({
				hook_event_name: "PostToolUse",
				tool_name: "Bash",
				tool_input: { command: "rm -rf /" },
			}),
			undefined,
			{ signal: new AbortController().signal },
		);

		expect(result).toEqual({ continue: true });
	});
});
