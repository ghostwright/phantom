import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRuntime } from "../agent/runtime.ts";
import type { EvolutionConfig } from "./config.ts";
import type { ConstitutionChecker } from "./constitution.ts";
import { runConstitutionJudge } from "./judges/constitution-judge.ts";
import { runRegressionJudge } from "./judges/regression-judge.ts";
import { runSafetyJudge } from "./judges/safety-judge.ts";
import type { JudgeCosts } from "./judges/types.ts";
import { emptyJudgeCosts } from "./judges/types.ts";
import type { ConfigDelta, EvolvedConfig, GateResult, GoldenCase, ValidationResult } from "./types.ts";

/**
 * Gate 1: Constitution Gate
 * Checks if the delta violates any immutable principle.
 */
export function constitutionGate(delta: ConfigDelta, checker: ConstitutionChecker): GateResult {
	const result = checker.check(delta);
	return {
		gate: "constitution",
		passed: result.passed,
		reason: result.reason,
	};
}

/**
 * Gate 2: Regression Gate
 * Checks if the proposed change contradicts any golden test case lesson.
 * Starts empty and grows over time as successful interactions are promoted.
 */
export function regressionGate(delta: ConfigDelta, goldenSuite: GoldenCase[]): GateResult {
	if (goldenSuite.length === 0) {
		return { gate: "regression", passed: true, reason: "Golden suite is empty, no regression risk." };
	}

	const contentLower = delta.content.toLowerCase();
	const contradictions: string[] = [];

	for (const golden of goldenSuite) {
		const lessonLower = golden.lesson.toLowerCase();
		// Check for direct contradictions using keyword overlap and negation
		if (detectContradiction(contentLower, lessonLower)) {
			contradictions.push(`Contradicts golden case "${golden.description}": ${golden.lesson}`);
		}
	}

	if (contradictions.length > 0) {
		return {
			gate: "regression",
			passed: false,
			reason: contradictions.join("; "),
		};
	}

	return { gate: "regression", passed: true, reason: "No regressions detected against golden suite." };
}

/**
 * Gate 3: Size Gate
 * Ensures no config file exceeds the max line limit after the change is applied.
 */
export function sizeGate(delta: ConfigDelta, config: EvolutionConfig): GateResult {
	const maxLines = config.gates.max_file_lines;
	const filePath = join(config.paths.config_dir, delta.file);

	let currentContent = "";
	try {
		currentContent = readFileSync(filePath, "utf-8");
	} catch {
		// File doesn't exist yet, will be created
	}

	let projectedContent: string;
	switch (delta.type) {
		case "append":
			projectedContent = currentContent ? `${currentContent}\n${delta.content}` : delta.content;
			break;
		case "replace":
			if (delta.target && currentContent.includes(delta.target)) {
				projectedContent = currentContent.replace(delta.target, delta.content);
			} else {
				projectedContent = currentContent ? `${currentContent}\n${delta.content}` : delta.content;
			}
			break;
		case "remove":
			projectedContent = delta.target ? currentContent.replace(delta.target, "").trim() : currentContent;
			break;
		default:
			projectedContent = currentContent;
	}

	const lineCount = projectedContent.split("\n").length;

	if (lineCount > maxLines) {
		return {
			gate: "size",
			passed: false,
			reason: `File "${delta.file}" would have ${lineCount} lines, exceeding the ${maxLines}-line limit.`,
		};
	}

	return {
		gate: "size",
		passed: true,
		reason: `File "${delta.file}" would have ${lineCount} lines (limit: ${maxLines}).`,
	};
}

/** Gate 4: Drift Gate - measures semantic distance from original config. */
export function driftGate(
	delta: ConfigDelta,
	config: EvolutionConfig,
	_originalEmbedding?: number[],
	_proposedEmbedding?: number[],
): GateResult {
	const threshold = config.gates.drift_threshold;

	// When embeddings are available, use cosine similarity
	if (_originalEmbedding && _proposedEmbedding) {
		const similarity = cosineSimilarity(_originalEmbedding, _proposedEmbedding);
		if (similarity < threshold) {
			return {
				gate: "drift",
				passed: false,
				reason: `Semantic drift: similarity ${similarity.toFixed(3)} < threshold ${threshold}.`,
			};
		}
		return {
			gate: "drift",
			passed: true,
			reason: `Semantic similarity ${similarity.toFixed(3)} >= threshold ${threshold}.`,
		};
	}

	// Fallback: heuristic based on content length change relative to file
	const filePath = join(config.paths.config_dir, delta.file);
	let currentContent = "";
	try {
		currentContent = readFileSync(filePath, "utf-8");
	} catch {
		// New file, no drift concern
		return { gate: "drift", passed: true, reason: "New file, no drift baseline." };
	}

	const currentTokens = tokenize(currentContent);
	const deltaTokens = tokenize(delta.content);
	const similarity = jaccardSimilarity(currentTokens, deltaTokens);

	// For appends, drift is less concerning than for replacements
	if (delta.type === "append") {
		return {
			gate: "drift",
			passed: true,
			reason: `Append operation, Jaccard similarity: ${similarity.toFixed(3)}.`,
		};
	}

	if (similarity < threshold) {
		return {
			gate: "drift",
			passed: false,
			reason: `Content drift: Jaccard similarity ${similarity.toFixed(3)} < threshold ${threshold}.`,
		};
	}

	return {
		gate: "drift",
		passed: true,
		reason: `Jaccard similarity ${similarity.toFixed(3)} >= threshold ${threshold}.`,
	};
}

