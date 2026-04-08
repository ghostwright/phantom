import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EvolutionConfig } from "./config.ts";
import type { ConfigDelta, EvolutionLogEntry, MetricsSnapshot, ValidationResult, VersionChange } from "./types.ts";
import { createNextVersion, readVersion, writeVersion } from "./versioning.ts";

/**
 * Apply a validated delta to the config file.
 * Returns the change record for version tracking, or null if the delta was a no-op (content already present).
 */
export function applyDelta(delta: ConfigDelta, config: EvolutionConfig): VersionChange | null {
	const filePath = join(config.paths.config_dir, delta.file);

	// Ensure directory exists
	const dir = dirname(filePath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	let currentContent = "";
	try {
		currentContent = readFileSync(filePath, "utf-8");
	} catch {
		// File doesn't exist yet
	}

	let newContent: string;

	switch (delta.type) {
		case "append": {
			const existingLines = new Set(
				currentContent
					.split("\n")
					.map((l) => l.trim().toLowerCase())
					.filter(Boolean),
			);
			const uniqueLines = delta.content
				.split("\n")
				.filter((l) => {
					const trimmed = l.trim();
					return !trimmed || !existingLines.has(trimmed.toLowerCase());
				})
				.join("\n")
				.trim();
			if (!uniqueLines) {
				newContent = currentContent;
			} else {
				newContent = currentContent ? `${currentContent}\n${uniqueLines}` : uniqueLines;
			}
			break;
		}
		case "replace":
			if (delta.target && currentContent.includes(delta.target)) {
				newContent = currentContent.replace(delta.target, delta.content);
			} else {
				// Target not found, append instead
				newContent = currentContent ? `${currentContent}\n${delta.content}` : delta.content;
			}
			break;
		case "remove":
			if (delta.target) {
				newContent = currentContent.replace(delta.target, "").trim();
			} else {
				newContent = currentContent;
			}
			break;
		default:
			newContent = currentContent;
	}

	if (newContent === currentContent) {
		return null;
	}

	writeFileSync(filePath, newContent, "utf-8");

	return {
		file: delta.file,
		type: delta.type,
		content: delta.content,
		rationale: delta.rationale,
		session_ids: delta.session_ids,
	};
}

/**
 * Apply all approved deltas, update version.json, and append to evolution-log.jsonl.
 * This is atomic: either all approved changes apply, or the version is not bumped.
 */
export function applyApproved(
	results: ValidationResult[],
	config: EvolutionConfig,
	sessionId: string,
	metricsSnapshot: MetricsSnapshot,
): { applied: VersionChange[]; rejected: Array<{ change: ConfigDelta; reasons: string[] }> } {
	const approved = results.filter((r) => r.approved);
	const rejected = results.filter((r) => !r.approved);

	if (approved.length === 0) {
		return {
			applied: [],
			rejected: rejected.map((r) => ({
				change: r.delta,
				reasons: r.gates.filter((g) => !g.passed).map((g) => `${g.gate}: ${g.reason}`),
			})),
		};
	}

	// Apply all approved deltas (skip no-ops where content already exists)
	const appliedChanges: VersionChange[] = [];
	for (const result of approved) {
		const change = applyDelta(result.delta, config);
		if (change) {
			appliedChanges.push(change);
		}
	}

	// All approved deltas were no-ops (content already existed)
	if (appliedChanges.length === 0) {
		return {
			applied: [],
			rejected: rejected.map((r) => ({
				change: r.delta,
				reasons: r.gates.filter((g) => !g.passed).map((g) => `${g.gate}: ${g.reason}`),
			})),
		};
	}

	// Update version
	const currentVersion = readVersion(config);
	const newVersion = createNextVersion(currentVersion, appliedChanges, metricsSnapshot);
	writeVersion(config, newVersion);

	// Append to evolution log
	const logEntry: EvolutionLogEntry = {
		timestamp: new Date().toISOString(),
		version: newVersion.version,
		session_id: sessionId,
		changes_applied: appliedChanges.length,
		changes_rejected: rejected.length,
		details: appliedChanges,
	};
	appendToLog(config.paths.evolution_log, logEntry);

	return {
		applied: appliedChanges,
		rejected: rejected.map((r) => ({
			change: r.delta,
			reasons: r.gates.filter((g) => !g.passed).map((g) => `${g.gate}: ${g.reason}`),
		})),
	};
}

function appendToLog(logPath: string, entry: EvolutionLogEntry): void {
	try {
		const dir = dirname(logPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf-8");
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[evolution] Failed to write evolution log: ${msg}`);
	}
}
