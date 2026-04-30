ultrathink. ultrathink. ultrathink.

You are a principal engineer, principal architect, and principal product
manager at Anthropic, all three at once. Your mission is to audit Phantom's
current web chat experience pipeline from backend SDK event ingestion through
SSE, frontend reducer state, and React rendering. Treat this as a production
agent-chat product, not a cosmetic chat bubble exercise.

No context anxiety. No token limits. No time pressure. No cost anxiety. No
"v2" thinking. There is no v2. Build it right. Take as long as you need.

## Context

Cheema and the orchestrator have just proven Phantom running on Murph with
OpenAI `gpt-5.5` in a real browser. The runtime is working, including
auto-compaction. The user-visible weakness is that long-running tool-heavy
tasks can look dead while Murph and Phantom are actively working.

The goal of this research slice is to understand the existing Phantom chat
pipeline deeply enough to design a best-in-class activity surface. Do not
implement code. Do not edit source files. Produce findings only.

## Required Reading

Read these files in this order:

1. `/Users/truffle/work/phantom-chat-experience/CLAUDE.md`
2. `/Users/truffle/work/phantom-chat-experience/README.md`
3. `/Users/truffle/work/phantom-chat-experience/src/chat/types.ts`
4. `/Users/truffle/work/phantom-chat-experience/src/chat/types-tool.ts`
5. `/Users/truffle/work/phantom-chat-experience/src/chat/sdk-to-wire.ts`
6. `/Users/truffle/work/phantom-chat-experience/src/chat/sdk-to-wire-handlers.ts`
7. `/Users/truffle/work/phantom-chat-experience/src/chat/writer.ts`
8. `/Users/truffle/work/phantom-chat-experience/src/chat/http.ts`
9. `/Users/truffle/work/phantom-chat-experience/src/chat/stream-sse.ts`
10. `/Users/truffle/work/phantom-chat-experience/src/chat/event-log.ts`
11. `/Users/truffle/work/phantom-chat-experience/chat-ui/src/hooks/use-chat.ts`
12. `/Users/truffle/work/phantom-chat-experience/chat-ui/src/lib/chat-store.ts`
13. `/Users/truffle/work/phantom-chat-experience/chat-ui/src/lib/chat-dispatch-tools.ts`
14. `/Users/truffle/work/phantom-chat-experience/chat-ui/src/components/message-list.tsx`
15. `/Users/truffle/work/phantom-chat-experience/chat-ui/src/components/assistant-message.tsx`
16. `/Users/truffle/work/phantom-chat-experience/chat-ui/src/components/tool-call-card.tsx`
17. `/Users/truffle/work/phantom-chat-experience/chat-ui/src/components/thinking-block.tsx`
18. `/Users/truffle/work/phantom-chat-experience/chat-ui/src/lib/__tests__/chat-store.test.ts`
19. `/Users/truffle/work/phantom-chat-experience/e2e/chat.spec.ts`

Also inspect any adjacent files that are directly needed to answer the
questions below. Use `rg` first.

## Questions To Answer

1. What is the exact event path from SDK/Murph message to the UI? Include each
   file and function in order.
2. Which backend wire frames exist today but are ignored or under-rendered by
   the frontend?
3. Which frontend state objects disappear at `session.done`, and does that
   erase useful post-run tool history from the transcript?
4. Why can the UI look idle during a long-running Murph turn? Identify every
   contributing cause, not just the first one.
5. What invariants must not break when we redesign this? Include SSE resume,
   persisted messages, assistant lifecycle, tool-call protocol, thinking
   blocks, error rows, and abort behavior.
6. What would a minimal but production-grade first implementation look like?
   Keep it scoped and testable. Name exact files likely to change.
7. What would a larger best-in-class implementation look like after that?
   Separate necessary product quality from speculative polish.

## Acceptance Criteria

Your final answer must be findings-first, with concrete file references and
line-level anchors when possible. It must include:

1. A current-state pipeline map.
2. A bug/risk list ordered by severity.
3. A recommended first build slice with tests.
4. A second-stage product architecture for richer observability.
5. Explicit non-goals for this phase.

Do not include generic chat UX advice. Every claim must be grounded in Phantom
source code you read.

## Anti-Patterns

Do not recommend a rewrite unless you can name the specific contract the
rewrite improves and the migration path that keeps existing behavior working.
Do not add reasoning to TypeScript that belongs in the agent. Do not ask for
server changes unless the current wire protocol cannot carry the needed state.
Do not trust comments without reading the implementation.

## Handoff

Return your report in the final response. If you create notes, put them under
`/Users/truffle/work/phantom-chat-experience/research/chat-experience/`.

ultrathink. Stay product-minded and implementation-grounded.
