ultrathink. ultrathink. ultrathink.

You are a principal engineer, principal architect, AND principal product
manager at Anthropic, all three at once. You are implementing Phase 10B:
durable run timeline and reconnect correctness for Phantom chat on Murph.

No context anxiety. No token limits. No time pressure. No cost anxiety. No v2
thinking. There is no v2. Build it right. Take as long as you need. This prompt
is your starting point, not your ceiling. Exceed it.

You are fully autonomous. You may inspect code, run tests, and make the best
judgment calls a principal engineer would make. You are not alone in the
codebase. Do not revert edits made by others. Keep your write set focused on
Phase 10B. If you notice unrelated issues, document them rather than fixing
them.

Use Context7 MCP for library documentation if you touch library APIs. Never
guess at API signatures. For local code, read the actual files. Agent summaries
are not evidence.

## Working Directory

`/Users/truffle/work/phantom-pr-106-push`

## Mission

Build the smallest correct Phase 10B.

Phantom already has live activity rows, but refresh/reconnect and completed
timeline durability are not production-grade. Your work should make Phantom:

1. Preserve safe per-run activity summaries beyond the 24-hour stream-event
   retention window.
2. Reconnect and replay an active or incomplete run on route load.
3. Reconstruct partial assistant text and tool state without duplicating
   committed messages.
4. Separate stream connection state from run state so the UI can distinguish
   replaying, attached, interrupted, historical, completed, and idle.
5. Never persist raw chain-of-thought, raw secrets, raw env values, raw auth
   headers, full command output, or full tool JSON in the default durable
   timeline.

Do not implement the Murph Phase 10C progress extension. Do not do the full UI
polish pass. This is correctness and durability.

## Required Reading

Read in this order:

1. `/Users/truffle/.claude/AGENTS.md` around 70 lines.
2. `/Users/truffle/.claude/CLAUDE.md` around 300 lines.
3. `research/chat-experience/phase-10a-synthesis.md` around 351 lines.
4. `research/chat-experience/phase-10b-durable-timeline-research.md` around 330 lines.
5. `research/chat-experience/phase-10c-murph-progress-research.md` around 260 lines.
6. `research/chat-experience/phase-10d-chat-ui-polish-research.md` around 420 lines.
7. `src/db/schema.ts` around 360 relevant chat migration lines.
8. `src/chat/message-store.ts` around 120 lines.
9. `src/chat/session-store.ts` around 220 lines.
10. `src/chat/event-log.ts` around 71 lines.
11. `src/chat/writer.ts` around 203 lines.
12. `src/chat/http-handlers.ts` around 280 lines.
13. `src/chat/http.ts` around 220 lines.
14. `src/chat/sse.ts` around 120 lines.
15. `src/chat/stream-sse.ts` around 60 lines.
16. `src/chat/types.ts` around 222 lines.
17. `src/chat/types-tool.ts` around 151 lines.
18. `chat-ui/src/lib/client.ts` around 190 lines.
19. `chat-ui/src/hooks/use-chat.ts` around 224 lines.
20. `chat-ui/src/lib/chat-types.ts` around 90 lines.
21. `chat-ui/src/lib/chat-store.ts` around 290 lines.
22. `chat-ui/src/lib/chat-activity.ts` around 272 lines.
23. `chat-ui/src/lib/chat-dispatch-tools.ts` around 158 lines.
24. `chat-ui/src/routes/session-route.tsx` around 93 lines.
25. `chat-ui/src/components/message-list.tsx` around 113 lines.
26. Current tests under `src/chat/__tests__/` and
    `chat-ui/src/lib/__tests__/`.

## Expected Write Areas

You may modify or add files in these areas:

1. `src/db/schema.ts`
2. `src/chat/*timeline*` or a similarly named store/builder module.
3. `src/chat/message-store.ts`
4. `src/chat/session-store.ts`
5. `src/chat/event-log.ts`
6. `src/chat/writer.ts`
7. `src/chat/http-handlers.ts`
8. `src/chat/types.ts`
9. `chat-ui/src/lib/client.ts`
10. `chat-ui/src/hooks/use-chat.ts`
11. `chat-ui/src/lib/chat-types.ts`
12. `chat-ui/src/lib/chat-store.ts`
13. `chat-ui/src/lib/chat-activity.ts`
14. `chat-ui/src/lib/chat-dispatch-tools.ts`
15. `chat-ui/src/routes/session-route.tsx`
16. Tests under `src/chat/__tests__/` and `chat-ui/src/lib/__tests__/`.

Avoid broad visual styling unless needed to expose connection state. Full visual
polish is Phase 10D.

## Deliverables

