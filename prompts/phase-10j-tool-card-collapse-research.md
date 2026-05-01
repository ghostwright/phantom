ultrathink. ultrathink. ultrathink.

You are a principal engineer, principal architect, and principal product manager at Anthropic, all three at once.

No context anxiety. No token limits. No time pressure. No cost anxiety. No "v2" thinking. There is no v2. Build it right. Take as long as you need.

# Mission

Research one narrow Phantom chat UI behavior: completed tool cards should be collapsed by default, while active, blocked, or errored tool work should remain useful and inspectable. Do not edit files. Produce a concise report with the exact source-level recommendation and tests the builder should add.

# Required Reading

Read these files from the current workspace:

1. `/Users/truffle/.claude/AGENTS.md`
2. `/Users/truffle/.claude/CLAUDE.md`
3. `/Users/truffle/work/murph/QUALITY-BAR.md`
4. `/Users/truffle/work/phantom-murph-hardening/CLAUDE.md`
5. `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10h-product-direction.md`
6. `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10d-chat-ui-polish-research.md`
7. `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/tool-call-card.tsx`
8. `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/run-activity-row.tsx`
9. `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/assistant-message.tsx`
10. `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/lib/chat-types.ts`
11. Existing chat UI tests under `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/lib/__tests__/`

# Context

The user observed that completed tool cards look excellent but are too open by default in long sessions. The desired product behavior is:

1. Completed successful tool cards are collapsed by default.
2. Error, blocked, or attention-needed tool cards may auto-open.
3. Active tool cards may remain readable while the agent is working, but should not leave every completed tool expanded forever.
4. If the user explicitly expands a completed tool, that preference should not be immediately overridden.
5. The implementation should be small, explicit, accessible, and testable.

# Questions To Answer

1. Does `ToolCallCard` currently default completed tools closed on first mount?
2. What state transition could still leave a completed card open?
3. What is the smallest source-level policy that makes the behavior deterministic without making active tools feel dead?
4. Should the policy live inside `ToolCallCard`, in parent components, or in store state?
5. What focused tests should be added, given the current test setup?
6. Are there any accessibility details the implementation must preserve?

# Anti-patterns

- Do not propose a broad chat redesign in this report.
- Do not move UI disclosure state into the global chat store unless there is a strong reason.
- Do not hide error, blocked, or security-relevant tool details by default.
- Do not expose provider private thinking or raw internal protocol details.
- Do not add a dependency just for this.

# Deliverable

Write a report to:

`/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10j-tool-card-collapse-research.md`

Use this structure:

1. Findings
2. Recommended behavior policy
3. Recommended implementation
4. Recommended tests
5. Risks and non-goals

Keep it concise but precise. Cite file paths and function names. End with a verdict.

ultrathink. ultrathink. ultrathink.
