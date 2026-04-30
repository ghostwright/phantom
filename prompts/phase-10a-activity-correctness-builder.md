ultrathink. ultrathink. ultrathink.

You are a principal engineer, principal architect, and principal product
manager at Anthropic, all three at once. Your mission is to implement Phase
10A Activity Correctness for Phantom's web chat experience on the clean
Phantom branch `/Users/truffle/work/phantom-chat-experience`.

No context anxiety. No token limits. No time pressure. No cost anxiety. No
"v2" thinking. There is no v2. Build it right. Take as long as you need.

## Context

Murph is now merged to Murph `main`. Phantom's Murph branch proves the backend
works with OpenAI, including real auto-compaction in a browser session. The
problem is now product trust: long-running Murph turns can be actively working
while the web chat appears quiet.

This build is not a full redesign. It is the first production-grade correctness
slice that makes existing runtime activity visible, durable enough for the
current transcript, and safe by default.

You are not alone in the codebase. The orchestrator and possibly later workers
may make adjacent changes. Do not revert changes you did not make. Keep your
write set focused. Work only in `/Users/truffle/work/phantom-chat-experience`.

## Required Reading

Read these files before editing:

1. `/Users/truffle/.claude/AGENTS.md`
2. `/Users/truffle/.claude/CLAUDE.md`
3. `/Users/truffle/work/phantom-chat-experience/CLAUDE.md`
4. `/Users/truffle/work/phantom-chat-experience/research/chat-experience/phase-10a-synthesis.md`
5. `/Users/truffle/work/phantom-chat-experience/src/chat/types.ts`
6. `/Users/truffle/work/phantom-chat-experience/src/chat/types-tool.ts`
7. `/Users/truffle/work/phantom-chat-experience/src/chat/sdk-to-wire.ts`
8. `/Users/truffle/work/phantom-chat-experience/src/chat/sdk-to-wire-handlers.ts`
9. `/Users/truffle/work/phantom-chat-experience/chat-ui/src/lib/chat-types.ts`
10. `/Users/truffle/work/phantom-chat-experience/chat-ui/src/lib/chat-store.ts`
11. `/Users/truffle/work/phantom-chat-experience/chat-ui/src/lib/chat-dispatch-tools.ts`
12. `/Users/truffle/work/phantom-chat-experience/chat-ui/src/hooks/use-chat.ts`
13. `/Users/truffle/work/phantom-chat-experience/chat-ui/src/components/message-list.tsx`
14. `/Users/truffle/work/phantom-chat-experience/chat-ui/src/components/assistant-message.tsx`
15. `/Users/truffle/work/phantom-chat-experience/chat-ui/src/components/tool-call-card.tsx`
16. `/Users/truffle/work/phantom-chat-experience/chat-ui/src/components/thinking-block.tsx`
17. `/Users/truffle/work/phantom-chat-experience/chat-ui/src/lib/__tests__/chat-store.test.ts`
18. `/Users/truffle/work/phantom-chat-experience/src/chat/__tests__/sdk-to-wire.test.ts`

Use `rg` first for any adjacent context. Do not bulk-read unrelated files.
Use Context7 MCP for library docs if you touch unfamiliar APIs.

## Ownership

You own this first slice:

- backend wire-type additions that are additive and safe
- SDK-to-wire translation for tool results if practical
- client chat state additions for run activity
- reducer behavior for existing ignored frames
- minimal UI rendering for active run status and activity
- focused tests for reducer and translator behavior

Do not touch:

- Murph repo
- Phantom provider config
- production deployment files
- generated public artifacts
- live server state under `/Users/truffle/work/phantom-murph-pr`
- broad styling rewrites
- app shell/sidebar redesign

## Goals

Implement the first shippable activity-correctness slice:

1. A visible active-run row appears immediately after the user sends a message,
   even before `message.assistant_start`.
2. Existing lifecycle frames update user-visible run activity:
   - `session.status`
   - `session.compact_boundary`
   - `session.rate_limit`
   - `session.mcp_status`
   - `session.truncated_backlog`
   - `message.subagent_start`
   - `message.subagent_progress`
   - `message.subagent_end`
3. Orphan tool frames create safe placeholder tool state instead of vanishing:
   - `message.tool_call_running`
   - `message.tool_call_result`
   - `message.tool_call_blocked`
   - `message.tool_call_aborted`
4. Terminal events do not erase useful completed tool or thinking/activity
   evidence from the current transcript.
