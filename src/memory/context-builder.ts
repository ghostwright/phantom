import type { MemoryConfig } from "../config/types.ts";
import { shouldIncludeEpisodeInContext } from "./ranking.ts";
import type { MemorySystem } from "./system.ts";
import type { Episode, Procedure, SemanticFact } from "./types.ts";

// Rough estimate: 1 token is about 4 characters
const CHARS_PER_TOKEN = 4;
const DURABLE_FACT_CONFIDENCE = 0.8;
const MIN_EPISODE_BUDGET = 500;
const MIN_PROCEDURE_BUDGET = 200;

export type MemoryContextBuildOptions = {
	isNewSession?: boolean;
};

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

	async build(query: string, options: MemoryContextBuildOptions = {}): Promise<string> {
		if (!this.memory.isReady()) {
			return "";
		}

		const [episodes, facts, procedure, durableEpisodes] = await Promise.all([
			this.memory.recallEpisodes(query, { limit: this.episodeLimit }).catch(() => []),
			this.memory.recallFacts(query, { limit: this.factLimit }).catch(() => []),
			this.memory.findProcedure(query).catch(() => null),
			options.isNewSession
				? this.memory
						.recallEpisodes(query, { limit: this.getDurableEpisodeLimit(), strategy: "metadata" })
						.catch(() => [])
				: Promise.resolve([]),
		]);

		const durableFacts = options.isNewSession ? this.selectDurableFacts(facts) : [];
		const durableFactIds = new Set(durableFacts.map((fact) => fact.id));
		const durableEpisodeIds = new Set(durableEpisodes.map((episode) => episode.id));
		const remainingFacts = facts.filter((fact) => !durableFactIds.has(fact.id));
		const remainingEpisodes = episodes.filter((episode) => !durableEpisodeIds.has(episode.id));

		const sections: string[] = [];
		let tokenBudget = this.maxTokens;

		if (options.isNewSession) {
			const durableSection = this.formatDurableContext(durableFacts, durableEpisodes, tokenBudget);
			const durableTokens = this.estimateTokens(durableSection);
			if (durableTokens > 0 && durableTokens <= tokenBudget) {
				sections.push(durableSection);
				tokenBudget -= durableTokens;
			}
		}

		// Known facts get priority - they're the agent's accumulated knowledge
		if (remainingFacts.length > 0) {
			const factSection = this.formatFacts(remainingFacts);
			const factTokens = this.estimateTokens(factSection);
			if (factTokens <= tokenBudget) {
				sections.push(factSection);
				tokenBudget -= factTokens;
			}
		}

		// Recent memories provide episode context
		if (remainingEpisodes.length > 0 && tokenBudget > MIN_EPISODE_BUDGET) {
			const filteredEpisodes = remainingEpisodes.filter(shouldIncludeEpisodeInContext);
			const episodeSection = this.formatEpisodes(filteredEpisodes, tokenBudget);
			const episodeTokens = this.estimateTokens(episodeSection);
			if (episodeSection) {
				sections.push(episodeSection);
				tokenBudget -= episodeTokens;
			}
		}

		// Relevant procedures
		if (procedure && tokenBudget > MIN_PROCEDURE_BUDGET) {
			const procSection = this.formatProcedure(procedure);
			const procTokens = this.estimateTokens(procSection);
			if (procTokens <= tokenBudget) {
				sections.push(procSection);
			}
		}

		if (sections.length === 0) return "";

		return sections.join("\n\n");
	}

	private formatDurableContext(facts: SemanticFact[], episodes: Episode[], tokenBudget: number): string {
		const header = "## Durable Context\n";
		let content = header;
		const maxChars = tokenBudget * CHARS_PER_TOKEN;

		for (const fact of facts) {
			const entry = `- Fact: ${fact.natural_language} [confidence: ${fact.confidence.toFixed(1)}]\n`;
			if (content.length + entry.length > maxChars) break;
			content += entry;
		}

		for (const episode of episodes) {
			const entry = `- Memory: [${episode.type}] ${episode.summary} (${episode.outcome}, ${formatRelativeTime(episode.started_at)})\n`;
			if (content.length + entry.length > maxChars) break;
			content += entry;
		}

		return content.trim() === "## Durable Context" ? "" : content.trim();
	}

	private formatFacts(facts: SemanticFact[]): string {
		const lines = facts.map((f) => `- ${f.natural_language} [confidence: ${f.confidence.toFixed(1)}]`);
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

	private selectDurableFacts(facts: SemanticFact[]): SemanticFact[] {
		return facts
			.filter((fact) => fact.valid_until == null && fact.confidence >= DURABLE_FACT_CONFIDENCE)
			.sort((a, b) => {
				if (b.confidence !== a.confidence) {
					return b.confidence - a.confidence;
				}

				return new Date(b.valid_from).getTime() - new Date(a.valid_from).getTime();
			})
			.slice(0, this.getDurableFactLimit());
	}

	private getDurableFactLimit(): number {
		return Math.max(2, Math.min(5, Math.ceil(this.factLimit / 4)));
	}

	private getDurableEpisodeLimit(): number {
		return Math.max(1, Math.min(3, Math.ceil(this.episodeLimit / 3)));
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
