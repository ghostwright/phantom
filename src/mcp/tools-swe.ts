import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolDependencies } from "./tools-universal.ts";

export function registerSweTools(server: McpServer, deps: ToolDependencies): void {
	registerCodebaseQuery(server, deps);
	registerPrStatus(server, deps);
	registerCiStatus(server, deps);
	registerReviewRequest(server, deps);
	registerDeployStatus(server, deps);
	registerRepoInfo(server, deps);
}

function registerCodebaseQuery(server: McpServer, deps: ToolDependencies): void {
	server.registerTool(
		"phantom_codebase_query",
		{
			description:
				"Ask questions about the codebase using the Phantom's accumulated domain knowledge and memory. " +
				"Returns relevant facts, patterns, and past experiences related to the query.",
			inputSchema: z.object({
				query: z.string().min(1).describe("Question about the codebase"),
				scope: z
					.enum(["all", "architecture", "conventions", "dependencies", "patterns"])
					.optional()
					.default("all")
					.describe("Narrow the search to a specific knowledge area"),
			}),
		},
		async ({ query, scope }): Promise<CallToolResult> => {
			const results: Record<string, unknown> = { query, scope };

			// Search domain knowledge from evolution engine
			if (deps.evolution) {
				const config = deps.evolution.getConfig();
				const domainKnowledge = config.domainKnowledge;
				const strategies = config.strategies;

				if (domainKnowledge.trim()) {
					results.domain_knowledge = domainKnowledge;
				}
				if (scope === "all" || scope === "patterns") {
					results.task_patterns = strategies.taskPatterns;
					results.tool_preferences = strategies.toolPreferences;
				}
			}

			// Search episodic and semantic memory
			if (deps.memory?.isReady()) {
				try {
					const episodes = await deps.memory.recallEpisodes(query, { limit: 5 });
					if (episodes.length > 0) {
						results.relevant_episodes = episodes.map((e) => ({
							summary: e.summary,
							timestamp: e.started_at,
						}));
					}
				} catch (err: unknown) {
					const msg = err instanceof Error ? err.message : String(err);
					console.warn(`[mcp] codebase_query recallEpisodes failed: ${msg}`);
				}

				try {
					const facts = await deps.memory.recallFacts(query, { limit: 10 });
					if (facts.length > 0) {
						results.relevant_facts = facts.map((f) => ({
							fact: f.natural_language,
							confidence: f.confidence,
						}));
					}
				} catch (err: unknown) {
					const msg = err instanceof Error ? err.message : String(err);
					console.warn(`[mcp] codebase_query recallFacts failed: ${msg}`);
				}
			}

			const hasResults = Object.keys(results).length > 2; // More than just query + scope

			if (!hasResults) {
				results.note =
					"No domain knowledge accumulated yet. The Phantom learns about the codebase " +
					"through conversations and self-evolution. Ask me questions or give me tasks " +
					"to start building knowledge.";
			}

			return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
		},
	);
}

function registerPrStatus(server: McpServer, _deps: ToolDependencies): void {
	server.registerTool(
		"phantom_pr_status",
		{
			description:
				"Check pull request status across configured repositories. " + "Shows open PRs, review status, and CI checks.",
			inputSchema: z.object({
				repo: z.string().optional().describe("Filter by repository name or URL"),
				state: z.enum(["open", "closed", "merged", "all"]).optional().default("open").describe("PR state to filter by"),
				limit: z.number().int().min(1).max(50).optional().default(10),
			}),
		},
		async ({ repo, state, limit }): Promise<CallToolResult> => {
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								status: "not_connected",
								message:
									"GitHub/GitLab integration not yet configured. " +
									"PR status tracking will be available once repository access is set up during onboarding.",
								requested: { repo, state, limit },
							},
							null,
							2,
						),
					},
				],
			};
		},
	);
}