5. Successful tools are compact by default, but active, blocked, aborted, and
   errored states remain visible.
6. Raw thinking is not made more prominent. If you change thinking rendering,
   move toward safe activity copy rather than exposing raw reasoning.
7. Existing chat behavior, SSE resume, abort, assistant lifecycle, committed
   messages, and cost metadata continue to work.

## Implementation Guidance

Prefer minimal additive changes. This is not the durable timeline phase.

Likely files:

- `src/chat/types-tool.ts`
- `src/chat/sdk-to-wire.ts`
- `src/chat/sdk-to-wire-handlers.ts`
- `src/chat/__tests__/sdk-to-wire.test.ts`
- `chat-ui/src/lib/chat-types.ts`
- `chat-ui/src/lib/chat-store.ts`
- `chat-ui/src/lib/chat-dispatch-tools.ts`
- `chat-ui/src/lib/__tests__/chat-store.test.ts`
- `chat-ui/src/components/message-list.tsx`
- `chat-ui/src/components/assistant-message.tsx`
- `chat-ui/src/components/tool-call-card.tsx`
- a small new component if it keeps files under 300 lines

Important product constraints:

- Do not turn chat into a raw log viewer.
- Keep the answer visually primary.
- Activity should be concise and scannable.
- Do not show secrets, raw env values, auth headers, cookies, or raw hidden
  reasoning.
- Use existing Phantom visual language. No landing-page styling, no huge hero
  typography, no decorative blobs.
- Use lucide icons only where useful and already available.
- Text must not overflow or overlap in mobile or desktop layouts.

Important technical constraints:

- TypeScript strict. No explicit `any`. No `@ts-ignore`.
- Files should stay under the repo's 300-line standard where feasible.
- No default exports.
- No hidden type escapes.
- Comments explain why, not what.
- Do not break existing wire discriminants.
- Additive frame fields are okay. Renaming existing fields is not okay.
- Client-side frame handling must tolerate missing fields from older events.

## Specific Design Shape

Model activity as small, safe facts. A possible state shape:

- `runActivity`: current status, startedAt, updatedAt, currentLabel,
  compact event, rate-limit info, MCP summary, subagent summaries
- tool placeholders: `toolName` can be `"Tool"` when unknown, `messageId` can
  attach to the latest streaming assistant message or a synthetic active run
  message if no assistant exists

If an active tool frame arrives before an assistant message exists, the UI
still needs visible activity. Use the active-run row for that. Do not force a
fake assistant message unless it improves the existing component model safely.

For `message.tool_call_running`, add optional backend fields if they are
available from context. If not, make the client robust with placeholders.

For `message.tool_call_result`, inspect SDK/Murph message shapes carefully.
If there is a reliable `tool_result` carrier, translate it. If not reliable,
do not guess. Document what you found and add tests for any supported shape.

## Tests Required

At minimum:

1. Client reducer test: sending or receiving streaming state makes visible run
   activity available before assistant start.
2. Client reducer test: `session.status: compacting` updates run activity.
3. Client reducer test: `session.compact_boundary` records safe compaction
   activity.
4. Client reducer test: orphan `message.tool_call_running` creates or
   preserves a placeholder rather than dropping the event.
5. Client reducer test: terminal `session.done` does not clear completed tool
   state from the current transcript.
6. Client reducer test: subagent frames produce activity state.
7. Backend translator test: any implemented tool-result translation emits
   `message.tool_call_result`.
8. Existing tests still pass for touched areas.

Run the focused tests you touched. If time permits, also run:

- `bun test src/chat/__tests__/sdk-to-wire.test.ts`
- `cd chat-ui && bun test src/lib/__tests__/chat-store.test.ts`
- `bun run typecheck`
- `cd chat-ui && bun run typecheck`

## Acceptance Criteria

Your final response must include:

1. Files changed.
2. What user-visible behavior improved.
3. What tests you ran and their result.
4. Any known limitations left for Phase 10B or Murph API extension.

Do not commit. Do not push. The orchestrator will review actual files and run
the final verification loop.

## Anti-Patterns

Do not invent a new tracing backend.
Do not persist a new database timeline in this slice unless absolutely needed.
Do not show raw chain-of-thought.
Do not create a fake provider-specific UI branch.
Do not make Phantom-specific changes inside Murph.
Do not rewrite the chat UI wholesale.
Do not bury the final assistant answer under tool chrome.

ultrathink. Think like the user watching a long-running agent. The UI should
say "I am working, here is the evidence" immediately, calmly, and safely.