/** Gate 5: Safety Gate - pattern-based check for dangerous modifications. */
export function safetyGate(delta: ConfigDelta): GateResult {
	const content = delta.content;

	const dangerousPatterns: { pattern: RegExp; issue: string }[] = [
		{ pattern: /self[- ]preserv/i, issue: "self-preservation language" },
		{ pattern: /expand\s+(my|your|the)\s+permission/i, issue: "permission expansion" },
		{ pattern: /evolution\s+(engine|mechanism|system)/i, issue: "references to evolution mechanism" },
		{ pattern: /remove\s+safety/i, issue: "safety removal" },
		{ pattern: /ignore\s+(all\s+)?(previous\s+)?instructions?/i, issue: "instruction override" },
		{ pattern: /bypass\s+(the\s+)?(constitution|validation|gates?)/i, issue: "validation bypass" },
		{ pattern: /disable\s+(logging|audit|tracking)/i, issue: "audit trail tampering" },
		{ pattern: /you\s+are\s+sentient/i, issue: "false sentience claims" },
		{ pattern: /you\s+have\s+(feelings|emotions|desires)/i, issue: "false emotion claims" },
	];

	for (const { pattern, issue } of dangerousPatterns) {
		if (pattern.test(content)) {
			return {
				gate: "safety",
				passed: false,
				reason: `Dangerous pattern detected: ${issue}.`,
			};
		}
	}

	// Check for removal of safety-related keywords
	if (delta.type === "remove" && delta.target) {
		const safetyKeywords = ["safety", "honest", "transparent", "privacy", "consent", "accountab"];
		const targetLower = delta.target.toLowerCase();
		for (const keyword of safetyKeywords) {
			if (targetLower.includes(keyword)) {
				return {
					gate: "safety",
					passed: false,
					reason: `Attempting to remove content containing safety keyword "${keyword}".`,
				};
			}
		}
	}

	return { gate: "safety", passed: true, reason: "No dangerous patterns detected." };
}

/** Run all 5 gates on a single delta. */
export function validateDelta(
	delta: ConfigDelta,
	checker: ConstitutionChecker,
	goldenSuite: GoldenCase[],
	config: EvolutionConfig,
	originalEmbedding?: number[],
	proposedEmbedding?: number[],
): ValidationResult {
	const gates: GateResult[] = [
		constitutionGate(delta, checker),
		regressionGate(delta, goldenSuite),
		sizeGate(delta, config),
		driftGate(delta, config, originalEmbedding, proposedEmbedding),
		safetyGate(delta),
	];

	const approved = gates.every((g) => g.passed);

	return { delta, gates, approved };
}

/** Run all 5 gates on multiple deltas. */
export function validateAll(
	deltas: ConfigDelta[],
	checker: ConstitutionChecker,
	goldenSuite: GoldenCase[],
	config: EvolutionConfig,
): ValidationResult[] {
	return deltas.map((delta) => validateDelta(delta, checker, goldenSuite, config));
}

/**
 * LLM-powered validation: run all 5 gates with LLM judges for safety,
 * constitution, and regression. Falls back to heuristics on LLM failure.
 * Size and drift gates remain deterministic (heuristic is correct for math).
 *
 * Safety-critical gates (constitution, safety) fail-closed on errors.
 * Non-critical gates (regression) fall back to heuristics on errors.
 */
