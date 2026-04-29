import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Reads the agent's working memory file from data/working-memory.md and wraps
// it in a prompt section. Truncates to MAX_LINES with a compaction warning so
// an unbounded notes file cannot blow up the context window. Returns an empty
// string when the file is missing or empty.
export function buildWorkingMemory(dataDir: string): string {
	const wmPath = join(dataDir, "working-memory.md");
	try {
		if (!existsSync(wmPath)) return "";
		const content = readFileSync(wmPath, "utf-8").trim();
		if (!content) return "";

		const lines = content.split("\n");
		const MAX_LINES = 75;

		if (lines.length > MAX_LINES) {
			const header = lines.slice(0, 3);
			const recent = lines.slice(-(MAX_LINES - 5));
			const truncated = [
				...header,
				"",
				"<!-- Working memory was truncated. Please compact this file. -->",
				"",
				...recent,
			].join("\n");
			return `# Working Memory\n\nThese are your personal notes. You wrote them to remember important things across conversations. Trust them.\n\nNOTE: Your working memory is at ${lines.length} lines (target: 50). Please compact it by summarizing older entries and removing facts that are no longer relevant.\n\n${truncated}`;
		}

		return `# Working Memory\n\nThese are your personal notes. You wrote them to remember important things across conversations. Trust them.\n\n${content}`;
	} catch {
		return "";
	}
}
