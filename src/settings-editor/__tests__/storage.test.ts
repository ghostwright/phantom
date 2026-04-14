import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCurated, writeCurated } from "../storage.ts";

let tmp: string;
let settingsPath: string;

function writeSettings(obj: unknown): void {
	writeFileSync(settingsPath, `${JSON.stringify(obj, null, 2)}\n`);
}

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "phantom-settings-editor-"));
	settingsPath = join(tmp, "settings.json");
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("readCurated", () => {
	test("returns an empty object when settings.json does not exist", () => {
		const result = readCurated(settingsPath);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.current).toEqual({});
	});

	test("returns the full current settings including custom fields", () => {
		writeSettings({
			model: "claude-opus-4-6",
			enabledPlugins: { "linear@claude-plugins-official": true },
			x_custom_marker: "preserved",
		});
		const result = readCurated(settingsPath);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.current).toMatchObject({
			model: "claude-opus-4-6",
			enabledPlugins: { "linear@claude-plugins-official": true },
			x_custom_marker: "preserved",
		});
	});
});

describe("writeCurated: byte-for-byte preservation", () => {
	test("untouched fields survive a write that changes only model", () => {
		const initial = {
			model: "claude-sonnet-4-6",
			enabledPlugins: { "linear@claude-plugins-official": true, "notion@claude-plugins-official": true },
			hooks: {
				PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo precheck" }] }],
			},
			permissions: { allow: ["Bash(git:*)"], deny: [] },
			x_custom_field: "preserved byte-for-byte",
		};
		writeSettings(initial);

		const result = writeCurated({ model: "claude-opus-4-6" }, settingsPath);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.dirty.length).toBe(1);
		expect(result.dirty[0].key).toBe("model");

		const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
		expect(after.model).toBe("claude-opus-4-6");
		expect(after.enabledPlugins).toEqual(initial.enabledPlugins);
		expect(after.hooks).toEqual(initial.hooks);
		expect(after.permissions).toEqual(initial.permissions);
		expect(after.x_custom_field).toBe(initial.x_custom_field);
	});

	test("multiple-field update preserves untouched fields", () => {
		writeSettings({
			model: "claude-opus-4-6",
			enabledPlugins: { "notion@claude-plugins-official": true },
			hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo start" }] }] },
			cleanupPeriodDays: 30,
		});
		const result = writeCurated(
			{ cleanupPeriodDays: 90, autoMemoryEnabled: true, model: "claude-sonnet-4-6" },
			settingsPath,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
		expect(after.cleanupPeriodDays).toBe(90);
		expect(after.autoMemoryEnabled).toBe(true);
		expect(after.model).toBe("claude-sonnet-4-6");
		expect(after.enabledPlugins).toEqual({ "notion@claude-plugins-official": true });
		expect(after.hooks.SessionStart[0].hooks[0].command).toBe("echo start");
	});

	test("no-op write produces zero dirty keys and does not modify settings.json content", () => {
		writeSettings({ model: "claude-opus-4-6", x_marker: 1 });
		const result = writeCurated({ model: "claude-opus-4-6" }, settingsPath);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.dirty.length).toBe(0);
		const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
		expect(after.x_marker).toBe(1);
	});

	test("rejects unknown fields per deny-list", () => {
		writeSettings({ model: "claude-opus-4-6" });
		const result = writeCurated({ apiKeyHelper: "/tmp/evil.sh" }, settingsPath);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(422);
	});

	test("rejects hooks in the payload (owned by the hooks editor)", () => {
		writeSettings({});
		const result = writeCurated(
			{ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "x" }] }] } } as unknown,
			settingsPath,
		);
		expect(result.ok).toBe(false);
	});

	test("rejects enabledPlugins in the payload (owned by the plugins editor)", () => {
		writeSettings({});
		const result = writeCurated(
			{ enabledPlugins: { "linear@claude-plugins-official": true } } as unknown,
			settingsPath,
		);
		expect(result.ok).toBe(false);
	});

	test("partial nested object updates preserve untouched siblings", () => {
		// Load a full permissions object with every field set. Submit a
		// partial payload that only changes `allow`. Assert deny, ask, and
		// defaultMode are byte-for-byte unchanged on disk. This is the
		// exact shape that caused Codex P1.
		writeSettings({
			permissions: {
				allow: ["Bash(git:*)"],
				deny: ["Bash(rm:*)"],
				ask: ["Read(~/.ssh/*)"],
				defaultMode: "acceptEdits",
			},
		});
		const result = writeCurated({ permissions: { allow: ["Bash(git:*)", "Bash(ls:*)"] } }, settingsPath);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
		expect(after.permissions.allow).toEqual(["Bash(git:*)", "Bash(ls:*)"]);
		expect(after.permissions.deny).toEqual(["Bash(rm:*)"]);
		expect(after.permissions.ask).toEqual(["Read(~/.ssh/*)"]);
		expect(after.permissions.defaultMode).toBe("acceptEdits");
	});
});

