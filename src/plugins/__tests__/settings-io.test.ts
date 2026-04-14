import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPlugin, listEnabledPlugins, readSettings, uninstallPlugin, writeSettings } from "../settings-io.ts";

let tmp: string;
let path: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "phantom-settings-"));
	path = join(tmp, "settings.json");
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("readSettings", () => {
	test("returns empty object and existed=false when file missing", () => {
		const result = readSettings(path);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.settings).toEqual({});
			expect(result.existed).toBe(false);
			expect(result.raw).toBeNull();
		}
	});

	test("parses a valid file", () => {
		writeFileSync(path, '{"permissions": {"allow": ["Read"]}}');
		const result = readSettings(path);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.existed).toBe(true);
			expect(result.settings.permissions).toEqual({ allow: ["Read"] });
		}
	});

	test("fails on invalid JSON", () => {
		writeFileSync(path, "{ not json");
		const result = readSettings(path);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/not valid JSON/);
	});

	test("fails on non-object", () => {
		writeFileSync(path, '["an","array"]');
		const result = readSettings(path);
		expect(result.ok).toBe(false);
	});
});

describe("writeSettings", () => {
	test("writes pretty-printed JSON", () => {
		const result = writeSettings({ foo: "bar", enabledPlugins: { "a@b": true } }, path);
		expect(result.ok).toBe(true);
		const raw = readFileSync(path, "utf-8");
		expect(raw).toContain('"foo": "bar"');
		expect(raw).toContain('"enabledPlugins"');
		expect(raw.endsWith("\n")).toBe(true);
	});

	test("round-trips fields untouched", () => {
		const original = {
			permissions: { allow: ["Read", "Glob"], deny: ["Bash(rm:*)"] },
			model: "claude-opus-4-6",
			enabledPlugins: { "a@b": true, "c@d": false },
		};
		writeSettings(original, path);
		const read = readSettings(path);
		expect(read.ok).toBe(true);
		if (read.ok) expect(read.settings).toEqual(original);
	});
});

describe("installPlugin", () => {
	test("creates enabledPlugins if missing", () => {
		writeFileSync(path, '{"permissions": {"allow": ["Read"]}}');
		const result = installPlugin("notion@claude-plugins-official", path);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.already_installed).toBe(false);
			expect(result.previous_value).toBeNull();
			expect(result.new_value).toBe(true);
		}
		const read = readSettings(path);
		if (read.ok) {
			expect(read.settings.enabledPlugins).toEqual({ "notion@claude-plugins-official": true });
			expect(read.settings.permissions).toEqual({ allow: ["Read"] });
		}
	});

	test("preserves other enabledPlugins entries", () => {
		writeFileSync(path, '{"enabledPlugins": {"linear@claude-plugins-official": true}}');
		const result = installPlugin("notion@claude-plugins-official", path);
		expect(result.ok).toBe(true);
		const read = readSettings(path);
		if (read.ok) {
			expect(read.settings.enabledPlugins).toEqual({
				"linear@claude-plugins-official": true,
				"notion@claude-plugins-official": true,
			});
		}
	});

	test("is idempotent when key is already true", () => {
		writeFileSync(path, '{"enabledPlugins": {"notion@claude-plugins-official": true}}');
		const result = installPlugin("notion@claude-plugins-official", path);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.already_installed).toBe(true);
			expect(result.previous_value).toBe(true);
			expect(result.new_value).toBe(true);
		}
	});

	test("re-enables a key that was set to false", () => {
		writeFileSync(path, '{"enabledPlugins": {"notion@claude-plugins-official": false}}');
		const result = installPlugin("notion@claude-plugins-official", path);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.already_installed).toBe(false);
			expect(result.previous_value).toBe(false);
			expect(result.new_value).toBe(true);
		}
		const read = readSettings(path);
		if (read.ok) {
			expect((read.settings.enabledPlugins as Record<string, unknown>)["notion@claude-plugins-official"]).toBe(true);
		}
	});

	test("creates settings.json when it does not exist", () => {
		const result = installPlugin("notion@claude-plugins-official", path);
		expect(result.ok).toBe(true);
		const read = readSettings(path);
		expect(read.ok).toBe(true);
		if (read.ok) {
			expect(read.existed).toBe(true);
			expect(read.settings.enabledPlugins).toEqual({ "notion@claude-plugins-official": true });
		}
	});
});

describe("uninstallPlugin", () => {
	test("sets an active key to false", () => {
		writeFileSync(path, '{"enabledPlugins": {"notion@claude-plugins-official": true}}');
		const result = uninstallPlugin("notion@claude-plugins-official", path);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.was_active).toBe(true);
			expect(result.previous_value).toBe(true);
			expect(result.new_value).toBe(false);
		}
	});

	test("is a no-op on a key that is already false", () => {
		writeFileSync(path, '{"enabledPlugins": {"notion@claude-plugins-official": false}}');
		const result = uninstallPlugin("notion@claude-plugins-official", path);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.was_active).toBe(false);
		}
	});

	test("adds the key as false if previously absent", () => {
		writeFileSync(path, "{}");
		const result = uninstallPlugin("notion@claude-plugins-official", path);
		expect(result.ok).toBe(true);
		const read = readSettings(path);
		if (read.ok) {
			expect((read.settings.enabledPlugins as Record<string, unknown>)["notion@claude-plugins-official"]).toBe(false);
		}
	});
});

describe("listEnabledPlugins", () => {
	test("separates active from disabled", () => {
		writeFileSync(
			path,
			JSON.stringify({
				enabledPlugins: {
					"linear@claude-plugins-official": true,
					"notion@claude-plugins-official": true,
					"slack@claude-plugins-official": false,
					"context7@claude-plugins-official": [],
				},
			}),
		);
		const result = listEnabledPlugins(path);
		expect(Object.keys(result.active).sort()).toEqual([
			"linear@claude-plugins-official",
			"notion@claude-plugins-official",
		]);
		expect(result.disabled.sort()).toEqual(["context7@claude-plugins-official", "slack@claude-plugins-official"]);
	});

	test("returns empty when settings.json is missing", () => {
		const result = listEnabledPlugins(path);
		expect(result.active).toEqual({});
		expect(result.disabled).toEqual([]);
	});
});
