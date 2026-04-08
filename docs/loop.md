# Loop

Phantom loop is an autonomous iteration primitive. The agent runs repeatedly against a goal, each tick in a fresh SDK session, with a markdown state file as the only contract between ticks. Budgets, mid-loop critique, Slack feedback, and post-loop learning are all built in.

## Overview

Regular sessions are conversational: the operator sends a message, the agent responds, back and forth. Loops are different. The operator defines a goal and a budget, then walks away. The runner drives ticks automatically until the goal is met or a budget is hit.

Use loops for long-horizon tasks where the agent should grind autonomously:
- "Keep refactoring until tests pass"
- "Iterate on this design doc until the reviewer approves"
- "Bisect this regression across the last 50 commits"

## MCP Tool

The `phantom_loop` tool exposes four actions: `start`, `status`, `stop`, `list`.

### Start Parameters

| Parameter | Default | Ceiling | Description |
|-----------|---------|---------|-------------|
| `goal` (required) | - | 10,000 chars | What the loop should achieve |
| `workspace` | `data/loops/<id>/` | - | Working directory for the agent |
| `max_iterations` | 20 | 200 | Maximum ticks before budget termination |
| `max_cost_usd` | 5 | 50 | Maximum total cost before budget termination |
| `checkpoint_interval` | off | 200 | Run a Sonnet critique every N ticks (0 = disabled) |
| `success_command` | off | - | Shell command run after each tick; exit 0 = done |
| `channel_id` | auto | - | Slack channel for status updates |
| `conversation_id` | auto | - | Slack thread for threading updates |
| `trigger_message_ts` | auto | - | Slack message timestamp for reaction ladder |

When started from Slack, `channel_id`, `conversation_id`, and `trigger_message_ts` are auto-filled from the originating message context. Explicit tool arguments always take precedence.

### Other Actions

- **status**: Returns the loop row, parsed state file frontmatter, and the first 40 lines of the state file.
- **stop**: Sets an interrupt flag. The loop stops gracefully before the next tick.
- **list**: Returns active loops. Pass `include_finished: true` for recent history.

## State File

The state file (`state.md` in the workspace) is the loop's memory across ticks. It has YAML frontmatter that the runner inspects for control flow, and a markdown body that belongs entirely to the agent.

### Frontmatter

```yaml
---
loop_id: <uuid>
status: in-progress    # in-progress | done | blocked
iteration: 3
---
```

The runner acts on `done` (finalize immediately) and `blocked` (continue, but the agent should explain in Notes). Everything else is treated as `in-progress`.

### Body Sections

```markdown
# Goal
Keep refactoring src/auth until all 47 tests pass.

# Progress
- Tick 1: Fixed the missing import in auth/middleware.ts
- Tick 2: Updated the session type to include refreshToken
- Tick 3: Fixed the mock in auth.test.ts, 44/47 tests passing

# Next Action
The remaining 3 failures are all in auth/oauth.test.ts. Read the test file,
identify the common cause, and fix it.

# Notes
(empty)
```

The agent reads Progress and Next Action at the start of each tick to understand what happened before and what to do now. The runner does not parse the body, only the frontmatter.

## Tick Lifecycle

Each tick follows a fixed sequence:

1. **Lock** - acquire in-flight guard (prevents concurrent ticks on the same loop)
2. **Pre-checks** - verify loop is still "running"; check interrupt flag; enforce budget limits
3. **Read state** - load the current state file from disk
4. **Build prompt** - assemble the tick prompt with: goal, state file contents, budget info, optional memory context, optional critique feedback
5. **Fresh session** - call `runtime.handleMessage()` with a rotating conversation ID (`{loopId}:{iteration}`)
6. **Agent works** - executes tools, makes progress, writes updated state file
7. **Record cost** - increment iteration count and accumulate cost from the SDK response
8. **Parse frontmatter** - re-read the state file; if the agent declared `done`, finalize immediately (steps 9-11 are skipped)
9. **Success command** - if configured, run the shell command (5-minute timeout, sanitized env with only PATH, HOME, LANG, TERM, TOOL_INPUT where TOOL_INPUT is a JSON string containing loop_id and workspace)
10. **Critique checkpoint** - if `checkpoint_interval` is set and the current tick is a multiple, run a Sonnet critique (see below)
11. **Slack update** - post tick progress to the status message
12. **Schedule next** - queue the next tick via `setImmediate`

