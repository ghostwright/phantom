import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EvolutionConfig } from "./config.ts";
import type { SessionObservation } from "./types.ts";

type SessionLogEntry = {
	session_id: string;
	timestamp: string;
	observations: SessionObservation[];
};

/**
 * Step 6: Periodic consolidation.
 * Groups related observations, extracts principles, compresses oversized files.
 * Runs every N sessions (configurable via cadence.consolidation_interval).
 */
export function runConsolidation(config: EvolutionConfig): ConsolidationReport {
	const sessionLog = loadSessionLog(config);

	if (sessionLog.length === 0) {
		return { principlesExtracted: 0, observationsPruned: 0, filesCompressed: 0 };
	}

	// Group observations by type
	const allObservations = sessionLog.flatMap((entry) => entry.observations);
	const grouped = groupByType(allObservations);

	// Extract principles from correction and preference patterns
	const principles = extractPrinciples(grouped);
	if (principles.length > 0) {
		appendPrinciples(config, principles);
	}

	// Compress corrections.md if it has duplicates
	const correctionsCompressed = compressCorrections(config);

	// Compress user-profile.md if it has duplicates
	const profileCompressed = compressUserProfile(config);

	// Prune the session log of entries that have been processed
	const prunedCount = pruneSessionLog(config, sessionLog.length);

	// Compress any config files over the size limit
	const filesCompressed = compressOversizedFiles(config);

	return {
		principlesExtracted: principles.length,
		observationsPruned: prunedCount,
		filesCompressed: filesCompressed + (correctionsCompressed ? 1 : 0) + (profileCompressed ? 1 : 0),
	};
}

export type ConsolidationReport = {
	principlesExtracted: number;
	observationsPruned: number;
	filesCompressed: number;
};

/**
 * Record session observations to the session log for later consolidation.
 */
export function recordObservations(
	config: EvolutionConfig,
	sessionId: string,
	observations: SessionObservation[],
): void {
	if (observations.length === 0) return;

	const entry: SessionLogEntry = {
		session_id: sessionId,
		timestamp: new Date().toISOString(),
		observations,
	};

	const logPath = config.paths.session_log;
	try {
		const existing = readFileSync(logPath, "utf-8");
		writeFileSync(logPath, `${existing + JSON.stringify(entry)}\n`, "utf-8");
	} catch {
		writeFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf-8");
	}
}

function loadSessionLog(config: EvolutionConfig): SessionLogEntry[] {
	const logPath = config.paths.session_log;
	const entries: SessionLogEntry[] = [];

	try {
		const text = readFileSync(logPath, "utf-8").trim();
		if (!text) return [];

		for (const line of text.split("\n").filter(Boolean)) {
			try {
				entries.push(JSON.parse(line) as SessionLogEntry);
			} catch {
				// Skip malformed lines
			}
		}
	} catch {
		return [];
	}

	return entries;
}

function groupByType(observations: SessionObservation[]): Map<string, SessionObservation[]> {
	const groups = new Map<string, SessionObservation[]>();
	for (const obs of observations) {
		const existing = groups.get(obs.type) ?? [];
		existing.push(obs);
		groups.set(obs.type, existing);
	}
	return groups;
}

function extractPrinciples(grouped: Map<string, SessionObservation[]>): string[] {
	const principles: string[] = [];

	// Look for repeated corrections (same topic corrected multiple times)
	const corrections = grouped.get("correction") ?? [];
	if (corrections.length >= 2) {
		// Group corrections by similar content
		const correctionClusters = clusterBySimilarity(corrections.map((c) => c.content));
		for (const cluster of correctionClusters) {
			if (cluster.length >= 2) {
				principles.push(`User has corrected this ${cluster.length} times: ${cluster[0].slice(0, 100)}`);
			}
		}
	}

	// Look for preference patterns
	const preferences = grouped.get("preference") ?? [];
	if (preferences.length >= 2) {
		const prefClusters = clusterBySimilarity(preferences.map((p) => p.content));
		for (const cluster of prefClusters) {
			if (cluster.length >= 2) {
				principles.push(`Consistent preference (${cluster.length}x): ${cluster[0].slice(0, 100)}`);
			}
		}
	}

	return principles;
}

