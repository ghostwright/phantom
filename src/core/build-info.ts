import { readFile } from "node:fs/promises";

/**
 * Phase 18 PR-6: build-identity surface for the in-VM phantom.
 *
 * `/etc/phantom-build-info` is embedded into every phantom-rootfs image at
 * Docker build time (see phantom-rootfs/Dockerfile section 10b). The file is
 * a small JSON blob recording the resolved phantom commit SHA, the requested
 * ref, the build wall-clock, and adjacent provenance. The host bare-metal
 * `60-install-rootfs.sh` validates the same shape on every install.
 *
 * Operators query this endpoint to verify "what phantom version is actually
 * running in this VM" and reconcile against `phantomctl tenant get`'s
 * `image_tag`. Drift between the two means an upgrade is in flight, the
 * clone is corrupt, or the daemon hasn't been restarted after a swap (see
 * Phase 18 architect §7.4).
 *
 * The file is read at request-time, not cached in process memory. PR-2 and
 * PR-4 of the Phase 18 plan preserve `/etc/phantom-build-info` across the
 * snapshot-replace upgrade path; reading at request-time means an in-place
 * upgrade that overwrites the file is reflected on the next request without
 * a phantom restart.
 */

const DEFAULT_BUILD_INFO_PATH = "/etc/phantom-build-info";

/**
 * Resolve the build-info file path. Tests + dev containers override via the
 * `PHANTOM_BUILD_INFO_PATH` env var. Production reads the baked-in default.
 */
export function buildInfoPath(): string {
	return process.env.PHANTOM_BUILD_INFO_PATH ?? DEFAULT_BUILD_INFO_PATH;
}

export type BuildInfoReadResult =
	| { kind: "ok"; raw: string; parsed: Record<string, unknown> }
	| { kind: "missing" }
	| { kind: "malformed"; error: string };

/**
 * Read and parse the build-info JSON. Pure file IO + JSON parse; no
 * side-effects, no caching. The caller decides how to surface each result
 * kind to the operator.
 */
export async function readBuildInfo(path: string = buildInfoPath()): Promise<BuildInfoReadResult> {
	let raw: string;
	try {
		raw = await readFile(path, "utf-8");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { kind: "missing" };
		// Other IO errors (EACCES, EISDIR) are also operator-fixable; surface as
		// missing so the endpoint returns 404 with a clean error rather than
		// crashing the request handler.
		return { kind: "missing" };
	}

	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return { kind: "malformed", error: "build-info is not a JSON object" };
		}
		return { kind: "ok", raw, parsed };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { kind: "malformed", error: `build-info JSON parse error: ${message}` };
	}
}
