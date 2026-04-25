import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Known append-only memory files in phantom-config/memory/ that the agent
// writes during evolution and that we need to truncate to avoid SDK auto-
// include size budget truncation. Each file is processed independently and
// returned as a subsection.
//
// NOTE: agent-notes.md is explicitly excluded. The agent reads its own
// writes with the Read tool when needed, avoiding a feedback loop that
// would re-present the agent's past entries as canonical context on every
// query (see prompt-assembler.ts section 6b comment).
const KNOWN_MEMORY_FILES = ["corrections.md", "principles.md", "heartbeat-log.md", "presence-log.md"];

// Reads memory files from phantom-config/memory/ and truncates each to
// MAX_LINES with a compaction warning so unbounded append-only logs cannot
// blow up the context window. Returns an empty string when no files exist.
export function buildConfigMemory(configMemoryDir: string): string {
	const sections: string[] = [];
	const MAX_LINES = 100;

	for (const fileName of KNOWN_MEMORY_FILES) {
		const filePath = join(configMemoryDir, fileName);
		try {
			if (!existsSync(filePath)) continue;
			const content = readFileSync(filePath, "utf-8").trim();
			if (!content) continue;

			const lines = content.split("\n");
			let processedContent: string;

			if (lines.length > MAX_LINES) {
				const header = lines.slice(0, 3);
				const recent = lines.slice(-(MAX_LINES - 5));
				const truncated = [
					...header,
					"",
					`<!-- ${fileName} was truncated. Please compact this file. -->`,
					"",
					...recent,
				].join("\n");
				processedContent = truncated;
			} else {
				processedContent = content;
			}

			sections.push(`## ${fileName}\n\n${processedContent}`);
		} catch {
			// Skip files that cannot be read
		}
	}

	if (sections.length === 0) return "";

	return `# Config Memory Files\n\nThese files contain your learnings and observations from past sessions. They live in phantom-config/memory/ and grow over time.\n\n${sections.join("\n\n")}`;
}