## Slack Integration

When a loop is started from Slack (or with explicit `channel_id`), the `LoopNotifier` provides real-time feedback:

**Start notice** - posted to the channel/thread with the goal excerpt and budget:
```
:repeat: Starting loop `abcdef01` (max 20 iter, $5.00 budget)
> Keep refactoring src/auth until all 47 tests pass
```
Includes a Stop button routed through Slack interactive actions.

**Tick updates** - the same message is edited on each tick with a progress bar:
```
:repeat: Loop `abcdef01` · [████░░░░░░] 4/10 · $1.20/$5.00 · in-progress
```
The Stop button survives across edits (blocks are re-sent on every `chat.update`).

**Reaction ladder** on the operator's original message:
- Start: hourglass
- First tick: swap to cycling arrows
- Terminal: checkmark (done), stop sign (stopped), warning (budget exceeded), X (failed)

**Final notice** - progress bar with terminal emoji, and the state file body posted as a threaded code block so the operator can see the full progress log.

## Mid-Loop Critique

When `checkpoint_interval` is set, Sonnet 4.6 reviews the loop's progress every N ticks. This catches drift, stuck patterns, and wasted budget before the loop exhausts its resources.

The critique runs after terminal checks (so the final tick is never wasted on a critique call) and is guarded by judge availability and cost cap.

The reviewer sees:
- The original goal
- Rolling tick summaries (up to 10)
- The current state file (truncated to 3,000 chars)
- The agent's last response (truncated to 1,000 chars)

The assessment is injected into the next tick's prompt as a "REVIEWER FEEDBACK" section.

## Post-Loop Pipeline

After a loop finalizes, a fire-and-forget pipeline runs evolution and memory consolidation. Neither can affect the loop's final status, and errors are logged but never propagated.

**Evolution**: A bounded transcript (rolling summaries, first/last prompt-response pairs) is synthesized into a `SessionData` object and fed to the evolution engine's `afterSession()` pipeline. If the engine applies changes, the runtime's evolved config is updated.

**Memory consolidation**: If vector memory is ready, the session data is consolidated into episodic memory. When LLM judges are available and within cost cap, Sonnet extracts facts while checking for contradictions with existing knowledge. Otherwise, a heuristic fallback runs.

Loop status maps to evolution outcome: `done` becomes success, `stopped` becomes abandoned, everything else becomes failure.

## Memory Context

Memory context is cached once at loop start and injected into every tick prompt as a "RECALLED MEMORIES" section. Caching avoids re-querying the vector database on every tick (the goal is constant, so recall results don't change). The cache is cleared on finalize and rebuilt on resume.

## Writing Effective Goals

**Be specific and incremental:**
- Good: "Refactor src/auth/ to use the new session types from types.ts. Run `bun test src/auth` after each change. Stop when all tests pass."
- Bad: "Fix the auth system."

**One concrete action per tick:**
- The agent works best when Next Action describes a single, verifiable step
- Goals that encourage small steps ("fix one test at a time") produce more reliable loops than goals that demand large leaps

**Use success_command for objective verification:**
- `bun test src/auth` - loop runs until all auth tests pass
- `curl -sf http://localhost:3000/health` - loop runs until the service is healthy
- `grep -q 'TODO' src/module.ts && exit 1 || exit 0` - loop runs until no TODOs remain

## Key Files

| File | Purpose |
|------|---------|
| `src/loop/runner.ts` | LoopRunner: tick lifecycle, memory caching, critique scheduling, finalization |
| `src/loop/prompt.ts` | Per-tick prompt builder with memory and critique injection |
| `src/loop/types.ts` | Types, Zod schemas, constants, ceilings |
| `src/loop/store.ts` | SQLite persistence layer |
| `src/loop/state-file.ts` | State file init, read, YAML frontmatter parsing |
| `src/loop/tool.ts` | `phantom_loop` MCP tool (start/status/stop/list) |
| `src/loop/critique.ts` | Mid-loop Sonnet 4.6 critique judge |
| `src/loop/post-loop.ts` | Post-loop evolution and memory consolidation pipeline |
| `src/loop/notifications.ts` | Slack progress bar, reaction ladder, stop button |
