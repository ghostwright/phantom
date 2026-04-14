// Diff-based read-modify-write for the curated settings form.
//
// The form submits a partial settings object (only the fields the user
// touched). We load the current settings.json, compute the set of top-level
// keys that actually changed, and write back ONLY those keys. Every other
// field stays byte-for-byte identical.
//
// For object-valued whitelist slices (permissions, sandbox, worktree, env,
// attribution, statusLine, spinnerVerbs, spinnerTipsOverride, plus nested
// sandbox.network, sandbox.filesystem, sandbox.ripgrep), the merge is
// recursive: sibling nested keys the caller did not include survive the
// write untouched. A partial submission of { permissions: { allow: [X] } }
// preserves permissions.deny, permissions.ask, permissions.defaultMode on
// disk. See __tests__/storage.test.ts for the partial-slice preservation
// suite per slice.
//
// The safety floor: untouched fields must survive a round trip through the
// form unchanged.

import { getUserSettingsPath } from "../plugins/paths.ts";
import { readSettings, writeSettings } from "../plugins/settings-io.ts";
import { type CuratedSettings, CuratedSettingsSchema } from "./schema.ts";

export type ReadCuratedResult = { ok: true; current: Record<string, unknown> } | { ok: false; error: string };

// Reads the full settings.json and returns it as-is. The dashboard form
// only renders the whitelisted keys, but we hand over the full payload so
// the dashboard can show the operator what else is on disk without the form.
export function readCurated(settingsPath: string = getUserSettingsPath()): ReadCuratedResult {
	const read = readSettings(settingsPath);
	if (!read.ok) return { ok: false, error: read.error };
	return { ok: true, current: read.settings as Record<string, unknown> };
}

export type DirtyKey = {
	key: keyof CuratedSettings;
	previous: unknown;
	next: unknown;
};

export type WriteCuratedResult =
	| { ok: true; dirty: DirtyKey[]; current: Record<string, unknown>; previous: Record<string, unknown> }
	| { ok: false; status: 400 | 422 | 500; error: string };

// True for plain objects (object literals and Object.create(null)). False
// for arrays, Dates, Maps, class instances, and null. Used by the deep
// merge and deep equal helpers so arrays and primitives are treated as
// atomic values.
function isPlainObject(v: unknown): v is Record<string, unknown> {
	if (v === null || typeof v !== "object") return false;
	if (Array.isArray(v)) return false;
	const proto = Object.getPrototypeOf(v);
	return proto === Object.prototype || proto === null;
}

// Structural deep equality for dirty detection. JSON.stringify is not
// sufficient because its output depends on key insertion order, which
// would cause two structurally identical objects with different key order
// to compare as dirty and trigger a no-op write.
function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === null || b === null) return false;
	if (typeof a !== typeof b) return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b)) return false;
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			if (!deepEqual(a[i], b[i])) return false;
		}
		return true;
	}
	if (isPlainObject(a) && isPlainObject(b)) {
		const aKeys = Object.keys(a);
		const bKeys = Object.keys(b);
		if (aKeys.length !== bKeys.length) return false;
		for (const k of aKeys) {
			if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
			if (!deepEqual(a[k], (b as Record<string, unknown>)[k])) return false;
		}
		return true;
	}
	return false;
}

// Recursive deep merge for object-valued whitelist slices. Next overrides
// previous at leaves; siblings in previous that are absent from next are
// preserved. Arrays are atomic (the new array replaces the old one, same
// as primitives). Applied only when BOTH sides are plain objects.
function deepMergeSlice(prev: unknown, next: unknown): unknown {
	if (isPlainObject(prev) && isPlainObject(next)) {
		const result: Record<string, unknown> = { ...prev };
		for (const [k, v] of Object.entries(next)) {
			result[k] = deepMergeSlice(prev[k], v);
		}
		return result;
	}
	return next;
}

// Compute a shallow diff between a partial form submission and the on-disk
// settings. A key is dirty if the merged result (after deep-merging
// sibling keys of object-valued slices) differs structurally from the
// current value. This avoids false-positive dirty flags from key-order
// drift and avoids writing no-op rows to the audit log.
function computeDirtyKeys(next: CuratedSettings, current: Record<string, unknown>): DirtyKey[] {
	const dirty: DirtyKey[] = [];
	for (const key of Object.keys(next) as Array<keyof CuratedSettings>) {
		const nextVal = next[key];
		const currentVal = current[key];
		if (nextVal === undefined) continue;
		const merged = deepMergeSlice(currentVal, nextVal);
		if (!deepEqual(merged, currentVal)) {
			dirty.push({ key, previous: currentVal, next: nextVal });
		}
	}
	return dirty;
}

export function writeCurated(submitted: unknown, settingsPath: string = getUserSettingsPath()): WriteCuratedResult {
	const parsed = CuratedSettingsSchema.safeParse(submitted);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const path = issue.path.length > 0 ? issue.path.join(".") : "body";
		return { ok: false, status: 422, error: `${path}: ${issue.message}` };
	}

	const read = readSettings(settingsPath);
	if (!read.ok) return { ok: false, status: 500, error: read.error };
	const previousFull = { ...read.settings } as Record<string, unknown>;

	const dirty = computeDirtyKeys(parsed.data, previousFull);
	if (dirty.length === 0) {
		return { ok: true, dirty: [], current: previousFull, previous: previousFull };
	}

	// Build the merged settings: deep-merge each object-valued dirty slice
	// with its previous on-disk shape so siblings the caller did not
	// include survive the write byte-for-byte. Primitives and arrays
	// replace wholesale.
	const merged: Record<string, unknown> = { ...previousFull };
	for (const entry of dirty) {
		merged[entry.key] = deepMergeSlice(previousFull[entry.key], entry.next);
	}

	const write = writeSettings(merged, settingsPath);
	if (!write.ok) return { ok: false, status: 500, error: write.error };

	return { ok: true, dirty, current: merged, previous: previousFull };
}