function clusterBySimilarity(items: string[]): string[][] {
	// Simple word-overlap clustering
	const clusters: string[][] = [];

	for (const item of items) {
		const itemTokens = new Set(
			item
				.toLowerCase()
				.split(/\s+/)
				.filter((t) => t.length > 3),
		);
		let added = false;

		for (const cluster of clusters) {
			const clusterTokens = new Set(
				cluster[0]
					.toLowerCase()
					.split(/\s+/)
					.filter((t) => t.length > 3),
			);
			const intersection = [...itemTokens].filter((t) => clusterTokens.has(t));
			const overlapRatio = intersection.length / Math.max(itemTokens.size, 1);

			if (overlapRatio > 0.3) {
				cluster.push(item);
				added = true;
				break;
			}
		}

		if (!added) {
			clusters.push([item]);
		}
	}

	return clusters;
}

function appendPrinciples(config: EvolutionConfig, principles: string[]): void {
	const principlesPath = join(config.paths.config_dir, "memory/principles.md");

	let current = "";
	try {
		current = readFileSync(principlesPath, "utf-8");
	} catch {
		current = "# Principles\n\nDistilled strategic principles from session observations.\n";
	}

	const newContent = `${current}\n${principles.map((p) => `- ${p}`).join("\n")}\n`;
	writeFileSync(principlesPath, newContent, "utf-8");
}

function compressCorrections(config: EvolutionConfig): boolean {
	const correctionsPath = join(config.paths.config_dir, "memory/corrections.md");

	let content: string;
	try {
		content = readFileSync(correctionsPath, "utf-8");
	} catch {
		return false;
	}

	const lines = content.split("\n");
	if (lines.length <= config.gates.max_file_lines) return false;

	// Deduplicate lines
	const seen = new Set<string>();
	const deduplicated = lines.filter((line) => {
		const trimmed = line.trim().toLowerCase();
		if (trimmed === "" || trimmed.startsWith("#")) return true;
		if (seen.has(trimmed)) return false;
		seen.add(trimmed);
		return true;
	});

	writeFileSync(correctionsPath, deduplicated.join("\n"), "utf-8");
	return deduplicated.length < lines.length;
}

export function compressUserProfile(config: EvolutionConfig): boolean {
	const profilePath = join(config.paths.config_dir, "user-profile.md");

	let content: string;
	try {
		content = readFileSync(profilePath, "utf-8");
	} catch {
		return false;
	}

	const lines = content.split("\n");
	if (lines.length <= config.gates.max_file_lines) return false;

	const seen = new Set<string>();
	const deduplicated = lines.filter((line) => {
		const trimmed = line.trim().toLowerCase();
		if (trimmed === "" || trimmed.startsWith("#")) return true;
		if (seen.has(trimmed)) return false;
		seen.add(trimmed);
		return true;
	});

	if (deduplicated.length < lines.length) {
		writeFileSync(profilePath, deduplicated.join("\n"), "utf-8");
		return true;
	}
	return false;
}

function pruneSessionLog(config: EvolutionConfig, processedCount: number): number {
	const logPath = config.paths.session_log;

	try {
		const text = readFileSync(logPath, "utf-8").trim();
		if (!text) return 0;

		const lines = text.split("\n").filter(Boolean);
		const remaining = lines.slice(processedCount);
		writeFileSync(logPath, remaining.length > 0 ? `${remaining.join("\n")}\n` : "", "utf-8");
		return processedCount;
	} catch {
		return 0;
	}
}

function compressOversizedFiles(config: EvolutionConfig): number {
	const maxLines = config.gates.max_file_lines;
	const filesToCheck = [
		"user-profile.md",
		"domain-knowledge.md",
		"memory/corrections.md",
		"memory/principles.md",
		"strategies/task-patterns.md",
		"strategies/tool-preferences.md",
		"strategies/error-recovery.md",
	];
	let compressed = 0;

	for (const file of filesToCheck) {
		const filePath = join(config.paths.config_dir, file);
		try {
			const content = readFileSync(filePath, "utf-8");
			const lines = content.split("\n");

			if (lines.length > maxLines) {
				// Keep header and most recent entries
				const header = lines.slice(0, 3);
				const recentEntries = lines.slice(-(maxLines - 4));
				const trimmed = [...header, "", "...(older entries consolidated)...", "", ...recentEntries];
				writeFileSync(filePath, trimmed.join("\n"), "utf-8");
				compressed++;
			}
		} catch {
			// File doesn't exist, skip
		}
	}

	return compressed;
}