1. Durable sanitized run timeline storage.
   - Prefer a new `chat_run_timelines` table or an equally clean store-backed
     design.
   - Store session id, user message id, optional assistant message id,
     start seq, end seq, status, timing, token/cost metadata, and safe
     `summary_json`.
   - Include delete cleanup for hard-deleted sessions.

2. A typed timeline summary builder.
   - Consume `ChatWireFrame` plus seq.
   - Merge repeated tool progress by tool id.
   - Merge subagent lifecycle by task id.
   - Record compaction, MCP status, rate limits, errors, aborts, and terminal
     state.
   - Redact and truncate aggressively.
   - Drop raw thinking deltas from durable summary.

3. Writer integration.
   - Start timeline tracking on `user.message`.
   - Update timeline on meaningful frames.
   - Persist at terminal and at meaningful intermediate points if necessary
     for crash recovery.
   - Handle successful, errored, and aborted runs.
   - Treat abort double-terminal behavior as one user-visible run ending.

4. Session detail extension.
   - Return stream state: max seq, latest terminal seq, writer active, and
     whether an incomplete tail exists.
   - Return durable timeline summaries keyed by user or assistant turn.
   - Keep existing clients backward-compatible.

5. Route-load resume.
   - After loading session detail, open `/chat/sessions/:id/resume` when the
     stream state indicates an active writer or incomplete tail.
   - Start from a safe cursor. Use latest terminal seq for the first slice if
     no run start id exists.
   - Mark frames before `session.caught_up` as replay in client state.
   - Do not duplicate committed user or assistant messages.

6. Client connection state.
   - Add a separate stream connection state such as idle, starting,
     reconnecting, replaying, attached, interrupted, detached.
   - Keep `isStreaming` behavior compatible for composer stop/send.
   - Surface reconnecting/replaying/interrupted in run activity copy.

7. Idempotent replay reducers.
   - Upsert `user.message` by `message_id`.
   - Upsert `message.assistant_start` by `message_id`.
   - Avoid duplicating text when replay follows committed final messages.
   - Keep tool calls keyed by tool call id.
   - Synthetic frames without SSE id must not advance `lastSeq`.

8. Tests.
   - Backend timeline summary tests for tool start/input/running/result,
     blocked, aborted, compaction, MCP status, subagents, session done,
     session error, and privacy redaction.
   - Backend session-detail stream-state test.
   - Backend resume edge test for active writer disappearing during replay.
   - Client store tests for idempotent replay and connection state.
   - Client hook or route-level test if the harness supports it. If not,
     cover the underlying helper logic and document the gap.

## Acceptance Criteria

Before you consider this done:

1. Refresh during an active run can reload committed messages and replay the
   active tail without duplicating user messages.
2. Refresh before assistant start can reconstruct visible run activity.
3. Refresh while assistant text is streaming can reconstruct partial assistant
   text from replay.
4. Refresh after completion shows the final answer plus durable run summary
   without fake live state.
5. Server restart or disappeared writer with an incomplete tail produces an
   explicit recovery/interrupted state, not a dead spinner.
6. Completed successful, errored, and aborted turns persist safe timeline
   summaries.
7. Durable summaries do not contain raw thinking, raw secrets, raw env values,
   raw auth headers, cookies, full command output, or full tool JSON.
8. Existing chat stream tests continue to pass.
9. TypeScript strict mode passes.
10. No explicit `any`, no `@ts-ignore`, no hidden type escapes.

## Anti-Patterns

Do not:

1. Use `chat_stream_events` as the only durable transcript timeline while the
   24-hour sweep exists.
2. Append replayed messages blindly.
3. Treat SSE EOF as successful completion.
4. Show replayed historical events as live work.
5. Persist raw chain-of-thought or raw tool output by default.
6. Block this phase on Murph Phase 10C progress metadata.
7. Redesign the whole chat UI.
8. Add Phantom-specific hacks into Murph.
9. Break current SDK-compatible stream shapes.
10. Trust this prompt's summaries over the files. Read the actual code.

## Verification Commands

Run at minimum:

1. `bun test src/chat/__tests__/http-resume.test.ts`
2. `bun test src/chat/__tests__/event-log.test.ts`
3. Any new backend tests you add.
4. `cd chat-ui && bun test src/lib/__tests__/chat-store.test.ts`
5. Any new chat-ui tests you add.
6. `bun run typecheck`
7. `cd chat-ui && bun run typecheck`
8. `bunx biome check` on changed files.
9. `git diff --check`

If one cannot run, explain exactly why in your final handoff.

## Completion Report

When done, report:

1. Files changed.
2. What durability now guarantees.
3. What is still deliberately deferred to Phase 10C or 10D.
4. Tests run and results.
5. Any risks that need reviewer attention.

ultrathink before implementation. Self-review before final. Fix your own
findings before handing off.
