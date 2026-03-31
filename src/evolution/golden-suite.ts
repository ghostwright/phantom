import { readFileSync, writeFileSync } from "node:fs";
import type { EvolutionConfig } from "./config.ts";
import type { GoldenCase } from "./types.ts";

/**
 * Load the golden test suite from phantom-config/meta/golden-suite.jsonl.
 */
export function loadSuite(config: EvolutionConfig): GoldenCase[] {
	const cases: GoldenCase[] = [];

	try {
		const text = readFileSync(config.paths.golden_suite, "utf-8").trim();
		if (!text) return [];

		for (const line of text.split("\n").filter(Boolean)) {
			try {
				cases.push(JSON.parse(line) as GoldenCase);
			} catch {
				// Skip malformed lines
			}
		}
	} catch {
		return [];
	}

	return cases;
}

/**
 * Add a new golden test case.
 * Cases are added when successful interactions produce valuable lessons.
 */
export function addCase(config: EvolutionConfig, goldenCase: GoldenCase): void {
	const existing = loadSuite(config);

	// Deduplicate: don't add if a very similar case already exists
	const isDuplicate = existing.some((c) => c.lesson.toLowerCase() === goldenCase.lesson.toLowerCase());
	if (isDuplicate) return;

	try {
		const currentContent = readFileSync(config.paths.golden_suite, "utf-8");
		writeFileSync(config.paths.golden_suite, `${currentContent + JSON.stringify(goldenCase)}\n`, "utf-8");
	} catch {
		writeFileSync(config.paths.golden_suite, `${JSON.stringify(goldenCase)}\n`, "utf-8");
	}
}

/**
 * Prune the golden suite to the given max size, removing oldest entries.
 * No-op if the suite is within the limit.
 */
export function pruneSuite(config: EvolutionConfig, maxSize: number): number {
	const suite = loadSuite(config);
	if (suite.length <= maxSize) return 0;

	const sorted = suite.sort((a, b) => b.created_at.localeCompare(a.created_at));
	const pruned = sorted.slice(0, maxSize);
	const content = pruned.map((c) => JSON.stringify(c)).join("\n");
	writeFileSync(config.paths.golden_suite, `${content}\n`, "utf-8");

	return suite.length - maxSize;
}

/**
 * Run the golden suite against a proposed change description.
 * Returns cases that might be affected.
 */
export function findAffectedCases(config: EvolutionConfig, changeContent: string): GoldenCase[] {
	const suite = loadSuite(config);
	if (suite.length === 0) return [];

	const changeTokens = tokenize(changeContent);
	const affected: GoldenCase[] = [];

	for (const golden of suite) {
		const lessonTokens = tokenize(golden.lesson);
		const overlap = [...changeTokens].filter((t) => lessonTokens.has(t));

		// If significant token overlap, the case might be affected
		if (overlap.length >= 2 && overlap.length / Math.max(changeTokens.size, 1) > 0.2) {
			affected.push(golden);
		}
	}

	return affected;
}

function tokenize(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.replace(/[^\w\s]/g, " ")
			.split(/\s+/)
			.filter((t) => t.length > 3),
	);
}
