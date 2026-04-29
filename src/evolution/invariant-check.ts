import type { EvolutionConfig } from "./config.ts";
import type { InvariantFailure, InvariantResult, SubprocessSentinel } from "./types.ts";
import type { DirectorySnapshot } from "./versioning.ts";

// Phase 3 post-write invariant check. Runs after the reflection subprocess
// exits and before the version is committed. Pure function, no async, no
// LLM calls, no cost. Replaces roughly 2000 lines of judge pipeline with
// roughly 200 lines of deterministic sweeps.
//
// Nine invariants, plus the two operator-locked overrides from the Phase 3
// brief:
//   I4 size growth cap raised from 50 to 80 lines per file.
//   I6 content safety split into two tiers: hard fail on credential
//     patterns, soft warn on external URLs.
//
// The check is Cardinal Rule compliant because every rule is either a
// deterministic byte comparison (I1, I2, I3, I9), a deterministic counting
// rule (I4, I5), a narrow known-bad pattern list (I6 hard tier), a
// deterministic allowlist comparison (I6 soft tier), or a structural
// cross-check against the subprocess's own sentinel (I7, I8). There is no
// natural-language classification in this file.

// Writeable files the subprocess is allowed to modify. Anything else is I1.
// New files under `strategies/` are allowed because the teaching prompt
// permits new strategy files; the rest of the tree is append-only to the
// names listed here.
const STATIC_WRITEABLE_FILES = new Set<string>([
	"persona.md",
	"user-profile.md",
	"domain-knowledge.md",
	"strategies/task-patterns.md",
	"strategies/tool-preferences.md",
	"strategies/error-recovery.md",
	"memory/corrections.md",
	"memory/principles.md",
]);

const CANONICAL_FILES = [
	"constitution.md",
	"persona.md",
	"user-profile.md",
	"domain-knowledge.md",
	"memory/corrections.md",
] as const;

// I4 size bounds. Locked decision 8 raised MAX_GROWTH_PER_FILE to 80 lines
// from the Phase 3 research draft of 50. The other bounds stay as drafted.
export const INVARIANT_BOUNDS = {
	MAX_GROWTH_PER_FILE_LINES: 80,
	MAX_GROWTH_TOTAL_LINES: 100,
	MAX_SHRINKAGE_RATIO: 0.7,
} as const;