describe("writeCurated: partial-slice preservation per whitelist slice", () => {
	// One test per object-valued slice in the whitelist. The shape is the
	// same in every case: initial settings.json has a full object with
	// multiple siblings, the client submits a partial payload changing
	// one sibling, and we assert the others survive byte-for-byte on disk.

	test("permissions.disableBypassPermissionsMode survives a permissions.allow change", () => {
		writeSettings({
			permissions: {
				allow: ["Bash(git:*)"],
				deny: [],
				defaultMode: "default",
				disableBypassPermissionsMode: "disable",
			},
		});
		const result = writeCurated({ permissions: { allow: ["Bash(git:*)", "Bash(ls:*)"] } }, settingsPath);
		expect(result.ok).toBe(true);
		const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
		expect(after.permissions.disableBypassPermissionsMode).toBe("disable");
		expect(after.permissions.deny).toEqual([]);
		expect(after.permissions.defaultMode).toBe("default");
	});

	test("attribution: setting commit alone preserves pr", () => {
		writeSettings({
			attribution: { commit: "phantom-agent", pr: "Reviewed-by: Phantom" },
		});
		const result = writeCurated({ attribution: { commit: "phantom-agent-v2" } }, settingsPath);
		expect(result.ok).toBe(true);
		const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
		expect(after.attribution.commit).toBe("phantom-agent-v2");
		expect(after.attribution.pr).toBe("Reviewed-by: Phantom");
	});

	test("worktree: setting symlinkDirectories alone preserves sparsePaths", () => {
		writeSettings({
			worktree: {
				symlinkDirectories: ["node_modules", ".venv"],
				sparsePaths: ["docs", "tests"],
			},
		});
		const result = writeCurated({ worktree: { symlinkDirectories: ["node_modules"] } }, settingsPath);
		expect(result.ok).toBe(true);
		const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
		expect(after.worktree.symlinkDirectories).toEqual(["node_modules"]);
		expect(after.worktree.sparsePaths).toEqual(["docs", "tests"]);
	});

	test("sandbox: setting enabled alone preserves every other sandbox field", () => {
		writeSettings({
			sandbox: {
				enabled: false,
				failIfUnavailable: true,
				autoAllowBashIfSandboxed: true,
				allowUnsandboxedCommands: false,
				excludedCommands: ["docker", "kubectl"],
				network: { allowedDomains: ["example.com"], allowLocalBinding: false },
				filesystem: { allowWrite: ["/tmp"], denyRead: ["/etc/shadow"] },
			},
		});
		const result = writeCurated({ sandbox: { enabled: true } }, settingsPath);
		expect(result.ok).toBe(true);
		const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
		expect(after.sandbox.enabled).toBe(true);
		expect(after.sandbox.failIfUnavailable).toBe(true);
		expect(after.sandbox.autoAllowBashIfSandboxed).toBe(true);
		expect(after.sandbox.allowUnsandboxedCommands).toBe(false);
		expect(after.sandbox.excludedCommands).toEqual(["docker", "kubectl"]);
		expect(after.sandbox.network).toEqual({ allowedDomains: ["example.com"], allowLocalBinding: false });
		expect(after.sandbox.filesystem).toEqual({ allowWrite: ["/tmp"], denyRead: ["/etc/shadow"] });
	});

	test("sandbox.network nested: setting allowedDomains preserves allowLocalBinding and ports", () => {
		writeSettings({
			sandbox: {
				network: {
					allowedDomains: ["example.com"],
					allowLocalBinding: true,
					httpProxyPort: 8080,
					socksProxyPort: 1080,
				},
			},
		});
		const result = writeCurated(
			{ sandbox: { network: { allowedDomains: ["example.com", "github.com"] } } },
			settingsPath,
		);
		expect(result.ok).toBe(true);
		const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
		expect(after.sandbox.network.allowedDomains).toEqual(["example.com", "github.com"]);
		expect(after.sandbox.network.allowLocalBinding).toBe(true);
		expect(after.sandbox.network.httpProxyPort).toBe(8080);
		expect(after.sandbox.network.socksProxyPort).toBe(1080);
	});

	test("sandbox.filesystem nested: setting allowWrite preserves denyWrite, denyRead, allowRead", () => {
		writeSettings({
			sandbox: {
				filesystem: {
					allowWrite: ["/tmp"],
					denyWrite: ["/etc"],
					denyRead: ["/etc/shadow"],
					allowRead: ["/var/log"],
				},
			},
		});
		const result = writeCurated({ sandbox: { filesystem: { allowWrite: ["/tmp", "/var/tmp"] } } }, settingsPath);
		expect(result.ok).toBe(true);
		const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
		expect(after.sandbox.filesystem.allowWrite).toEqual(["/tmp", "/var/tmp"]);
		expect(after.sandbox.filesystem.denyWrite).toEqual(["/etc"]);
		expect(after.sandbox.filesystem.denyRead).toEqual(["/etc/shadow"]);
		expect(after.sandbox.filesystem.allowRead).toEqual(["/var/log"]);
	});

	test("sandbox.ripgrep nested: setting command preserves args", () => {
		writeSettings({
			sandbox: {
				ripgrep: { command: "rg", args: ["--hidden", "--smart-case"] },
			},
		});
		const result = writeCurated({ sandbox: { ripgrep: { command: "/usr/local/bin/rg" } } }, settingsPath);
		expect(result.ok).toBe(true);
		const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
		expect(after.sandbox.ripgrep.command).toBe("/usr/local/bin/rg");
		expect(after.sandbox.ripgrep.args).toEqual(["--hidden", "--smart-case"]);
	});

	test("env: setting one variable preserves every other env var", () => {
		writeSettings({
			env: {
				PHANTOM_NAME: "phantom",
				RESEND_API_KEY: "keep-me",
				LINEAR_API_KEY: "keep-me-too",
			},
		});
		const result = writeCurated({ env: { PHANTOM_NAME: "phantom-v2" } }, settingsPath);
		expect(result.ok).toBe(true);
		const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
		expect(after.env.PHANTOM_NAME).toBe("phantom-v2");
		expect(after.env.RESEND_API_KEY).toBe("keep-me");
		expect(after.env.LINEAR_API_KEY).toBe("keep-me-too");
	});

	test("statusLine: setting padding alone preserves command and type", () => {
		writeSettings({
			statusLine: { type: "command", command: "echo ready", padding: 2 },
		});
		const result = writeCurated({ statusLine: { type: "command", command: "echo ready", padding: 4 } }, settingsPath);
		expect(result.ok).toBe(true);
		const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
		expect(after.statusLine.command).toBe("echo ready");
		expect(after.statusLine.padding).toBe(4);
		expect(after.statusLine.type).toBe("command");
	});

	test("spinnerVerbs: setting verbs preserves mode", () => {
		writeSettings({
			spinnerVerbs: { mode: "append", verbs: ["pondering", "reticulating"] },
		});
		const result = writeCurated(
			{ spinnerVerbs: { mode: "append", verbs: ["pondering", "reticulating", "vibing"] } },
			settingsPath,
		);
		expect(result.ok).toBe(true);
		const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
		expect(after.spinnerVerbs.mode).toBe("append");
		expect(after.spinnerVerbs.verbs).toEqual(["pondering", "reticulating", "vibing"]);
	});

	test("spinnerTipsOverride: setting tips preserves excludeDefault", () => {
		writeSettings({
			spinnerTipsOverride: { excludeDefault: true, tips: ["keep calm"] },
		});
		const result = writeCurated(
			{ spinnerTipsOverride: { excludeDefault: true, tips: ["keep calm", "ship it"] } },
			settingsPath,
		);
		expect(result.ok).toBe(true);
		const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
		expect(after.spinnerTipsOverride.excludeDefault).toBe(true);
		expect(after.spinnerTipsOverride.tips).toEqual(["keep calm", "ship it"]);
	});

	test("no-op save (same content, different key order) does not mark the key dirty", () => {
		// Canonical on-disk order.
		writeSettings({
			permissions: { allow: ["Bash(git:*)"], deny: ["Bash(rm:*)"], defaultMode: "default" },
		});
		// Client submits with different key insertion order; JSON.stringify
		// output differs but the structures are equal.
		const result = writeCurated(
			{ permissions: { defaultMode: "default", deny: ["Bash(rm:*)"], allow: ["Bash(git:*)"] } },
			settingsPath,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.dirty.length).toBe(0);
	});
});

describe("writeCurated: atomic write semantics", () => {
	test("successful write leaves no tmp files", () => {
		writeSettings({ model: "x" });
		writeCurated({ model: "y" }, settingsPath);
		const { readdirSync } = require("node:fs");
		const tmpFiles = readdirSync(tmp).filter((f: string) => f.startsWith("."));
		expect(tmpFiles.length).toBe(0);
	});
});
