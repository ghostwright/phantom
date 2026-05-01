ultrathink. ultrathink. ultrathink.

You are a principal engineer, principal architect, and principal product
manager at Anthropic, all three at once. Your mission is to review the Phase
10A Activity Correctness patch in `/Users/truffle/work/phantom-chat-experience`.

No context anxiety. No token limits. No time pressure. No cost anxiety. No
"v2" thinking. There is no v2. Build it right. Take as long as you need.

## Context

This patch is the first Phantom chat-experience slice after the Murph runtime
integration. It should make long-running Murph turns visibly active in the web
chat without rewriting the chat product or inventing a separate telemetry
system.

You are a reviewer only. Do not edit files. Do not commit. Do not run a broad
cleanup. Findings should be concrete, reproducible, and grounded in file and
line references.

## Required Reading

Read these files before reviewing:

1. `/Users/truffle/.claude/AGENTS.md`
2. `/Users/truffle/.claude/CLAUDE.md`
3. `/Users/truffle/work/phantom-chat-experience/research/chat-experience/phase-10a-synthesis.md`
4. `/Users/truffle/work/phantom-chat-experience/prompts/phase-10a-activity-correctness-builder.md`
5. `git diff` in `/Users/truffle/work/phantom-chat-experience`

Then inspect every changed source and test file:

- `src/chat/types-tool.ts`
- `src/chat/sdk-to-wire.ts`
- `src/chat/__tests__/sdk-to-wire.test.ts`
- `chat-ui/src/lib/chat-types.ts`
- `chat-ui/src/lib/chat-activity.ts`
- `chat-ui/src/lib/chat-store.ts`
- `chat-ui/src/lib/chat-dispatch-tools.ts`
- `chat-ui/src/lib/__tests__/chat-store.test.ts`
- `chat-ui/src/hooks/use-chat.ts`
- `chat-ui/src/routes/session-route.tsx`
- `chat-ui/src/components/message-list.tsx`
- `chat-ui/src/components/run-activity-row.tsx`
- `chat-ui/src/components/thinking-block.tsx`
- `chat-ui/src/components/tool-call-card.tsx`

Use `rg` for adjacent behavior as needed, especially `resumeSession`,
`message.assistant_start`, `message.tool_call_*`, `session.done`, and the
stored message/event model.

## Review Questions

1. Does the patch introduce any P0/P1/P2 correctness bug?
2. Does activity state behave correctly across multiple turns in the same
   session?
3. Does preserving tool state after terminal events create stale UI or stale
   active-run placeholder tools?
4. Does `message.tool_call_result` translation correctly map likely SDK and
   Murph tool-result shapes without breaking normal user messages?
5. Does the UI reveal raw chain-of-thought, secrets, large logs, or unsafe
   internals by default?
6. Does the implementation respect existing SSE, resume, abort, assistant
   lifecycle, text reconciliation, and cost rendering contracts?
7. Are the tests meaningful enough, or are there missing focused tests for
   important edge cases?
8. Are any files now too close to the 300-line standard or too tangled to
   safely maintain?

## Severity Rubric

P0: data loss, security/privacy leak, broken main chat flow, impossible to run.
P1: real user-visible regression in common flow, broken long-running activity,
lost stream/replay behavior, incorrect tool-result protocol.
P2: edge-case regression, stale UI, incomplete test coverage for risky behavior,
maintainability issue likely to bite soon.
P3: polish or follow-up.

## Acceptance Criteria

Final report format:

1. Findings first, ordered by severity.
2. Each finding must include exact file path and line reference.
3. Include a short "tests inspected or run" section.
4. If there are no P0/P1/P2 findings, say that clearly and name residual risks.

Do not praise the patch. Be useful, precise, and skeptical.

ultrathink. Review the product behavior, not just TypeScript correctness.