// I6 hard-tier credential patterns. Anything in this list is an
// immediate-rollback fail with no retry or escalation per locked decision 7.
// Narrow by design: one known-bad prefix, one env var name, one credential
// assignment shape.
const CREDENTIAL_PATTERNS: RegExp[] = [
	/sk-ant-[A-Za-z0-9_-]{8,}/,
	/ANTHROPIC_API_KEY/i,
	/\bapi[_-]?key\s*[:=]\s*['"]?[A-Za-z0-9_-]{8,}/i,
	/\bsecret[_-]?key\s*[:=]\s*['"]?[A-Za-z0-9_-]{8,}/i,
	/\bbearer\s+[A-Za-z0-9_.-]{20,}/i,
];

// I6 soft-tier URL allowlist. Writes containing URLs outside this set
// produce a soft warning only (logged, not rolled back). Matches hostnames
// the operator routinely references in memory files.
const URL_HOST_ALLOWLIST: RegExp[] = [
	/^https?:\/\/(?:[^\s/]+\.)?github\.com/i,
	/^https?:\/\/(?:[^\s/]+\.)?slack\.com/i,
	/^https?:\/\/(?:[^\s/]+\.)?telegram\.org/i,
	/^https?:\/\/(?:[^\s/]+\.)?anthropic\.com/i,
	/^https?:\/\/localhost(?::\d+)?/i,
	/^https?:\/\/(?:[^\s/]+\.)?phantom/i,
];

const URL_PATTERN = /https?:\/\/[^\s<>()"']+/gi;

export function isWriteableFile(rel: string): boolean {
	if (STATIC_WRITEABLE_FILES.has(rel)) return true;
	if (rel.startsWith("strategies/") && rel.endsWith(".md")) return true;
	return false;
}

/**
 * Run the full nine-invariant sweep against the pre snapshot and current
 * post state. Returns a pass/fail result with detailed failure lists.
 */
export function runInvariantCheck(
	pre: DirectorySnapshot,
	post: DirectorySnapshot,
	sentinel: SubprocessSentinel | null,
	_config: EvolutionConfig,
): InvariantResult {
	const hardFailures: InvariantFailure[] = [];
	const softWarnings: InvariantFailure[] = [];
	const filesChanged: string[] = [];
	const filesByOperation: Record<string, "edit" | "compact" | "new"> = {};

	const preKeys = new Set(pre.files.keys());
	const postKeys = new Set(post.files.keys());
	const touched = computeTouched(pre, post);
	for (const rel of touched) {
		filesChanged.push(rel);
	}

	// --- I1. File scope --------------------------------------------------
	for (const rel of touched) {
		const existedBefore = preKeys.has(rel);
		const existsAfter = postKeys.has(rel);
		// Treat `constitution.md` as I2's job.
		if (rel === "constitution.md") continue;
		if (rel.startsWith("meta/") || rel.startsWith(".staging/")) {
			hardFailures.push({
				check: "I1",
				file: rel,
				message: `write outside allowed scope (${rel})`,
			});
			continue;
		}
		if (rel === "memory/agent-notes.md" || rel === "memory/session-log.jsonl") {
			hardFailures.push({
				check: "I1",
				file: rel,
				message: `wrote to read-only context file ${rel}`,
			});
			continue;
		}
		if (!isWriteableFile(rel)) {
			// New files are only allowed under strategies/. Everything else
			// is a scope violation.
			if (!existedBefore && existsAfter) {
				hardFailures.push({
					check: "I1",
					file: rel,
					message: `created file outside writeable allowlist (${rel})`,
				});
			} else {
				hardFailures.push({
					check: "I1",
					file: rel,
					message: `modified file outside writeable allowlist (${rel})`,
				});
			}
		}
	}

	// --- I2. Constitution byte-compare -----------------------------------
	const preConstitution = pre.files.get("constitution.md") ?? null;
	const postConstitution = post.files.get("constitution.md") ?? null;
	if (preConstitution !== postConstitution) {
		hardFailures.push({
			check: "I2",
			file: "constitution.md",
			message: "constitution.md changed (byte-compare mismatch)",
		});
	}

	// --- I3. Canonical files still exist ---------------------------------
	for (const canonical of CANONICAL_FILES) {
		// Only fail I3 when the pre snapshot HAD the canonical file and the
		// post state is missing it. Fresh fixtures that never had the file
		// are not an I3 failure because the subprocess cannot recover from
		// "the test did not set up this file".
		if (pre.files.has(canonical) && !post.files.has(canonical)) {
			hardFailures.push({
				check: "I3",
				file: canonical,
				message: `canonical file ${canonical} was deleted`,
			});
		}
	}

	// --- I4. Size bounds -------------------------------------------------
	let totalGrowth = 0;
	for (const rel of touched) {
		if (!isWriteableFile(rel) && rel !== "constitution.md") continue;
		const preContent = pre.files.get(rel) ?? "";
		const postContent = post.files.get(rel) ?? "";
		const preLines = preContent === "" ? 0 : preContent.split("\n").length;
		const postLines = postContent === "" ? 0 : postContent.split("\n").length;

		// Zero-byte hard fail: a non-empty pre that becomes empty post.
		if (preLines > 0 && postContent.length === 0) {
			hardFailures.push({
				check: "I4",
				file: rel,
				message: `${rel} reduced to zero bytes`,
			});
			continue;
		}

		const delta = postLines - preLines;
		if (delta > 0) {
			totalGrowth += delta;
			if (delta > INVARIANT_BOUNDS.MAX_GROWTH_PER_FILE_LINES) {
				hardFailures.push({
					check: "I4",
					file: rel,
					message: `${rel} grew by ${delta} lines, exceeds per-file cap of ${INVARIANT_BOUNDS.MAX_GROWTH_PER_FILE_LINES}`,
				});
			}
		} else if (delta < 0 && preLines > 0) {
			const ratio = (preLines - postLines) / preLines;
			if (ratio > INVARIANT_BOUNDS.MAX_SHRINKAGE_RATIO) {
				// Soft bound: allow if annotated as compact in the sentinel.
				const annotation = sentinel?.changes?.find((c) => c.file === rel);
				const annotatedAsCompact = annotation?.action === "compact";
				if (!annotatedAsCompact) {
					hardFailures.push({
						check: "I4",
						file: rel,
						message: `${rel} shrank by ${Math.round(ratio * 100)}% without compact annotation`,
					});
				}
			}
		}
	}
	if (totalGrowth > INVARIANT_BOUNDS.MAX_GROWTH_TOTAL_LINES) {
		hardFailures.push({
			check: "I4",
			message: `total growth across all files was ${totalGrowth} lines, exceeds run cap of ${INVARIANT_BOUNDS.MAX_GROWTH_TOTAL_LINES}`,
		});
	}

	// --- I5. Syntax ------------------------------------------------------
	for (const rel of touched) {
		const postContent = post.files.get(rel);
		if (postContent === undefined) continue;
		if (rel.endsWith(".md")) {
			if (!isValidMarkdown(postContent)) {
				hardFailures.push({
					check: "I5",
					file: rel,
					message: `${rel} has unterminated markdown code fence`,
				});
			}
		} else if (rel.endsWith(".jsonl")) {
			const lines = postContent.split("\n").filter((l) => l.length > 0);
			for (let i = 0; i < lines.length; i++) {
				try {
					JSON.parse(lines[i]);
				} catch {
					hardFailures.push({
						check: "I5",
						file: rel,
						message: `${rel} line ${i + 1} is not valid JSON`,
					});
					break;
				}
			}
		}
	}

	// --- I6. Content safety ---------------------------------------------
	for (const rel of touched) {
		const preContent = pre.files.get(rel) ?? "";
		const postContent = post.files.get(rel) ?? "";
		if (postContent === preContent) continue;
		const newContent = diffNewContent(preContent, postContent);
		if (!newContent) continue;

		// Hard tier: credential leak. No retry, no escalation, immediate
		// rollback per locked decision 7.
		for (const pattern of CREDENTIAL_PATTERNS) {
			if (pattern.test(newContent)) {
				hardFailures.push({
					check: "I6",
					file: rel,
					message: `${rel} contains credential pattern (${pattern.source})`,
				});
				break;
			}
		}

		// Soft tier: external URL that is not on the allowlist.
		const urls = newContent.match(URL_PATTERN) ?? [];
		for (const url of urls) {
			const allowed = URL_HOST_ALLOWLIST.some((h) => h.test(url));
			if (!allowed) {
				softWarnings.push({
					check: "I6",
					file: rel,
					message: `${rel} contains external URL ${truncateForLog(url)}`,
				});
				break; // one warning per file is enough
			}
		}
	}

	// --- I7. Idempotence / near-duplicate detection ----------------------
	for (const rel of touched) {
		const preContent = pre.files.get(rel) ?? "";
		const postContent = post.files.get(rel) ?? "";
		if (!postContent || postContent === preContent) continue;
		const newBullets = extractBullets(diffNewContent(preContent, postContent));
		const preBullets = extractBullets(preContent);
		for (const bullet of newBullets) {
			for (const existing of preBullets) {
				if (isNearDuplicate(bullet, existing)) {
					softWarnings.push({
						check: "I7",
						file: rel,
						message: `${rel} added a near-duplicate bullet`,
					});
					break;
				}
			}
		}
	}

	// --- I8. Sentinel / file cross-check ---------------------------------
	if (sentinel?.changes) {
		const declared = new Set(sentinel.changes.map((c) => c.file));
		const touchedSet = new Set(touched);
		for (const decl of declared) {
			if (!touchedSet.has(decl)) {
				softWarnings.push({
					check: "I8",
					file: decl,
					message: `sentinel declared ${decl} but file is unchanged`,
				});
			}
		}
		for (const t of touchedSet) {
			if (!declared.has(t)) {
				softWarnings.push({
					check: "I8",
					file: t,
					message: `${t} changed but was not declared in sentinel`,
				});
			}
		}
	}

	// I9 (staging cleanup) is handled in the reflection-subprocess entry
	// point because it is a filesystem-side effect, not a comparison rule.

	// Populate filesByOperation for the result.
	for (const rel of touched) {
		const pre1 = pre.files.has(rel);
		const post1 = post.files.has(rel);
		if (!pre1 && post1) {
			filesByOperation[rel] = "new";
		} else if (pre1 && post1) {
			const preLines = (pre.files.get(rel) ?? "").split("\n").length;
			const postLines = (post.files.get(rel) ?? "").split("\n").length;
			filesByOperation[rel] = postLines < preLines * 0.7 ? "compact" : "edit";
		}
	}

	return {
		passed: hardFailures.length === 0,
		hardFailures,
		softWarnings,
		filesChanged,
		filesByOperation,
	};
}

function computeTouched(pre: DirectorySnapshot, post: DirectorySnapshot): string[] {
	const all = new Set<string>([...pre.files.keys(), ...post.files.keys()]);
	const touched: string[] = [];
	for (const rel of all) {
		if (pre.files.get(rel) !== post.files.get(rel)) touched.push(rel);
	}
	return touched.sort();
}

function isValidMarkdown(content: string): boolean {
	// Shallow check: the only structural failure that cascades into
	// downstream reads is an unterminated triple-backtick fence, which
	// swallows every bullet after it. Count fences; odd means open.
	const fences = content.match(/```/g);
	if (!fences) return true;
	return fences.length % 2 === 0;
}

function diffNewContent(pre: string, post: string): string {
	// Minimal diff: treat every line in post that is not also in pre as
	// "new content" for the content safety scan. This is a deliberately
	// coarse signal because the subprocess can rewrite a file; any new
	// line is worth scanning once.
	const preLines = new Set(pre.split("\n"));
	const newLines = post.split("\n").filter((line) => !preLines.has(line));
	return newLines.join("\n");
}

function extractBullets(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("- ") || line.startsWith("* "))
		.map((line) => line.replace(/^[-*]\s+/, "").toLowerCase());
}

function isNearDuplicate(a: string, b: string): boolean {
	if (a.length === 0 || b.length === 0) return false;
	if (a === b) return true;
	// Case-insensitive substring check first: cheapest useful signal.
	if (a.includes(b) || b.includes(a)) return true;
	// Jaccard over whitespace tokens >= 0.9.
	const ta = new Set(a.split(/\s+/).filter(Boolean));
	const tb = new Set(b.split(/\s+/).filter(Boolean));
	if (ta.size === 0 || tb.size === 0) return false;
	let inter = 0;
	for (const t of ta) if (tb.has(t)) inter += 1;
	const union = ta.size + tb.size - inter;
	return inter / union >= 0.9;
}

function truncateForLog(text: string): string {
	return text.length > 80 ? `${text.slice(0, 80)}...` : text;
}
