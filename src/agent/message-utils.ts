import type { AgentCost } from "./events.ts";

// Shared Agent SDK message parsing used by both the main query and the judge query.
// These helpers were previously private to runtime.ts. Lifting them out keeps
// runtime.ts below the 300-line ceiling and lets judgeQuery() reuse them without
// duplication.

export function extractTextFromMessage(message: {
	content: ReadonlyArray<{ type: string; text?: string }>;
}): string {
	return message.content
		.filter((block) => block.type === "text" && block.text)
		.map((block) => block.text ?? "")
		.join("\n");
}

export function extractCost(message: {
	total_cost_usd: number;
	usage: Record<string, number>;
	modelUsage: Record<
		string,
		{
			inputTokens: number;
			outputTokens: number;
			cacheReadInputTokens?: number;
			cacheCreationInputTokens?: number;
			costUSD: number;
		}
	>;
}): AgentCost {
	const modelUsage: AgentCost["modelUsage"] = {};

	for (const [model, usage] of Object.entries(message.modelUsage)) {
		const totalModelInput =
			usage.inputTokens + (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0);
		modelUsage[model] = {
			inputTokens: totalModelInput,
			outputTokens: usage.outputTokens,
			costUsd: usage.costUSD,
		};
	}

	let totalInput = 0;
	let totalOutput = 0;
	for (const usage of Object.values(modelUsage)) {
		totalInput += usage.inputTokens;
		totalOutput += usage.outputTokens;
	}

	return {
		totalUsd: message.total_cost_usd,
		inputTokens: totalInput,
		outputTokens: totalOutput,
		modelUsage,
	};
}
