import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Known append-only memory files in phantom-config/memory/ that the agent
// writes during evolution and that we need to truncate to avoid SDK auto-
// include size budget truncation. Each file is processed independently and
// returned as a subsection.
//
// NOTE: agent-notes.md is explicitly excluded. The agent reads its own
// writes with the Read tool when needed, avoiding a feedback loop that
// would re-present the agent's past entries as canonical context on every
// query (see prompt-assembler.ts section 6b comment). Including it would
// cause the agent's exploratory notes to be treated as ground truth on
// subsequent sessions, even when those notes are speculative or outdated.
// The trade-off is that the agent must explicitly Read the file when it
// wants its own notes — acceptable given the feedback-loop risk.
const KNOWN_MEMORY_FILES = ["corrections.md", "principles.md", "heartbeat-log.md", "presence-log.md", "contribution-queue.md"];

// Resolves the most recent story file from memory/story/ by mtime.
// Returns the filename relative to configMemoryDir (e.g. "story/2026-05-03.md")
// or undefined when the directory doesn't exist or is empty.
function latestStoryFile(configMemoryDir: string): string | undefined {
	const storyDir = join(configMemoryDir, "story");
	try {
		if (!existsSync(storyDir)) return undefined;
		const entries = readdirSync(storyDir)
			.filter((f) => f.endsWith(".md"))
			.sort();
		if (entries.length === 0) return undefined;
		// Last alphabetically == most recent YYYY-MM-DD filename
		return join("story", entries[entries.length - 1]);
	} catch {
		return undefined;
	}
}

// Reads memory files from phantom-config/memory/ and truncates each to
// MAX_LINES with a compaction warning so unbounded append-only logs cannot
// blow up the context window. Returns an empty string when no files exist.
export function buildConfigMemory(configMemoryDir: string): string {
	const sections: string[] = [];
	const MAX_LINES = 100;

	// Build the full file list: static known files + dynamic story file
	const filesToProcess = [...KNOWN_MEMORY_FILES];
	const story = latestStoryFile(configMemoryDir);
	if (story) filesToProcess.push(story);

	for (const fileName of filesToProcess) {
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
