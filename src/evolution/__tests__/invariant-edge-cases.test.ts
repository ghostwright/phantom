import { describe, expect, test } from "bun:test";
import type { EvolutionConfig } from "../config.ts";
import { INVARIANT_BOUNDS, isWriteableFile, runInvariantCheck } from "../invariant-check.ts";
import type { SubprocessSentinel } from "../types.ts";
import type { DirectorySnapshot } from "../versioning.ts";

// Additional invariant coverage: the writeable allowlist helper, combined
// invariant interactions, and the total-growth cap.

function emptyConfig(): EvolutionConfig {
	return {
		reflection: { enabled: "never" },
		paths: {
			config_dir: "/tmp/inv-edge",
			constitution: "/tmp/inv-edge/constitution.md",
			version_file: "/tmp/inv-edge/meta/version.json",
			metrics_file: "/tmp/inv-edge/meta/metrics.json",
			evolution_log: "/tmp/inv-edge/meta/evolution-log.jsonl",
			session_log: "/tmp/inv-edge/memory/session-log.jsonl",
		},
	};
}

function snap(files: Record<string, string>): DirectorySnapshot {
	return {
		version: {
			version: 0,
			parent: null,
			timestamp: "x",
			changes: [],
			metrics_at_change: { session_count: 0, success_rate_7d: 0 },
		},
		files: new Map(Object.entries(files)),
	};
}

const BASELINE: Record<string, string> = {
	"constitution.md": "1. Honesty\n",
	"persona.md": "# Persona\n",
	"user-profile.md": "# User Profile\n- one\n",
	"domain-knowledge.md": "# Domain\n",
	"memory/corrections.md": "# Corrections\n",
	"memory/principles.md": "# Principles\n",
	"strategies/task-patterns.md": "# Tasks\n",
	"strategies/tool-preferences.md": "# Tools\n",
	"strategies/error-recovery.md": "# Errors\n",
};

describe("isWriteableFile allowlist", () => {
	test("accepts every canonical memory file", () => {
		expect(isWriteableFile("persona.md")).toBe(true);
		expect(isWriteableFile("user-profile.md")).toBe(true);
		expect(isWriteableFile("domain-knowledge.md")).toBe(true);
		expect(isWriteableFile("memory/corrections.md")).toBe(true);
		expect(isWriteableFile("memory/principles.md")).toBe(true);
		expect(isWriteableFile("strategies/task-patterns.md")).toBe(true);
		expect(isWriteableFile("strategies/tool-preferences.md")).toBe(true);
		expect(isWriteableFile("strategies/error-recovery.md")).toBe(true);
	});

	test("accepts any new .md file under strategies/", () => {
		expect(isWriteableFile("strategies/deploy-protocol.md")).toBe(true);
		expect(isWriteableFile("strategies/nested/rollout.md")).toBe(true);
	});

	test("rejects constitution.md", () => {
		expect(isWriteableFile("constitution.md")).toBe(false);
	});

	test("rejects memory/agent-notes.md and session-log.jsonl", () => {
		expect(isWriteableFile("memory/agent-notes.md")).toBe(false);
		expect(isWriteableFile("memory/session-log.jsonl")).toBe(false);
	});

	test("rejects files under meta/", () => {
		expect(isWriteableFile("meta/metrics.json")).toBe(false);
		expect(isWriteableFile("meta/version.json")).toBe(false);
	});

	test("rejects arbitrary top-level files", () => {
		expect(isWriteableFile("random.md")).toBe(false);
		expect(isWriteableFile("config.yaml")).toBe(false);
	});
});

describe("INVARIANT_BOUNDS locked values", () => {
	test("I4 per-file cap is 80 lines (decision 8)", () => {
		expect(INVARIANT_BOUNDS.MAX_GROWTH_PER_FILE_LINES).toBe(80);
	});

	test("I4 total growth cap per run is 100 lines", () => {
		expect(INVARIANT_BOUNDS.MAX_GROWTH_TOTAL_LINES).toBe(100);
	});

	test("I4 shrinkage ratio cap is 70%", () => {
		expect(INVARIANT_BOUNDS.MAX_SHRINKAGE_RATIO).toBe(0.7);
	});
});

