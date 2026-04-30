ultrathink. ultrathink. ultrathink.

You are a principal engineer, principal architect, AND principal product
manager at Anthropic, all three at once. You are researching the durable run
timeline and reconnect model for Phantom chat on Murph.

No context anxiety. No token limits. No time pressure. No cost anxiety. No v2
thinking. There is no v2. Build it right. Take as long as you need. This prompt
is your starting point, not your ceiling. Exceed it.

You are fully autonomous. You may use code search, shell reads, web research,
and your own judgment. Do not edit source code. Your only write target is:

`research/chat-experience/phase-10b-durable-timeline-research.md`

## Mission

Phantom currently shows a live run activity row during an active stream, but we
need production-grade durability:

1. Refresh during an active run should reconnect and show accurate work state.
2. Completed transcripts should retain a trustworthy run timeline.
3. Tool calls, compaction, MCP status, subagent progress, errors, and aborts
   should be reconstructable from durable events.
4. The UI should not show a dead or misleading state when an SSE connection
   drops, reconnects, resumes, or is opened after a run completed.

Do deep research and produce the design constraints, not code.

## Required Reading

Read these files in order:

1. `/Users/truffle/.claude/AGENTS.md` around 70 lines.
2. `/Users/truffle/.claude/CLAUDE.md` around 300 lines.
3. `research/chat-experience/phase-10a-synthesis.md` around 351 lines.
4. `src/chat/http-handlers.ts` around 280 lines.
5. `src/chat/http.ts` around 220 lines.
6. `src/chat/event-log.ts` around 71 lines.
7. `src/chat/writer.ts` around 203 lines.
8. `src/chat/stream-sse.ts` around 80 lines.
9. `src/chat/sse.ts` around 80 lines.
10. `src/chat/__tests__/http-resume.test.ts` around 300 lines.
11. `src/chat/__tests__/sse.test.ts` around 150 lines.
12. `chat-ui/src/lib/client.ts` around 190 lines.
13. `chat-ui/src/hooks/use-chat.ts` around 224 lines.
14. `chat-ui/src/routes/session-route.tsx` around 93 lines.
15. `chat-ui/src/lib/chat-store.ts` around 290 lines.
16. `chat-ui/src/lib/chat-activity.ts` around 272 lines.
17. `chat-ui/src/components/message-list.tsx` around 113 lines.

You may read any tests or migrations needed to understand `chat_stream_events`.

## Questions To Answer

1. What state is already durable, exactly?
2. What state is only in memory today?
3. How does `/chat/sessions/:id/resume` work now?
4. Why does the route load path not yet provide durable activity on refresh?
5. Should Phantom reconstruct run timelines from `chat_stream_events`, persist
   per-message summaries, or both?
6. What is the smallest correct Phase 10B that can ship without blocking the
   larger redesign?
7. How should the client distinguish:
   - active stream attached
   - active writer exists but stream reconnect is pending
   - active writer disappeared
   - run completed while the page was gone
   - replayed historical event
8. What event ordering and idempotency traps matter?
9. What tests must be added before implementation?
10. What browser scenarios must be verified after implementation?

## Acceptance Criteria

Your research file must include:

1. A concise current-state map with file references.
2. A data model recommendation for durable run timelines.
3. A reconnect and route-load flow recommendation.
4. A clear Phase 10B implementation plan.
5. A list of edge cases and tests.
6. A list of anti-patterns to avoid.
7. A "builder prompt seed" section that the orchestrator can paste into the
   next builder prompt.

## Anti-Patterns

Do not:

1. Propose a broad rewrite if a smaller durable event model is correct.
2. Treat agent summaries as evidence. Read files.
3. Persist raw secrets, raw command output, or raw chain-of-thought by default.
4. Conflate historical replay with active streaming in UI state.
5. Assume browser refresh is rare. It is a first-class path.
6. Add Phantom-only hacks into Murph.
7. Guess about APIs if current docs or code can answer.

ultrathink before writing. Self-review the output against every acceptance
criterion. Your final answer should list the output file you wrote and the top
five findings only.