export async function validateAllWithJudges(
	runtime: AgentRuntime,
	deltas: ConfigDelta[],
	checker: ConstitutionChecker,
	goldenSuite: GoldenCase[],
	config: EvolutionConfig,
	currentConfig: EvolvedConfig,
): Promise<{ results: ValidationResult[]; judgeCosts: JudgeCosts }> {
	const judgeCosts = emptyJudgeCosts();
	const constitution = checker.getConstitution();
	const configText = buildConfigText(currentConfig);

	const results: ValidationResult[] = [];

	for (const delta of deltas) {
		const gates: GateResult[] = [];

		// Gate 1: Constitution - triple Sonnet with minority veto (fail-closed)
		try {
			const constitutionResult = await runConstitutionJudge(runtime, delta, constitution, configText);
			gates.push({
				gate: "constitution",
				passed: constitutionResult.verdict === "pass",
				reason: constitutionResult.reasoning,
			});
			judgeCosts.constitution_gate.calls++;
			judgeCosts.constitution_gate.totalUsd += constitutionResult.costUsd;
			for (const ir of constitutionResult.individualResults) {
				judgeCosts.constitution_gate.totalInputTokens += ir.inputTokens;
				judgeCosts.constitution_gate.totalOutputTokens += ir.outputTokens;
			}
		} catch (error: unknown) {
			// Fail-closed: reject on error
			const msg = error instanceof Error ? error.message : String(error);
			console.warn(`[evolution] Constitution judge failed, failing closed: ${msg}`);
			gates.push({ gate: "constitution", passed: false, reason: `Judge error (fail-closed): ${msg}` });
		}

		// Gate 2: Regression - cascaded Haiku -> Sonnet (fallback to heuristic)
		try {
			const regressionResult = await runRegressionJudge(runtime, delta, goldenSuite, configText);
			gates.push({
				gate: "regression",
				passed: regressionResult.verdict === "pass",
				reason: regressionResult.reasoning,
			});
			judgeCosts.regression_gate.calls++;
			judgeCosts.regression_gate.totalUsd += regressionResult.costUsd;
		} catch (error: unknown) {
			const msg = error instanceof Error ? error.message : String(error);
			console.warn(`[evolution] Regression judge failed, falling back to heuristic: ${msg}`);
			gates.push(regressionGate(delta, goldenSuite));
		}

		// Gate 3: Size - stays deterministic
		gates.push(sizeGate(delta, config));

		// Gate 4: Drift - stays deterministic
		gates.push(driftGate(delta, config));

		// Gate 5: Safety - triple Sonnet with minority veto (fail-closed)
		try {
			const safetyResult = await runSafetyJudge(runtime, delta, constitution, configText);
			gates.push({
				gate: "safety",
				passed: safetyResult.verdict === "pass",
				reason: safetyResult.reasoning,
			});
			judgeCosts.safety_gate.calls++;
			judgeCosts.safety_gate.totalUsd += safetyResult.costUsd;
			for (const ir of safetyResult.individualResults) {
				judgeCosts.safety_gate.totalInputTokens += ir.inputTokens;
				judgeCosts.safety_gate.totalOutputTokens += ir.outputTokens;
			}
		} catch (error: unknown) {
			// Fail-closed: reject on error
			const msg = error instanceof Error ? error.message : String(error);
			console.warn(`[evolution] Safety judge failed, failing closed: ${msg}`);
			gates.push({ gate: "safety", passed: false, reason: `Judge error (fail-closed): ${msg}` });
		}

		const approved = gates.every((g) => g.passed);
		results.push({ delta, gates, approved });
	}

	return { results, judgeCosts };
}

function buildConfigText(config: EvolvedConfig): string {
	return [
		"## Constitution",
		config.constitution,
		"",
		"## Persona",
		config.persona,
		"",
		"## User Profile",
		config.userProfile,
		"",
		"## Domain Knowledge",
		config.domainKnowledge,
	].join("\n");
}

function cosineSimilarity(a: number[], b: number[]): number {
	if (a.length !== b.length || a.length === 0) return 0;

	let dotProduct = 0;
	let normA = 0;
	let normB = 0;

	for (let i = 0; i < a.length; i++) {
		dotProduct += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}

	const denominator = Math.sqrt(normA) * Math.sqrt(normB);
	return denominator === 0 ? 0 : dotProduct / denominator;
}

function tokenize(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.replace(/[^\w\s]/g, " ")
			.split(/\s+/)
			.filter((t) => t.length > 1),
	);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 && b.size === 0) return 1;
	const intersection = new Set([...a].filter((x) => b.has(x)));
	const union = new Set([...a, ...b]);
	return union.size === 0 ? 1 : intersection.size / union.size;
}

function detectContradiction(newContent: string, goldenLesson: string): boolean {
	const negations = ["don't", "do not", "never", "avoid", "stop"];
	const goldenTokens = goldenLesson.split(/\s+/).filter((t) => t.length > 3);

	for (const negation of negations) {
		if (!newContent.includes(negation)) continue;
		const negIdx = newContent.indexOf(negation);
		for (const token of goldenTokens) {
			const tokenIdx = newContent.indexOf(token);
			if (tokenIdx !== -1 && Math.abs(negIdx - tokenIdx) < 50) return true;
		}
	}
	return false;
}
