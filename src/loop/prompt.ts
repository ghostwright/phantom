import type { Loop } from "./types.ts";

export type TickPromptOptions = {
	memoryContext?: string;
	critique?: string;
};

/**
 * Per-tick prompt. Each tick is a fresh SDK session with no prior context
 * (rotating conversation ids in the runner guarantee this), so the prompt
 * must carry everything the agent needs: the goal, the state file contract,
 * the current state file contents, and the workspace path.
 */
export function buildTickPrompt(loop: Loop, stateFileContents: string, options?: TickPromptOptions): string {
	const memorySections: string[] = [];

	if (options?.memoryContext) {
		memorySections.push(`RECALLED MEMORIES (from previous sessions)\n\n${options.memoryContext}`);
	}

	if (options?.critique) {
		memorySections.push(`REVIEWER FEEDBACK (from your last checkpoint)\n\n${options.critique}`);
	}

	const injected = memorySections.length > 0 ? `\n\n${memorySections.join("\n\n")}\n` : "";

	return `You are running inside a "ralph loop" - a tight iteration primitive where a
fresh agent session is invoked once per tick. You have no memory from previous
ticks. All shared memory lives in the state file at:

  ${loop.stateFile}

The workspace for this loop is:

  ${loop.workspaceDir}

Your job this tick is to make concrete forward progress toward the goal, then
update the state file so the next tick can pick up where you left off.

THE STATE FILE CONTRACT (strict)

The state file has YAML frontmatter that the runner reads after each tick.
You MUST keep this frontmatter valid and update the fields as described:

  ---
  loop_id: <unchanged>
  status: in-progress | done | blocked
  iteration: <increment by 1 when you finish this tick>
  ---

- Set status to "done" ONLY when the goal is fully achieved (or when a
  configured success check will confirm it). The runner stops the loop the
  moment it sees status: done.
- Set status to "blocked" if you cannot make progress without external input.
  The loop continues, but your message to the operator belongs in the Notes
  section.
- Otherwise leave status as "in-progress".

Below the frontmatter, keep the sections: Goal, Progress, Next Action, Notes.
Be concise. Progress is a bullet list of what is actually done. Next Action
is one short paragraph telling the next tick exactly what to do first.

THE GOAL

${loop.goal}${injected}

CURRENT STATE FILE CONTENTS

${stateFileContents}

BUDGETS (enforced by the runner, informational for you)

- Max iterations: ${loop.maxIterations}
- Max total cost: $${loop.maxCostUsd.toFixed(2)}
- Iterations used so far: ${loop.iterationCount}
- Cost used so far: $${loop.totalCostUsd.toFixed(4)}

INSTRUCTIONS FOR THIS TICK

1. Read the current state file (above) carefully. Understand what the previous
   tick accomplished and what it asked you to do next.
2. Do the next action. Use whatever tools you need (Read, Write, Edit, Bash,
   etc.). Favor small verifiable steps over large speculative ones.
3. Write the updated state file using the Write tool at the exact path
   "${loop.stateFile}". Preserve the frontmatter format. Increment iteration.
   Update Progress with what you just did. Update Next Action with what the
   next tick should do. If you are fully done, set status to "done".
4. Briefly report in your final assistant message what you did this tick. The
   runner does not read that message for control flow - only the state file
   frontmatter decides termination - but it helps the operator watching logs.

Do not re-open the loop concept with the user. Do not ask clarifying questions.
If you are blocked, write that into the state file Notes and set status to
blocked. The operator is watching asynchronously.`;
}
