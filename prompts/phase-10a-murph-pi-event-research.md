ultrathink. ultrathink. ultrathink.

You are a principal engineer, principal architect, and principal product
manager at Anthropic, all three at once. Your mission is to audit the Murph,
Pi, and reference-agent event surfaces that can power Phantom's next chat
experience.

No context anxiety. No token limits. No time pressure. No cost anxiety. No
"v2" thinking. There is no v2. Build it right. Take as long as you need.

## Context

Murph is a clean-room, TypeScript, pi-mono based agent runtime. Phantom is the
first production tenant. We have proven Murph can run Phantom with OpenAI and
can compact long tool-heavy sessions. The next problem is not runtime
correctness, it is user trust during long-running work.

Cheema specifically wants Phantom to surface Murph tool calls, thinking state
where appropriate, compaction, sub-agent activity, and "what is happening"
while the agent is working. We must reuse Pi and Murph capabilities rather than
invent a parallel telemetry layer.

## Required Reading

Read these files in this order:

1. `/Users/truffle/work/murph/AGENTS.md`
2. `/Users/truffle/work/murph/PROGRESS.md`
3. `/Users/truffle/work/murph/QUALITY-BAR.md`
4. `/Users/truffle/work/murph/packages/core/src/types/message.ts`
5. `/Users/truffle/work/murph/packages/core/src/events/normalized-event.ts`
6. `/Users/truffle/work/murph/packages/core/src/events/translator-pi.ts`
7. `/Users/truffle/work/murph/packages/core/src/query/query.ts`
8. `/Users/truffle/work/murph/packages/core/src/substrate/pi-harness.ts`
9. `/Users/truffle/work/murph/packages/core/src/substrate/pi-adapter.ts`
10. `/Users/truffle/work/murph/packages/core/src/compaction/compact.ts`
11. `/Users/truffle/work/pi-mono/packages/agent/src/agent-loop.ts`
12. `/Users/truffle/work/pi-mono/packages/agent/src/types.ts`
13. `/Users/truffle/work/pi-mono/packages/agent/src/agent.ts`
14. `/Users/truffle/work/notes-main/plans/agent/PLAN.md`
15. `/Users/truffle/work/notes-main/plans/agent-skills/PLAN.md`
16. Any local openclaw, opencode, claw-code, or shelley files that show how
    agent progress, tool calls, tasks, or compaction are surfaced to users.

Use `rg` first. Do not bulk-read entire repos.

## Questions To Answer

1. What normalized events does Murph already produce that Phantom can render
   without changing Murph?
2. Which events include enough metadata for a polished UI, and which are too
   thin today? Be specific about tool name, elapsed time, input, output,
   progress summaries, subagent lifecycle, compaction metadata, and thinking.
3. Does Pi already emit richer tool/progress/thinking details that Murph drops?
   If yes, name the exact translation point.
4. Is "thinking" appropriate to expose directly in Phantom, or should Phantom
   render a safer activity/explanation layer? Give a product and safety answer.
5. How should compaction show up in chat? Should it be visible to the user,
   collapsed, or only used for diagnostics?
6. What is the smallest Murph-side change, if any, that would make Phantom's
   UI dramatically better?
7. What would be risky to add to Murph for UI only, because it would violate
   the runtime/library boundary?

## Acceptance Criteria

Your report must distinguish:

1. Already available from Murph.
2. Available from Pi but not translated by Murph.
3. Needs Murph API extension.
4. Should remain Phantom-only.

For each proposed event or field, include the source file and the consumer
file where Phantom would render it.

## Anti-Patterns

Do not invent a generic tracing system if existing Murph/Pi events suffice.
Do not leak raw chain-of-thought or sensitive tool payloads. Do not recommend
provider-specific UI branches unless capability metadata requires it. Do not
copy implementation from reference repos. Patterns are okay; code is not.

## Handoff

Return a concise but complete final report. Include a proposed event contract
table for Phantom's UI. If you create notes, write under
`/Users/truffle/work/phantom-chat-experience/research/chat-experience/`.

ultrathink. Focus on reusable runtime signal, not ornamental UI.
