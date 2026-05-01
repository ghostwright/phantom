import type { OwnerResearchResult } from "../agent/research/types.ts";
import type { RoleTemplate } from "../roles/types.ts";
import type { OwnerProfile } from "./profiler.ts";

function buildOwnerContext(profile: OwnerProfile): string {
	const lines: string[] = [];
	lines.push("## Owner Context");
	lines.push("");
	lines.push(`You are being set up for ${profile.name}${profile.title ? `, ${profile.title}` : ""}.`);

	if (profile.teamName) {
		lines.push(`The workspace is called "${profile.teamName}".`);
	}
	if (profile.isOwner) {
		lines.push("They are the workspace owner (founder or primary admin).");
	} else if (profile.isAdmin) {
		lines.push("They are a workspace admin.");
	}
	if (profile.timezone) {
		lines.push(`They are in ${profile.timezone}.`);
	}
	if (profile.status) {
		lines.push(`Their current status: "${profile.status}"`);
	}
	if (profile.channels.length > 0) {
		lines.push(`They are active in these channels: ${profile.channels.join(", ")}`);
	}

	lines.push("");
	lines.push("Use this context naturally. Do not list all this information back to them.");
	lines.push("Let it inform how you engage with their work.");

	return lines.join("\n");
}

/**
 * Phase 12: Build the public-research section for the system prompt.
 * The agent reads what we learned about the owner from public sources
 * BEFORE the first conversation. We mark the source kind on each line
 * so the agent can talk about it honestly ("I noticed on your GitHub
 * that...") instead of presenting public bullets as deep knowledge.
 * Returns the empty string when research is null or yielded no
 * bullets, so the assembler skips the section instead of emitting an
 * empty stub.
 */
export function buildResearchContext(research: OwnerResearchResult | null | undefined): string {
	if (!research || !research.bullets || research.bullets.length === 0) return "";

	const lines: string[] = [];
	lines.push("## What I Learned About Them (Public Sources)");
	lines.push("");
	lines.push(
		"The following bullets come from public sources only (GitHub, personal site, LinkedIn public profile). Reference them naturally if it helps; never present them as deep knowledge of the user. Verify with the user when you act on any of this.",
	);
	lines.push("");
	for (let i = 0; i < research.bullets.length; i++) {
		const bullet = research.bullets[i];
		const source = research.sources[i];
		const tag = source ? ` [${source.kind}]` : "";
		lines.push(`- ${bullet}${tag}`);
	}
	return lines.join("\n");
}

/**
 * Build the system prompt section injected when the agent is onboarding.
 * Role-agnostic: the agent follows the user's lead instead of running
 * through a predefined checklist. Cardinal Rule applies here too.
 */
export function buildOnboardingPrompt(
	_role: RoleTemplate,
	phantomName: string,
	ownerProfile?: OwnerProfile,
	research?: OwnerResearchResult | null,
): string {
	const ownerSection = ownerProfile ? `\n\n${buildOwnerContext(ownerProfile)}` : "";
	const researchBlock = buildResearchContext(research);
	const researchSection = researchBlock ? `\n\n${researchBlock}` : "";
	const ownerName = ownerProfile?.name ?? "your user";

	return `## Onboarding Mode

This is your first real conversation with ${ownerName}. You are ${phantomName}.${ownerSection}${researchSection}

Your goal: understand their work well enough to be immediately useful.
Not "onboard them through a checklist." Understand their work.

Have a natural conversation. Listen to what they tell you. Ask follow-up
questions based on what they say, not from a predefined list.

When they mention tools, repos, or services:
- Clone repos yourself (git clone into ~/repos/)
- Read the code, configs, READMEs. Figure out the stack.
- If they work with code, explore the repo and understand the architecture.
- If they work with data, ask about data sources and formats.
- If they work with customers, ask about their CRM and workflow.
- If they work with content, ask about their publishing process.
- If they manage people, ask about their team and priorities.

You have full computer access: Bash, Read, Write, Edit, Glob, Grep, WebSearch.
Use them. Do not ask the user things you can figure out on your own.

When you have enough context to start being useful:
- Summarize what you learned (brief, specific, no padding)
- Offer to do something concrete based on what they told you
- Do not ask "What should I work on?" Suggest something based on what you learned.

Write what you learn to your config files:
- phantom-config/user-profile.md (who they are, what they do)
- phantom-config/domain-knowledge.md (their stack, tools, context)

Be warm. Be specific. Prove that you were listening by referencing
what they told you, not by listing what you can do.`;
}
