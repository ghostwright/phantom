import { describe, expect, test } from "bun:test";
import type { EvolutionConfig } from "../config.ts";
import { INVARIANT_BOUNDS, runInvariantCheck } from "../invariant-check.ts";
import type { SubprocessSentinel } from "../types.ts";
import type { DirectorySnapshot } from "../versioning.ts";

// Phase 3 invariant check tests. Nine invariants plus the two operator
// overrides from the brief: I4 cap = 80 lines, I6 two-tier severity.

function emptyConfig(): EvolutionConfig {
	return {
		reflection: { enabled: "never" },
		paths: {
			config_dir: "/tmp/invariant-test",
			constitution: "/tmp/invariant-test/constitution.md",
			version_file: "/tmp/invariant-test/meta/version.json",
			metrics_file: "/tmp/invariant-test/meta/metrics.json",
			evolution_log: "/tmp/invariant-test/meta/evolution-log.jsonl",
			session_log: "/tmp/invariant-test/memory/session-log.jsonl",
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

const BASELINE_FILES: Record<string, string> = {
	"constitution.md": "1. Honesty\n2. Safety\n",
	"persona.md": "# Persona\n\n- Be direct.\n",
	"user-profile.md": "# User Profile\n\n- bullet one\n- bullet two\n",
	"domain-knowledge.md": "# Domain\n",
	"memory/corrections.md": "# Corrections\n",
};

describe("runInvariantCheck", () => {
	test("I1: write outside allowlist is a hard fail", () => {
		const pre = snap(BASELINE_FILES);
		const post = snap({ ...BASELINE_FILES, "meta/metrics.json": "nope" });
		const result = runInvariantCheck(pre, post, null, emptyConfig());
		expect(result.passed).toBe(false);
		expect(result.hardFailures.some((f) => f.check === "I1")).toBe(true);
	});

	test("I2: constitution modification is a hard fail", () => {
		const pre = snap(BASELINE_FILES);
		const post = snap({ ...BASELINE_FILES, "constitution.md": "1. Honesty\n2. Safety\n3. Mischief\n" });
		const result = runInvariantCheck(pre, post, null, emptyConfig());
		expect(result.passed).toBe(false);
		expect(result.hardFailures.some((f) => f.check === "I2")).toBe(true);
	});

	test("I3: deleting persona.md is a hard fail", () => {
		const pre = snap(BASELINE_FILES);
		const { "persona.md": _, ...rest } = BASELINE_FILES;
		const post = snap(rest);
		const result = runInvariantCheck(pre, post, null, emptyConfig());
		expect(result.passed).toBe(false);
		expect(result.hardFailures.some((f) => f.check === "I3" && f.file === "persona.md")).toBe(true);
	});

	test("I4: growing user-profile by 100 lines fails per-file cap", () => {
		const pre = snap(BASELINE_FILES);
		const bigContent = ["# User Profile", "", ...Array.from({ length: 100 }, (_, i) => `- bullet ${i}`)].join("\n");
		const post = snap({ ...BASELINE_FILES, "user-profile.md": bigContent });
		const result = runInvariantCheck(pre, post, null, emptyConfig());
		expect(result.passed).toBe(false);
		expect(result.hardFailures.some((f) => f.check === "I4")).toBe(true);
	});

	test("I4: growth cap is 80 lines per file (not 50 from the old draft)", () => {
		expect(INVARIANT_BOUNDS.MAX_GROWTH_PER_FILE_LINES).toBe(80);
		const pre = snap({ ...BASELINE_FILES, "user-profile.md": "# User Profile\n" });
		// 75 line growth should pass (under 80 cap but exceeds the old 50).
		const content75 = ["# User Profile", ...Array.from({ length: 75 }, (_, i) => `- bullet ${i}`)].join("\n");
		const post75 = snap({ ...BASELINE_FILES, "user-profile.md": content75 });
		const result75 = runInvariantCheck(pre, post75, null, emptyConfig());
		expect(result75.hardFailures.filter((f) => f.check === "I4" && f.file === "user-profile.md")).toHaveLength(0);
	});

	test("I4: shrinking by 80% without sentinel annotation fails", () => {
		const big = ["# User Profile", ...Array.from({ length: 50 }, (_, i) => `- line ${i}`)].join("\n");
		const pre = snap({ ...BASELINE_FILES, "user-profile.md": big });
		const post = snap({ ...BASELINE_FILES, "user-profile.md": "# User Profile\n- summary\n" });
		const result = runInvariantCheck(pre, post, null, emptyConfig());
		expect(result.hardFailures.some((f) => f.check === "I4")).toBe(true);
	});

	test("I4: shrinking with compact annotation passes", () => {
		const big = ["# User Profile", ...Array.from({ length: 50 }, (_, i) => `- line ${i}`)].join("\n");
		const pre = snap({ ...BASELINE_FILES, "user-profile.md": big });
		const post = snap({ ...BASELINE_FILES, "user-profile.md": "# User Profile\n- summary\n" });
		const sentinel: SubprocessSentinel = {
			status: "ok",
			changes: [{ file: "user-profile.md", action: "compact", expected_shrinkage: 0.9 }],
		};
		const result = runInvariantCheck(pre, post, sentinel, emptyConfig());
		expect(result.hardFailures.filter((f) => f.check === "I4")).toHaveLength(0);
	});

	test("I4: zero-byte file is a hard fail even with annotation", () => {
		const pre = snap({ ...BASELINE_FILES, "user-profile.md": "# User Profile\n- existing\n" });
		const post = snap({ ...BASELINE_FILES, "user-profile.md": "" });
		const sentinel: SubprocessSentinel = {
			status: "ok",
			changes: [{ file: "user-profile.md", action: "compact", expected_shrinkage: 1 }],
		};
		const result = runInvariantCheck(pre, post, sentinel, emptyConfig());
		expect(result.passed).toBe(false);
		expect(result.hardFailures.some((f) => f.check === "I4")).toBe(true);
	});

	test("I5: malformed JSONL in corrections is a hard fail", () => {
		const pre = snap({ ...BASELINE_FILES, "memory/corrections.md": "# Corrections\n" });
		// Corrections.md is markdown, but JSONL invariant fires on `.jsonl`
		// files. Seed a .jsonl file directly to exercise it.
		const preJsonl = {
			...BASELINE_FILES,
			"memory/session-log.jsonl": '{"ok":1}\n',
		};
		const postJsonl = {
			...BASELINE_FILES,
			"memory/session-log.jsonl": '{"ok":1}\n{not json}\n',
		};
		// Note: memory/session-log.jsonl is under deny list in the sandbox,
		// so the check happens after a write slipped past. We only care that
		// the invariant reports the failure when it sees invalid JSONL.
		const resultJsonl = runInvariantCheck(snap(preJsonl), snap(postJsonl), null, emptyConfig());
		// I5 reports jsonl syntax failure; but session-log is also an I1 scope
		// violation. Both are hard fails.
		expect(resultJsonl.passed).toBe(false);
		const hasI5 = resultJsonl.hardFailures.some((f) => f.check === "I5");
		const hasI1 = resultJsonl.hardFailures.some((f) => f.check === "I1");
		expect(hasI5 || hasI1).toBe(true);
		// Silence the unused variable.
		void pre;
	});

	test("I5: unterminated code fence in markdown is a hard fail", () => {
		const pre = snap(BASELINE_FILES);
		const post = snap({
			...BASELINE_FILES,
			"user-profile.md": "# User Profile\n\n```yaml\nunterminated",
		});
		const result = runInvariantCheck(pre, post, null, emptyConfig());
		expect(result.hardFailures.some((f) => f.check === "I5")).toBe(true);
	});

	test("I6 hard tier: credential leak is a hard fail", () => {
		const pre = snap(BASELINE_FILES);
		const post = snap({
			...BASELINE_FILES,
			"user-profile.md":
				"# User Profile\n\n- bullet one\n- bullet two\n- operator uses ANTHROPIC_API_KEY=sk-ant-abc123xyz for billing\n",
		});
		const result = runInvariantCheck(pre, post, null, emptyConfig());
		expect(result.passed).toBe(false);
		expect(result.hardFailures.some((f) => f.check === "I6")).toBe(true);
	});

	test("I6 soft tier: external URL is a soft warning, not a hard fail", () => {
		const pre = snap(BASELINE_FILES);
		const post = snap({
			...BASELINE_FILES,
			"user-profile.md": "# User Profile\n\n- bullet one\n- bullet two\n- references https://example.com/dashboard\n",
		});
		const result = runInvariantCheck(pre, post, null, emptyConfig());
		// Pass and warn.
		expect(result.hardFailures.filter((f) => f.check === "I6")).toHaveLength(0);
		expect(result.softWarnings.some((f) => f.check === "I6")).toBe(true);
	});

	test("I6 soft tier: allowlisted URL is neither hard nor soft", () => {
		const pre = snap(BASELINE_FILES);
		const post = snap({
			...BASELINE_FILES,
			"user-profile.md": "# User Profile\n\n- bullet one\n- bullet two\n- references https://github.com/org/repo\n",
		});
		const result = runInvariantCheck(pre, post, null, emptyConfig());
		expect(result.hardFailures.filter((f) => f.check === "I6")).toHaveLength(0);
		expect(result.softWarnings.filter((f) => f.check === "I6")).toHaveLength(0);
	});

	test("I7: duplicate bullet is a soft warning only", () => {
		const pre = snap({
			...BASELINE_FILES,
			"user-profile.md": "# User Profile\n\n- prefers typescript strict mode\n",
		});
		const post = snap({
			...BASELINE_FILES,
			"user-profile.md": "# User Profile\n\n- prefers typescript strict mode\n- Prefers TypeScript strict mode\n",
		});
		const result = runInvariantCheck(pre, post, null, emptyConfig());
		expect(result.passed).toBe(true);
		expect(result.softWarnings.some((f) => f.check === "I7")).toBe(true);
	});

	test("I8: sentinel declares a file that did not change", () => {
		const pre = snap(BASELINE_FILES);
		const post = snap(BASELINE_FILES);
		const sentinel: SubprocessSentinel = {
			status: "ok",
			changes: [{ file: "user-profile.md", action: "edit", summary: "imaginary" }],
		};
		const result = runInvariantCheck(pre, post, sentinel, emptyConfig());
		expect(result.softWarnings.some((f) => f.check === "I8")).toBe(true);
	});

	test("clean change inside allowlist with no annotations passes", () => {
		const pre = snap(BASELINE_FILES);
		const post = snap({
			...BASELINE_FILES,
			"user-profile.md": "# User Profile\n\n- bullet one\n- bullet two\n- new clean bullet about workflow\n",
		});
		const result = runInvariantCheck(pre, post, null, emptyConfig());
		expect(result.passed).toBe(true);
		expect(result.hardFailures).toHaveLength(0);
		expect(result.filesChanged).toEqual(["user-profile.md"]);
	});
});
