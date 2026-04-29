import { z } from "zod/v4";

// Phase 1 gate judge prompt and schema. Migrated out of the deleted
// `judges/prompts.ts` and `judges/schemas.ts` during the Phase 3 cleanup so
// the gate module can import them without pulling in the broader judges
// directory. Contract is unchanged from Phase 1.

export const GateJudgeResult = z.object({
	evolve: z.boolean().describe("True if the session is worth learning from, false otherwise."),
	reason: z.string().max(400).describe("Short natural-language justification, under 40 words."),
});

export type GateJudgeResultType = z.infer<typeof GateJudgeResult>;

export function gateJudgePrompt(input: {
	channelType: string;
	turnCount: number;
	durationSeconds: number;
	totalCostUsd: number;
	toolsUsed: string;
	outcome: string;
	firstUserMessage: string;
	lastUserMessage: string;
	lastAgentMessage: string;
	userReactions: string;
	hookBlockCount: number;
	toolErrorCount: number;
}): { system: string; user: string } {
	return {
		system: `You decide whether an autonomous agent should learn from a conversation session. Phantom runs a full reflection pipeline after sessions marked worth learning from; that pipeline writes small notes to the agent's own memory files (user profile, domain knowledge, workflow patterns). Each note costs real money to produce and lives in the agent's prompt for every future session, so write-worthiness matters.

Fire the pipeline (evolve=true) when the session shows at least one of these durable signals:
- A specific user preference the agent should carry forward (tool choice, code style, communication tone, file layout, naming convention, review cadence).
- A factual correction where the user told the agent it had something wrong (a fact, a name, a command, a procedure, a piece of infrastructure).
- A novel user fact the agent did not previously know: their name, role, team, project, accounts, repositories, domain, or any personal identifier worth remembering.
- Infrastructure or tooling knowledge the agent just learned: URLs, ports, auth layers, deploy commands, environment names, hostnames, service dependencies.
- A workflow rule the user taught the agent: "always do X before Y", "never touch Z without asking", "use the staging channel for previews", "check-in with me before pushing".
- A hidden constraint the agent hit the hard way: rate limits, permission boundaries, blocked commands, expired credentials, environment assumptions that were wrong.
- A genuine error the agent made that is worth recording so future sessions do not repeat it.
- A recurring task pattern the user demonstrated that could become a reusable procedure.
- A user reaction that indicates dissatisfaction even without an explicit correction (short reply, tone shift, repeated request, visible frustration).

Do NOT fire (evolve=false) when the session is one of these:
- A routine task the agent completed cleanly with no new information gained.
- A one-off question about public facts (weather, news, general programming trivia) where no durable preference is attached.
- A clarification turn where the user just repeated or rephrased an already-stated request.
- A "status" / "hi" / "ping" style heartbeat interaction, including onboarding intros.
- A scheduler or cron-triggered session that ran its job and did not surface new user input.
- A system-originated message (secret save notification, button click forwarder) without meaningful user content.
- Polite thanks, acknowledgements, or closing statements ("ok", "thanks", "perfect") with no new instruction.

Edge rules:
- If the session outcome is failure, fire. Failure sessions are the single highest-signal event shape and should always be reflected on.
- If the user reaction array contains a negative reaction (thumbs down, angry, confused), fire.
- If a hook blocker fired during the session, fire: the agent just learned a boundary it previously did not respect.
- If the agent emitted a tool_use error, fire: the agent learned a usage pattern it should not repeat.
- If in doubt, fire. Over-firing is bounded by the downstream cadence batching, under-firing loses real learning signal and is strictly worse.

Respond with ONLY a JSON object matching this schema:
{
  "evolve": boolean,
  "reason": string (under 40 words, cite the specific signal)
}`,
		user: `Session metadata:
channel: ${input.channelType}
turns: ${input.turnCount}
duration: ${input.durationSeconds}s
cost: $${input.totalCostUsd.toFixed(4)}
tools_used: ${input.toolsUsed}
outcome: ${input.outcome}
user_reactions: ${input.userReactions}
hook_blocks: ${input.hookBlockCount}
tool_errors: ${input.toolErrorCount}

First user message:
${input.firstUserMessage}

Last user message:
${input.lastUserMessage}

Last agent reply:
${input.lastAgentMessage}

Decide: evolve or skip.`,
	};
}
