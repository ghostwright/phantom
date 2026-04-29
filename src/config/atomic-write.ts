// Atomic YAML/JSON writer.
//
// Used by the phantom-config UI endpoint (PR 6) to replace phantom.yaml,
// channels.yaml, and phantom-config/meta/evolution.json without ever leaving
// a torn file on disk. A mid-write crash (container kill, oom, power loss)
// must not brick the agent at next boot, so every write goes temp-file then
// rename; renameSync is atomic on POSIX.
//
// The helper deliberately does NOT read, parse, merge, or validate. Callers
// are responsible for computing the final serialized content. This keeps the
// module tiny and auditable, and lets higher-level modules (phantom-config
// handler) own their own schema + merge semantics.

import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type AtomicWriteResult = { ok: true } | { ok: false; error: string };

/**
 * Writes `content` to `path` via a same-dir temp file and an atomic rename.
 * On POSIX, renameSync across the same filesystem is atomic: either the
 * rename committed and readers see the new bytes, or it did not and readers
 * see the old bytes. No torn reads.
 *
 * Deletes the temp file on any error before the rename. If the rename itself
 * throws (e.g. EXDEV when the temp dir is on a different FS, EACCES on a
 * read-only target), the original file is unchanged.
 *
 * `renameImpl` is exposed for tests so the mid-write failure path can be
 * simulated without touching the real filesystem.
 */
export function writeAtomic(
	path: string,
	content: string,
	renameImpl: (from: string, to: string) => void = renameSync,
): AtomicWriteResult {
	const dir = dirname(path);

	if (!existsSync(dir)) {
		try {
			mkdirSync(dir, { recursive: true });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			return { ok: false, error: `Failed to create directory ${dir}: ${msg}` };
		}
	}

	const tmp = join(dir, `.phantom-config.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

	try {
		writeFileSync(tmp, content, { encoding: "utf-8", mode: 0o644 });
	} catch (err: unknown) {
		safeUnlink(tmp);
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, error: `Failed to write temp file: ${msg}` };
	}

	try {
		renameImpl(tmp, path);
	} catch (err: unknown) {
		safeUnlink(tmp);
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, error: `Failed to rename into place: ${msg}` };
	}

	return { ok: true };
}

function safeUnlink(path: string): void {
	try {
		if (existsSync(path)) {
			unlinkSync(path);
		}
	} catch {
		// Swallow: best-effort cleanup. The caller already got the real
		// error from the failed write step.
	}
}