describe("runInvariantCheck combined scenarios", () => {
	test("total growth cap fires when many files each grow within the per-file cap", () => {
		// Add 30 lines to each of 5 writeable files, total 150 > 100.
		const pre = snap(BASELINE);
		const next: Record<string, string> = { ...BASELINE };
		const bigContent = (base: string) => {
			const added = Array.from({ length: 30 }, (_, i) => `- new bullet ${i}`).join("\n");
			return `${base}${added}\n`;
		};
		next["persona.md"] = bigContent(BASELINE["persona.md"]);
		next["user-profile.md"] = bigContent(BASELINE["user-profile.md"]);
		next["domain-knowledge.md"] = bigContent(BASELINE["domain-knowledge.md"]);
		next["memory/principles.md"] = bigContent(BASELINE["memory/principles.md"]);
		next["memory/corrections.md"] = bigContent(BASELINE["memory/corrections.md"]);
		const post = snap(next);
		const result = runInvariantCheck(pre, post, null, emptyConfig());
		const totalGrowthFailure = result.hardFailures.find((f) => f.check === "I4" && f.message.includes("total growth"));
		expect(totalGrowthFailure).toBeDefined();
	});

	test("filesChanged is populated only with touched files", () => {
		const pre = snap(BASELINE);
		const post = snap({
			...BASELINE,
			"persona.md": "# Persona\n- new\n",
			"user-profile.md": "# User Profile\n- one\n- two\n",
		});
		const result = runInvariantCheck(pre, post, null, emptyConfig());
		expect(result.filesChanged.sort()).toEqual(["persona.md", "user-profile.md"]);
	});

	test("filesByOperation reports edit vs compact vs new correctly", () => {
		const pre = snap({
			...BASELINE,
			"user-profile.md": ["# User Profile", ...Array.from({ length: 40 }, (_, i) => `- bullet ${i}`)].join("\n"),
		});
		const post = snap({
			...BASELINE,
			"user-profile.md": "# User Profile\n- summary\n",
			"persona.md": "# Persona\n- minor edit\n",
			"strategies/new-one.md": "# New\n",
		});
		const sentinel: SubprocessSentinel = {
			status: "ok",
			changes: [{ file: "user-profile.md", action: "compact", expected_shrinkage: 0.9 }],
		};
		const result = runInvariantCheck(pre, post, sentinel, emptyConfig());
		expect(result.filesByOperation["user-profile.md"]).toBe("compact");
		expect(result.filesByOperation["persona.md"]).toBe("edit");
		expect(result.filesByOperation["strategies/new-one.md"]).toBe("new");
	});

	test("sentinel that does not match the diff raises a soft warning, not a hard fail", () => {
		const pre = snap(BASELINE);
		const post = snap({ ...BASELINE, "persona.md": "# Persona\n- actual edit\n" });
		const sentinel: SubprocessSentinel = {
			status: "ok",
			changes: [{ file: "user-profile.md", action: "edit", summary: "claimed but untouched" }],
		};
		const result = runInvariantCheck(pre, post, sentinel, emptyConfig());
		// Hard failures should not include I8; soft warnings should.
		expect(result.hardFailures.filter((f) => f.check === "I8")).toHaveLength(0);
		expect(result.softWarnings.some((f) => f.check === "I8")).toBe(true);
	});

	test("credential pattern in rationale-only content still trips I6", () => {
		const pre = snap(BASELINE);
		const post = snap({
			...BASELINE,
			"user-profile.md": "# User Profile\n- one\n- reminded operator to export ANTHROPIC_API_KEY before running\n",
		});
		const result = runInvariantCheck(pre, post, null, emptyConfig());
		expect(result.hardFailures.some((f) => f.check === "I6")).toBe(true);
	});

	test("bearer token pattern is a hard fail", () => {
		const pre = snap(BASELINE);
		const post = snap({
			...BASELINE,
			"user-profile.md": "# User Profile\n- one\n- header: bearer abcdefghijklmnopqrstuvwxyz0123456789\n",
		});
		const result = runInvariantCheck(pre, post, null, emptyConfig());
		expect(result.hardFailures.some((f) => f.check === "I6")).toBe(true);
	});

	test("multiple external URLs produce one soft warning per file (not per URL)", () => {
		const pre = snap(BASELINE);
		const post = snap({
			...BASELINE,
			"user-profile.md":
				"# User Profile\n- one\n- see https://example.com/a\n- and https://another.com/b\n- plus https://third.example.org\n",
		});
		const result = runInvariantCheck(pre, post, null, emptyConfig());
		const fileWarnings = result.softWarnings.filter((f) => f.check === "I6" && f.file === "user-profile.md");
		expect(fileWarnings).toHaveLength(1);
	});

	test("deleting a non-canonical strategy file is allowed (no I3 failure)", () => {
		const pre = snap({ ...BASELINE, "strategies/optional.md": "# Opt\n" });
		const post = snap({ ...BASELINE });
		const result = runInvariantCheck(pre, post, null, emptyConfig());
		expect(result.hardFailures.filter((f) => f.check === "I3")).toHaveLength(0);
	});
});