function registerCiStatus(server: McpServer, _deps: ToolDependencies): void {
	server.registerTool(
		"phantom_ci_status",
		{
			description:
				"Check CI/CD pipeline status for recent runs. " + "Shows build results, test outcomes, and deployment status.",
			inputSchema: z.object({
				repo: z.string().optional().describe("Filter by repository"),
				branch: z.string().optional().default("main").describe("Branch to check"),
				limit: z.number().int().min(1).max(20).optional().default(5),
			}),
		},
		async ({ repo, branch, limit }): Promise<CallToolResult> => {
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								status: "not_connected",
								message:
									"CI/CD integration not yet configured. " +
									"Pipeline monitoring will be available once CI access is set up during onboarding.",
								requested: { repo, branch, limit },
							},
							null,
							2,
						),
					},
				],
			};
		},
	);
}

function registerReviewRequest(server: McpServer, deps: ToolDependencies): void {
	server.registerTool(
		"phantom_review_request",
		{
			description:
				"Request the Phantom to review code or a pull request. " +
				"Provides feedback based on team conventions and accumulated knowledge.",
			inputSchema: z.object({
				target: z.string().min(1).describe("PR URL, file path, or code snippet to review"),
				focus: z
					.enum(["general", "security", "performance", "style", "tests"])
					.optional()
					.default("general")
					.describe("What aspect to focus the review on"),
			}),
		},
		async ({ target, focus }): Promise<CallToolResult> => {
			try {
				const prompt = `Please review the following with a focus on ${focus}:\n\n${target}\n\nProvide specific, actionable feedback. Reference team conventions if known.`;

				const response = await deps.runtime.handleMessage("mcp", `review-${Date.now()}`, prompt);

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									review: response.text,
									focus,
									cost: response.cost.totalUsd,
									durationMs: response.durationMs,
								},
								null,
								2,
							),
						},
					],
				};
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: JSON.stringify({ error: msg }) }],
					isError: true,
				};
			}
		},
	);
}

function registerDeployStatus(server: McpServer, _deps: ToolDependencies): void {
	server.registerTool(
		"phantom_deploy_status",
		{
			description:
				"Check deployment status across environments. " + "Shows what is deployed where and any pending deployments.",
			inputSchema: z.object({
				environment: z
					.enum(["production", "staging", "development", "all"])
					.optional()
					.default("all")
					.describe("Environment to check"),
			}),
		},
		async ({ environment }): Promise<CallToolResult> => {
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								status: "not_connected",
								message:
									"Deployment tracking not yet configured. " +
									"Deploy status will be available once deployment infrastructure access is set up.",
								requested: { environment },
							},
							null,
							2,
						),
					},
				],
			};
		},
	);
}

function registerRepoInfo(server: McpServer, deps: ToolDependencies): void {
	server.registerTool(
		"phantom_repo_info",
		{
			description:
				"Get repository information including structure, recent activity, and stats. " +
				"Uses accumulated knowledge from working with the codebase.",
			inputSchema: z.object({
				repo: z.string().optional().describe("Repository name or URL"),
				aspect: z
					.enum(["overview", "structure", "activity", "dependencies"])
					.optional()
					.default("overview")
					.describe("What information to retrieve"),
			}),
		},
		async ({ repo, aspect }): Promise<CallToolResult> => {
			const results: Record<string, unknown> = { repo, aspect };

			// Pull knowledge from domain memory
			if (deps.evolution) {
				const config = deps.evolution.getConfig();
				if (config.domainKnowledge.trim()) {
					results.accumulated_knowledge = config.domainKnowledge;
				}
			}

			if (deps.memory?.isReady()) {
				const searchQuery = repo ? `${repo} ${aspect}` : `repository ${aspect}`;
				try {
					const facts = await deps.memory.recallFacts(searchQuery, { limit: 10 });
					if (facts.length > 0) {
						results.relevant_facts = facts.map((f) => ({
							fact: f.natural_language,
						}));
					}
				} catch (err: unknown) {
					const msg = err instanceof Error ? err.message : String(err);
					console.warn(`[mcp] repo_info recallFacts failed: ${msg}`);
				}
			}

			if (Object.keys(results).length <= 2) {
				results.note =
					"Limited repository knowledge available. Work with the codebase to build up knowledge " +
					"about structure, patterns, and conventions.";
			}

			return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
		},
	);
}
