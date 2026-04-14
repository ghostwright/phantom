// Atomic read / modify / write of /home/phantom/.claude/settings.json.
//
// PR2 only touches the `enabledPlugins` field. Every other field is
// preserved byte-for-byte on a round trip (minus key reordering via JSON
// serialization). Writes go through tmp-then-rename so a crash never leaves
// a torn file. No file locking; last-write-wins per the Cardinal Rule.
//
// Why we do NOT use YAML or a TOML intermediate: settings.json is JSON by
// spec and the CLI parses it as JSON. Anything else is a compatibility hazard.
//
// Why we do NOT guard against `enabledPlugins` being set to unexpected shapes:
// the CLI is permissive here (it accepts booleans, string arrays, and
// objects). We preserve whatever is there and only mutate the single key we
// are touching.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type EnabledPluginValue, type EnabledPluginsMap, isEnabledValueActive } from "./manifest.ts";
import { getUserSettingsPath } from "./paths.ts";

export type SettingsJson = Record<string, unknown> & {
	enabledPlugins?: EnabledPluginsMap;
};

export type ReadSettingsResult =
	| { ok: true; settings: SettingsJson; existed: boolean; raw: string | null }
	| { ok: false; error: string };

export function readSettings(path: string = getUserSettingsPath()): ReadSettingsResult {
	if (!existsSync(path)) {
		return { ok: true, settings: {}, existed: false, raw: null };
	}
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, error: `Failed to read settings: ${msg}` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, error: `Settings is not valid JSON: ${msg}` };
	}
	if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { ok: false, error: "Settings must be a JSON object" };
	}
	return { ok: true, settings: parsed as SettingsJson, existed: true, raw };
}

function ensureDir(dir: string): void {
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

function writeAtomic(path: string, content: string): void {
	const dir = dirname(path);
	ensureDir(dir);
	const tmp = join(dir, `.settings.json.tmp-${process.pid}-${Date.now()}`);
	writeFileSync(tmp, content, { encoding: "utf-8", mode: 0o644 });
	renameSync(tmp, path);
}

export type WriteSettingsResult = { ok: true; settings: SettingsJson } | { ok: false; error: string };

export function writeSettings(settings: SettingsJson, path: string = getUserSettingsPath()): WriteSettingsResult {
	// Two-space indent matches the Claude Code CLI's own formatter so diffs
	// on disk are minimal when the agent and the dashboard write the same file.
	const serialized = `${JSON.stringify(settings, null, 2)}\n`;
	try {
		writeAtomic(path, serialized);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, error: `Failed to write settings: ${msg}` };
	}
	return { ok: true, settings };
}

export type InstallPluginResult =
	| {
			ok: true;
			key: string;
			previous_value: EnabledPluginValue | null;
			new_value: EnabledPluginValue;
			already_installed: boolean;
	  }
	| { ok: false; status: 400 | 500; error: string };

// Merge an `enabledPlugins` entry into settings.json. If the key is already
// present AND active, returns `already_installed: true` without rewriting.
// Otherwise, sets the key to `true` and writes back atomically.
export function installPlugin(key: string, path?: string): InstallPluginResult {
	const read = readSettings(path);
	if (!read.ok) {
		return { ok: false, status: 500, error: read.error };
	}
	const settings = read.settings;
	const existing = (settings.enabledPlugins ?? {}) as EnabledPluginsMap;
	const previous: EnabledPluginValue | null = existing[key] ?? null;
	if (previous !== null && isEnabledValueActive(previous)) {
		return { ok: true, key, previous_value: previous, new_value: previous, already_installed: true };
	}
	const next: EnabledPluginsMap = { ...existing, [key]: true };
	const merged: SettingsJson = { ...settings, enabledPlugins: next };
	const write = writeSettings(merged, path);
	if (!write.ok) {
		return { ok: false, status: 500, error: write.error };
	}
	return { ok: true, key, previous_value: previous, new_value: true, already_installed: false };
}

export type UninstallPluginResult =
	| {
			ok: true;
			key: string;
			previous_value: EnabledPluginValue | null;
			new_value: EnabledPluginValue;
			was_active: boolean;
	  }
	| { ok: false; status: 400 | 500; error: string };

// Soft-uninstall: sets the enabledPlugins entry to `false`. Matches the CLI's
// own uninstall behavior (cli.js:5641 region where TL6() sets false instead
// of deleting). Preserves the key so re-enable is a one-click flip.
export function uninstallPlugin(key: string, path?: string): UninstallPluginResult {
	const read = readSettings(path);
	if (!read.ok) {
		return { ok: false, status: 500, error: read.error };
	}
	const settings = read.settings;
	const existing = (settings.enabledPlugins ?? {}) as EnabledPluginsMap;
	const previous: EnabledPluginValue | null = existing[key] ?? null;
	const wasActive = isEnabledValueActive(previous ?? undefined);
	if (previous === false) {
		return { ok: true, key, previous_value: false, new_value: false, was_active: false };
	}
	const next: EnabledPluginsMap = { ...existing, [key]: false };
	const merged: SettingsJson = { ...settings, enabledPlugins: next };
	const write = writeSettings(merged, path);
	if (!write.ok) {
		return { ok: false, status: 500, error: write.error };
	}
	return { ok: true, key, previous_value: previous, new_value: false, was_active: wasActive };
}

// Read-only snapshot: returns the currently-active enabledPlugins keys, with
// their stored value. Used by the dashboard `GET /ui/api/plugins` handler.
export function listEnabledPlugins(path?: string): {
	active: Record<string, EnabledPluginValue>;
	disabled: string[];
} {
	const read = readSettings(path);
	if (!read.ok) {
		return { active: {}, disabled: [] };
	}
	const enabled = (read.settings.enabledPlugins ?? {}) as EnabledPluginsMap;
	const active: Record<string, EnabledPluginValue> = {};
	const disabled: string[] = [];
	for (const [key, value] of Object.entries(enabled)) {
		if (isEnabledValueActive(value)) {
			active[key] = value;
		} else {
			disabled.push(key);
		}
	}
	return { active, disabled };
}
