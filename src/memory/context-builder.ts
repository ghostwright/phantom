import type { MemoryConfig } from "../config/types.ts";
import { shouldIncludeEpisodeInContext } from "./ranking.ts";
import type { MemorySystem } from "./system.ts";
import type { Episode, Procedure, SemanticFact } from "./types.ts";

// Rough estimate: 1 token is about 4 characters
const CHARS_PER_TOKEN = 4;

export class MemoryContextBuilder {
	private memory: MemorySystem;
	private maxTokens: number;
	private episodeLimit: number;
	private factLimit: number;

	constructor(memory: MemorySystem, config: MemoryConfig) {
		this.memory = memory;
		this.maxTokens = config.context.max_tokens;
		this.episodeLimit = config.context.episode_limit;
		this.factLimit = config.context.fact_limit;
	}

	async build(query: string): Promise<string> {
		if (!this.memory.isReady()) {
			return "";
		}

		const [episodes, facts, procedure] = await Promise.all([
			this.memory.recallEpisodes(query, { limit: this.episodeLimit }).catch(() => []),
			this.memory.recallFacts(query, { limit: this.factLimit }).catch(() => []),
			this.memory.findProcedure(query).catch(() => null),
		]);

		const sections: string[] = [];
		let tokenBudget = this.maxTokens;

		// Known facts get priority - they're the agent's accumulated knowledge
		if (facts.length > 0) {
			const factSection = this.formatFacts(facts);
			const factTokens = this.estimateTokens(factSection);
			if (factTokens <= tokenBudget) {
				sections.push(factSection);
				tokenBudget -= factTokens;
			}
		}

		// Recent memories provide episode context
		if (episodes.length > 0 && tokenBudget > 500) {
			const durableEpisodes = episodes.filter(shouldIncludeEpisodeInContext);
			const episodeSection = this.formatEpisodes(durableEpisodes, tokenBudget);
			const episodeTokens = this.estimateTokens(episodeSection);
			if (episodeSection) {
				sections.push(episodeSection);
				tokenBudget -= episodeTokens;
			}
		}

		// Relevant procedures
		if (procedure && tokenBudget > 200) {
			const procSection = this.formatProcedure(procedure);
			const procTokens = this.estimateTokens(procSection);
			if (procTokens <= tokenBudget) {
				sections.push(procSection);
			}
		}

		if (sections.length === 0) return "";

		return sections.join("\n\n");
	}

	private formatFacts(facts: SemanticFact[]): string {
		const lines = facts.map((f) => {
			const metadata = [`confidence: ${f.confidence.toFixed(1)}`];
			const repetitionCount = (f.reinforcement_count ?? 0) + 1;
			if (repetitionCount > 1) metadata.push(`repeated: ${repetitionCount}x`);
			const contradictionNote = f.contradiction_note ? ` Recent contradictions: ${f.contradiction_note}` : "";
			return `- ${f.natural_language} [${metadata.join(", ")}]${contradictionNote}`;
		});
		return `## Known Facts\n${lines.join("\n")}`;
	}

	private formatEpisodes(episodes: Episode[], tokenBudget: number): string {
		if (episodes.length === 0) return "";

		const header = "## Recent Memories\n";
		let content = header;
		const maxChars = tokenBudget * CHARS_PER_TOKEN;

		for (const ep of episodes) {
			const entry = `- [${ep.type}] ${ep.summary} (${ep.outcome}, ${formatRelativeTime(ep.started_at)})\n`;

			if (content.length + entry.length > maxChars) break;
			content += entry;
		}

		return content.trim();
	}

	private formatProcedure(procedure: Procedure): string {
		const steps = procedure.steps.map((s) => `  ${s.order}. ${s.action}`).join("\n");

		return (
			`## Relevant Procedure: ${procedure.name}\n` +
			`Trigger: ${procedure.trigger}\n` +
			`Confidence: ${procedure.confidence.toFixed(1)} ` +
			`(${procedure.success_count} successes, ${procedure.failure_count} failures)\n` +
			`Steps:\n${steps}`
		);
	}

	private estimateTokens(text: string): number {
		return Math.ceil(text.length / CHARS_PER_TOKEN);
	}
}

function formatRelativeTime(isoDate: string): string {
	if (!isoDate) return "unknown";

	const diff = Date.now() - new Date(isoDate).getTime();
	const hours = Math.floor(diff / (1000 * 60 * 60));

	if (hours < 1) return "just now";
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days === 1) return "yesterday";
	if (days < 7) return `${days}d ago`;
	const weeks = Math.floor(days / 7);
	return `${weeks}w ago`;
}
