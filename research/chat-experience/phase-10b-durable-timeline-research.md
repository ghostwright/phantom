# Phase 10B Durable Timeline Research

Date: 2026-04-30
Scope: Research only. No source changes.

## Executive Summary

Phantom already has the bones of durable stream replay: every emitted chat wire
frame is appended to `chat_stream_events`, `/chat/sessions/:id/resume` can drain
that log after a client cursor, and the resume handler can attach to a live
writer when one exists. That is enough to build reliable refresh during an active
run, but it is not enough for trustworthy completed transcripts.

The important constraint is retention and safety. `chat_stream_events` is swept
after 24 hours, and its payloads are raw wire frames. Some frames can include raw
tool inputs, raw tool output snippets, and thinking deltas. Completed transcripts
therefore need a sanitized per-run summary that survives the event sweep. The
right model is both:

1. Use `chat_stream_events` as the high-fidelity ordered replay log for active
   reconnect, recent replay, race recovery, and rebuilding summaries.
2. Persist a compact sanitized run timeline per assistant turn for durable
   transcript display.

Phase 10B should not redesign the whole chat UI. It should make route load and
resume trustworthy, separate connection state from run state, and persist enough
safe run evidence that completed messages keep their history after stream events
are gone.

## Current-State Map

### Durable Session And Message State

- `src/chat/http-handlers.ts:24-29` serves `GET /chat/sessions/:id` by returning
  the session row plus committed `chat_messages`. It does not return stream
  events, active writer state, or run activity summaries.
- `src/db/schema.ts:280-294` defines `chat_messages` with session id, message
  seq, role, content JSON, status, stop reason, token counts, cost, model, and
  error text. It has `UNIQUE(session_id, seq)` for transcript order.
- `src/chat/message-store.ts:50-68` commits each message as a durable row.
  `src/chat/writer.ts:63-80` commits the user message before the runtime starts
  and emits the matching `user.message` stream frame.
- `src/chat/writer.ts:101-115` commits the assistant message only after
  `runtime.runForChat` returns successfully. During an active run, the partial
  assistant response exists only in stream events and client state.
- `src/chat/session-store.ts:143-169` persists message count, first user message
  time, last message time, total input tokens, output tokens, and cost.

What this means: final successful transcripts are durable as messages, but their
tool, compaction, MCP, subagent, abort, and error timeline is not durably attached
to those messages today.

### Durable Stream Event State

- `src/db/schema.ts:319-329` defines `chat_stream_events` with autoincrement id,
  session id, nullable message id, seq, event type, payload JSON, and created
  time. The `message_id` column references `chat_messages(id)`. It has an index
  on `(session_id, seq)`, but no unique constraint on that pair.
- `src/chat/event-log.ts:21-27` appends JSON payloads to
  `chat_stream_events`.
- `src/chat/event-log.ts:29-39` drains events for one session after a client seq,
  ordered by seq, defaulting to 5000 rows per page.
- `src/chat/event-log.ts:41-56` can get the max stream seq and latest terminal
  seq, where terminal means `session.done`, `session.error`, or
  `session.aborted`.
- `src/chat/writer.ts:194-201` assigns the stream seq, appends the event, and
  publishes it to the in-memory stream bus. Today it passes `null` for the
  event-log `message_id` column even when the frame payload contains a
  `message_id`. That avoids a subtle problem for active assistant frames: the
  assistant message id is generated before streaming, but the assistant
  `chat_messages` row is not committed until success.
- `src/chat/sweep.ts:18-21` sets stream event retention to 24 hours, and
  `src/chat/sweep.ts:36-38` sweeps old stream events hourly.

What this means: stream events are durable enough for refresh and restart within
the retention window, but they are not a permanent transcript timeline. They are
also not currently queryable by assistant message id without parsing payloads.

### In-Memory Runtime And Connection State

- `src/chat/writer.ts:24-29` keeps active writers in a process-local map by
  session id.
- `src/chat/writer.ts:31-51` tracks writer active state with an in-memory
  `running` boolean and registers the writer synchronously in `claim`.
- `src/chat/writer.ts:58-60` keeps the abort controller and seq counter in
  memory for the current run.
- `src/chat/sdk-to-wire.ts:11-25` creates an in-memory translation context for
  block lengths, started tool ids, completed tool inputs, assistant lifecycle,
  and partial tool input JSON.
- `src/chat/stream-sse.ts:12-56` creates live SSE streams by subscribing to the
  in-memory stream bus. The bus is fan-out only, not storage.
- `src/chat/http-handlers.ts:132-181` uses an in-memory replay buffer during
  resume to catch live frames that arrive while the durable event log is being
  drained.

What this means: an active writer can be discovered only in the current process.
If the process restarts, the durable log may show an incomplete tail, but the
writer cannot be resumed.

### Client State

- `chat-ui/src/lib/chat-store.ts:18-29` initializes messages, tool calls,
  thinking blocks, text blocks, run activity, streaming state, last seq, and
  session id in memory.
- `chat-ui/src/hooks/use-chat.ts:50-57` updates `lastSeq` when it sees SSE `id`
  lines.
- `chat-ui/src/hooks/use-chat.ts:67-70` clears `isStreaming` when the current
  stream reader ends.
- `chat-ui/src/hooks/use-chat.ts:168-180` resets the store and loads committed
  messages from `GET /chat/sessions/:id`. It does not call the existing
  `resumeSession` client helper.
- `chat-ui/src/lib/client.ts:152-188` exposes `resumeSession`, but no route uses
  it.
- `chat-ui/src/lib/chat-activity.ts:37-43` creates active run activity before an
  assistant message exists.
- `chat-ui/src/components/message-list.tsx:89-91` renders one run activity row
  when `runActivity` exists.

What this means: Phase 10A made live activity visible, but that state is
client-memory only. Refresh resets it unless the client attaches to resume and
replays the relevant event tail.

## How Resume Works Now

`POST /chat/sessions/:id/resume` currently does this:

1. Reads `client_last_seq` from the request body. See
   `src/chat/http-handlers.ts:122-131`.
2. Checks `getActiveWriter(sessionId)?.isActive` once and stores the result in
   `writerActive`. See `src/chat/http-handlers.ts:163`.
3. If a writer is active, subscribes to the stream bus before replay starts.
   Live frames that arrive while replay is still draining are buffered. See
   `src/chat/http-handlers.ts:169-181`.
4. Emits a synthetic non-persisted `session.resumed` frame with
   `writer_active`. See `src/chat/http-handlers.ts:184-190`.
5. Drains durable `chat_stream_events` after the client seq, in pages, writing
   each event with its persisted SSE id. See
   `src/chat/http-handlers.ts:192-202`.
6. Sorts and flushes buffered live frames after replay, skipping seq values that
   have already been replayed. See `src/chat/http-handlers.ts:204-214`.
7. Emits a synthetic non-persisted `session.caught_up` frame. See
   `src/chat/http-handlers.ts:217-223`.
8. If the writer is still active, keeps the connection alive with heartbeat and
   live subscription. If a terminal was seen, or the writer disappeared, it
   closes soon. See `src/chat/http-handlers.ts:225-232`.
9. If there was no active writer, closes after replay. If the event log has a
   non-terminal tail, it emits a synthetic non-persisted server restart recovery
   error. See `src/chat/http-handlers.ts:233-239` and
   `src/chat/sse.ts:44-54`.

The existing tests cover important parts:

- `src/chat/__tests__/http-resume.test.ts:132-202` verifies live frames arriving
  during replay are buffered and emitted in seq order.
- `src/chat/__tests__/http-resume.test.ts:204-260` verifies incomplete durable
  tails with no active writer get a non-persisted server restart recovery frame.
- `src/chat/__tests__/http-resume.test.ts:262-289` verifies replay can drain more
  than the default 5000-event page before `session.caught_up`.
- `src/chat/__tests__/sse.test.ts:98-121` verifies SSE headers, terminal event
  detection, and server restart recovery frame shape.

## Why Route Load Is Not Durable Yet

The route load path only rebuilds committed messages. It does not rebuild the
run timeline.

- `chat-ui/src/routes/session-route.tsx:29-35` calls `loadSession` when a session
  route mounts.
- `chat-ui/src/hooks/use-chat.ts:168-176` resets the in-memory store, fetches
  `GET /chat/sessions/:id`, maps rows to `ChatMessage`, and stops there.
- `GET /chat/sessions/:id` itself returns messages only. See
  `src/chat/http-handlers.ts:24-29`.
- The client has a `resumeSession` transport helper in
  `chat-ui/src/lib/client.ts:152-188`, but `useChat` does not import or call it.
- The route-load store has `lastSeq = 0` after reset, but committed messages do
  not carry the stream seq needed to know which event range is already rendered.

This creates four visible failure modes:

1. Refresh during an active run loses live activity unless the page opens a new
   resume stream.
2. Refresh after partial assistant text loses the partial assistant because it is
   not committed to `chat_messages` yet.
3. Refresh after completion can show the final assistant answer, but loses the
   tool, compaction, MCP, subagent, abort, and error evidence.
4. Replaying from seq `0` after loading committed messages would duplicate
   messages unless replay application becomes idempotent or the server supplies
   a safe active-tail cursor.

## Data Model Recommendation

### Recommendation

Use a two-layer model:

1. `chat_stream_events` remains the ordered replay log for active reconnect and
   recent reconstruction.
2. Add a durable sanitized run timeline summary keyed by assistant turn, either
   as a new table or as a message-owned JSON column. Prefer a new
   `chat_run_timelines` table because it keeps transcript content separate from
   activity metadata and gives the backend clear ownership of start and end
   stream seq values.

Suggested table:

```sql
CREATE TABLE chat_run_timelines (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id),
  assistant_message_id TEXT,
  user_message_id TEXT,
  start_seq INTEGER NOT NULL,
  end_seq INTEGER,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  current_label TEXT,
  stop_reason TEXT,
  duration_ms INTEGER,
  cost_usd REAL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  summary_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_chat_run_timelines_session_start
ON chat_run_timelines(session_id, start_seq);

CREATE UNIQUE INDEX idx_chat_run_timelines_assistant
ON chat_run_timelines(assistant_message_id)
WHERE assistant_message_id IS NOT NULL;
```

Suggested `summary_json` shape:

```ts
type DurableRunTimelineSummary = {
  schemaVersion: 1;
  status: "working" | "completed" | "error" | "aborted" | "recovered";
  startSeq: number;
  endSeq: number | null;
  startedAt: string;
  completedAt?: string;
  currentLabel?: string;
  compact?: { trigger: "manual" | "auto"; preTokens: number };
  rateLimit?: {
    status: "allowed" | "allowed_warning" | "rejected";
    rateLimitType?: string;
    resetsAt?: string;
    utilization?: number;
  };
  mcpServers?: Array<{ name: string; status: string }>;
  tools: Array<{
    id: string;
    name: string;
    state: "running" | "result" | "error" | "aborted" | "blocked";
    isMcp: boolean;
    mcpServer?: string;
    safeInputSummary?: string;
    safeOutputSummary?: string;
    outputTruncated?: boolean;
    durationMs?: number;
    elapsedSeconds?: number;
    blockReason?: string;
  }>;
  subagents: Array<{
    taskId: string;
    toolCallId?: string;
    description: string;
    status: "running" | "completed" | "failed" | "stopped";
    summary?: string;
    lastToolName?: string;
    outputFile?: string;
    durationMs?: number;
    totalTokens?: number;
    toolUses?: number;
  }>;
  errors: Array<{
    subtype: string;
    recoverable: boolean;
    message: string;
  }>;
};
```

Persist only display-safe summaries. Do not persist raw command output, raw JSON
inputs, full fetched content, auth material, cookies, env values, private form
values, or raw thinking. `message.thinking_delta` can update safe activity like
`Thinking...`, but its text should not become default transcript metadata.

### Why Both Layers Are Needed

`chat_stream_events` alone is insufficient because:

- It is swept after 24 hours in `src/chat/sweep.ts:18-21`.
- It stores raw frame payloads, including fields like tool input and output.
- Its `message_id` column is currently not populated by `ChatSessionWriter`, and
  it is not a clean active-run identity because assistant frames can arrive
  before the referenced assistant message row exists.
- It has no run id and no uniqueness guarantee on `(session_id, seq)`.
- Replaying raw message frames into a store that already loaded committed
  messages has duplication traps.

Per-message or per-run summaries alone are insufficient because:

- They are not available until the run has enough events to summarize.
- They do not provide the exact ordered event stream needed to reconnect during
  an active run.
- They cannot recover a partial assistant answer after refresh unless the event
  tail is replayed.

The durable summary is for transcript trust. The event log is for connection
truth.

## Reconnect And Route-Load Recommendation

### Server Contract

Extend the session detail response with stream state and durable run summaries:

```ts
type SessionDetailStreamState = {
  maxSeq: number;
  latestTerminalSeq: number;
  writerActive: boolean;
  hasIncompleteTail: boolean;
};
```

`hasIncompleteTail` should be true when there are events after the latest
terminal seq or when an active writer exists. The server should be careful not
to treat benign post-terminal frames as a broken run once future post-terminal
event types exist. The more robust long-term answer is to add a run id or
assistant turn id to stream events and compute tail state by run.

Also expose durable summaries with each assistant message, or as a sibling array
keyed by `assistant_message_id`.

### Route Load Flow

1. Reset the store into a route-loading state for the session.
2. Fetch `GET /chat/sessions/:id`.
3. Render committed messages and durable run summaries immediately.
4. If `streamState.writerActive` or `streamState.hasIncompleteTail`, open
   `/chat/sessions/:id/resume`.
5. Use a replay cursor that starts at the active tail boundary, not necessarily
   `0`. The first correct boundary is `latestTerminalSeq`, with a later upgrade
   to `run_start_seq` once run ids or timeline rows exist.
6. While the resume stream is open but not caught up, show connection state as
   `reconnecting` and keep run state as whatever the durable summary or replay
   says.
7. Treat frames before `session.caught_up` as historical replay. Treat frames
   after `session.caught_up` as live.
8. Once caught up and `writer_active` was true, mark connection state as
   `attached`.
9. If replay sees a terminal event, mark the run completed, errored, or aborted
   even if no live writer remains.
10. If the stream closes while run state is still active and no terminal or
    recovery error was received, mark connection state as interrupted and ask the
    backend to resume again from the last seen seq.

### Client State Split

Do not overload `runActivity.isActive` or `isStreaming` with connection truth.
Add an explicit connection state:

```ts
type StreamConnectionState =
  | "idle"
  | "starting"
  | "reconnecting"
  | "replaying"
  | "attached"
  | "detached"
  | "interrupted";
```

Then distinguish:

- Active stream attached: `connectionState = "attached"` after
  `session.caught_up` on a resume stream with `writer_active = true`, or after a
  fresh `/chat/stream` starts delivering live frames.
- Active writer exists but stream reconnect is pending:
  `connectionState = "reconnecting"` before the resume response, then
  `"replaying"` between `session.resumed` and `session.caught_up`.
- Active writer disappeared: backend should emit a recovery error when a writer
  was active at resume start but disappears before caught up and no terminal was
  replayed. Client should show detached or interrupted rather than a spinner.
- Run completed while the page was gone: replay includes a terminal frame before
  caught up, or the durable summary is already completed. Show completed state,
  not attached streaming state.
- Replayed historical event: mark frames before `session.caught_up` as
  `source = "replay"` in the client parser. Replayed frames should rebuild
  state but should not trigger live-only UX like new-message notifications,
  aggressive auto-scroll, or "just started" animation.

## Event Ordering And Idempotency Traps

1. `user.message` is both a committed message row and a stream frame. Replaying
   it after route load must upsert by `message_id`, not append blindly.
2. `message.assistant_start` can create a partial assistant that is not yet in
   `chat_messages`. It must also upsert by `message_id` so replay does not
   duplicate a committed assistant on completed turns.
3. Text deltas are append-only. If replay is applied over a committed final
   assistant message, deltas can duplicate final text. The client needs either a
   replay-only reconstruction path for active tails or idempotent text block
   state keyed by block id and source seq.
4. `message.text_reconcile` is the canonical final correction for text blocks.
   It should win over accumulated deltas.
5. Tool progress can arrive before tool start. Phase 10A already creates safe
   placeholders, but durable summaries must merge later start, input, result,
   blocked, and aborted frames into the same tool id.
6. `message.tool_call_running` can repeat with increasing elapsed time. Summary
   logic should replace elapsed time, not append duplicate timeline items.
7. `session.resumed`, `session.caught_up`, and synthetic server restart errors
   are not persisted and do not have SSE ids. They must not advance `lastSeq`.
8. Resume frames before `session.caught_up` are historical replay even when they
   arrive over a live SSE connection. UI side effects must respect that.
9. Current backend detects incomplete tails by `maxSeq > latestTerminalSeq`.
   Future post-terminal frames would make that heuristic false-positive unless
   run ids or explicit terminal boundaries are introduced.
10. If `writerActive` is true at resume start but the writer disappears during
    replay and no terminal was replayed, current code closes without the same
    recovery error used for initially inactive incomplete tails. That would leave
    the client to infer failure from EOF.
11. `chat_stream_events` has no unique `(session_id, seq)` constraint. Builders
    should not assume the database enforces that ordering invariant.
12. `ChatSessionWriter.emitFrame` currently stores `message_id = null` in the
    event log for every frame. Builders should add a run id before relying on
    message-scoped event queries, or intentionally create durable message rows
    early enough that `message_id` is a valid foreign key.
13. Stream events are retained for 24 hours. Any test or design that claims
    completed transcripts have durable activity from only this table is wrong.
14. Aborts emit both `session.aborted` and `session.done` with stop reason
    `aborted` in `src/chat/writer.ts:139-160`. Reducers and summaries must not
    convert that double terminal into two user-visible run endings.
15. Errors emit `session.error` but do not commit an assistant message in
    `src/chat/writer.ts:161-180`. Durable timeline storage must still preserve
    the failed run evidence for the user message or synthetic assistant turn.

## Phase 10B Implementation Plan

1. Add durable run timeline storage.
   - Prefer `chat_run_timelines` with session id, user message id, assistant
     message id, start seq, end seq, status, timing, cost, tokens, and sanitized
     `summary_json`.
   - Add a typed summary builder that consumes `ChatWireFrame` plus seq and
     updates one summary idempotently.
   - Explicitly drop raw thinking, raw secrets, raw env values, full command
     output, and full tool JSON from summaries.

2. Teach the writer to build and persist summaries.
   - Start a run summary when it emits `user.message`.
   - Assign the generated assistant message id as the run id once available.
   - Update the summary for tool, compaction, MCP, subagent, rate limit, error,
     abort, and done frames.
   - Persist on every meaningful summary update or at least at terminal plus
     route-load fallback. A crash before terminal should still leave enough
     `chat_stream_events` to reconstruct within retention.

3. Improve event identity.
   - Do not blindly populate `chat_stream_events.message_id` for active
     assistant frames unless the backend first creates a placeholder assistant
     row or changes the foreign-key model.
   - Prefer adding a stable run id or assistant turn id to event payloads and
     timeline rows. User frames can still reference their committed user message.
     If Phase 10B keeps wire changes minimal, derive active-tail boundaries by
     latest terminal seq first and add run id in the next Murph contract pass.

4. Extend session detail.
   - Return durable timeline summaries with session detail.
   - Return stream state: max seq, latest terminal seq, writer active, and
     incomplete tail.
   - Keep the existing committed message shape backward-compatible.

5. Attach resume on route load.
   - After loading session detail, open resume when stream state indicates an
     active or incomplete tail.
   - Start replay from `latestTerminalSeq` initially, then from `run_start_seq -
     1` once the backend can identify the active run.
   - Pass replay/live metadata from the SSE parser into the store.

6. Make replay application idempotent.
   - Upsert `user.message` and `message.assistant_start` by message id.
   - Track text blocks by block id with replay-aware replacement rules.
   - Keep tool calls keyed by tool call id and merge repeated progress.
   - Treat terminal frames as final state transitions for a run, not as reasons
     to erase durable activity.

7. Split connection state from run state.
   - Keep `isStreaming` for input stop affordance if needed, but add a richer
     stream connection state.
   - Display "reconnecting" and "replaying" states without implying the agent is
     idle or dead.

8. Fix resume edge behavior.
   - If a writer disappears during resume replay and no terminal was replayed,
     emit the same non-persisted recovery error currently used for inactive
     incomplete tails.
   - Ensure synthetic frames do not advance seq and do not persist.

This is the smallest correct Phase 10B because it solves refresh, completed
timeline trust, and connection truth without redesigning the chat surface or
requiring new Murph progress events.

## Tests To Add

### Backend Unit And HTTP Tests

1. `ChatEventLog` or migration test for a unique `(session_id, seq)` decision.
   If uniqueness is not added, document and test deterministic drain behavior
   with duplicate seq values.
2. Writer test that persisted stream events store a valid run id, and only store
   message ids when the referenced message row exists.
3. Timeline summary builder tests for tool start, input end, repeated running,
   result success, result error, blocked, aborted, compaction, MCP status,
   subagent lifecycle, rate limit, session done, session error, and abort.
4. Privacy tests proving thinking deltas, raw env values, raw auth headers, and
   oversized tool output are not persisted in summary JSON.
5. HTTP session detail test proving committed messages include or reference run
   summaries and stream state.
6. Resume test for writer active at subscribe time, writer disappears before
   caught up, no terminal replayed, recovery error emitted.
7. Resume test proving synthetic `session.resumed`, `session.caught_up`, and
   recovery errors are not persisted and do not advance max seq.
8. Resume test proving replay starts after `client_last_seq` and live buffered
   frames are emitted once with increasing ids.
9. Recovery heuristic test for a complete run where terminal is the latest event,
   no false recovery.
10. Abort test proving `session.aborted` plus `session.done` produces one
    durable aborted timeline.

### Client Unit Tests

1. Route-load state test: committed messages plus durable timeline render without
   active SSE.
2. Route-load active-tail test: load committed user message, resume from tail,
   replay `user.message`, and do not duplicate the user message.
3. Replay partial assistant test: active run with assistant start and text deltas
   reconstructs the partial assistant after refresh.
4. Completed-while-away test: replay terminal before caught up marks run
   completed and does not show an attached live stream.
5. Reconnect-pending test: `session.resumed` with `writer_active = true` puts
   connection state into replaying or reconnecting until `session.caught_up`.
6. Attached test: after `session.caught_up` with active writer and no terminal,
   connection state becomes attached.
7. Writer-disappeared recovery test: synthetic recovery error marks the run
   interrupted or error, not active.
8. Historical replay side-effect test: replayed frames do not fire live-only
   notification or animation behavior.
9. Text idempotency test: replayed text delta does not duplicate existing
   committed final text.
10. Tool merge test: orphan running, later start, and later result collapse into
    one tool item.

### Browser Scenarios To Verify

1. Refresh immediately after send, before assistant start.
2. Refresh while a long-running tool is running.
3. Refresh while assistant text is streaming.
4. Refresh after compaction status and compact boundary.
5. Refresh while subagent progress is active.
6. Close the tab during a run, reopen after completion, see final answer and
   durable run details.
7. Drop the network during a run, reconnect, see replay then live attach.
8. Kill and restart the server during an active run, reopen, see recovery state
   instead of a dead spinner.
9. Abort during tool execution, refresh, see one aborted run timeline.
10. Open an older completed transcript after stream events have been swept, see
    persisted run summary.
11. Verify desktop and mobile route load, active reconnect, and completed run
    detail disclosure.

## Anti-Patterns To Avoid

1. Do not make `chat_stream_events` the only durable transcript timeline while
   retaining the 24-hour sweep.
2. Do not persist raw chain-of-thought or raw thinking deltas.
3. Do not persist raw command output or raw tool JSON as default transcript
   metadata.
4. Do not show historical replay as live work.
5. Do not infer connection state from `runActivity.isActive` alone.
6. Do not append replayed `user.message` or `message.assistant_start` blindly
   after route load.
7. Do not treat EOF from SSE as successful run completion.
8. Do not add Phantom-only shortcuts to Murph or the runtime contract.
9. Do not block Phase 10B on richer Murph tool metadata. Use current frames and
   leave optional enrichment to Phase 10C.
10. Do not hide a server restart or disappeared writer behind "Working...".
11. Do not trust agent summaries or prior notes instead of current files.
12. Do not expand the scope into a full chat redesign, artifact tray, or mobile
    sheet polish. This phase is correctness and durability.

## Direct Answers To The Prompt Questions

1. Already durable: sessions, committed user messages, committed successful
   assistant messages, token and cost totals, attachments, and stream events for
   roughly 24 hours. Stream events are durable across refresh and restart within
   retention, but not permanent transcript history.
2. Only in memory: active writers, abort controllers, translation context,
   stream bus subscribers, live resume buffers, SSE heartbeat state, client run
   activity, active tool calls, thinking blocks, text block maps, connection
   state, and `lastSeq`.
3. `/resume` emits a synthetic resumed frame, replays persisted events after the
   client seq, buffers live frames during replay if a writer is active, emits a
   synthetic caught-up frame, then either attaches live with heartbeat or closes
   after replay.
4. Route load does not provide durable activity because it only fetches committed
   messages. It never calls resume, and committed messages do not include run
   timelines.
5. Phantom should use both `chat_stream_events` and persisted summaries. Events
   are for exact active replay. Summaries are for safe durable transcripts.
6. The smallest correct Phase 10B is durable sanitized summaries, session detail
   stream state, route-load resume for active tails, idempotent replay, and
   explicit connection state.
7. The client should distinguish attached, reconnecting, disappeared, completed
   while away, and historical replay using `session.resumed`, `session.caught_up`,
   terminal frames, stream EOF, and explicit replay metadata in the parser.
8. The main traps are duplicate messages, duplicate text deltas, repeated tool
   progress, double terminal abort frames, synthetic no-id frames, incomplete
   tails, false recovery after post-terminal events, and event retention.
9. Add backend timeline, resume edge, and privacy tests plus client route-load,
   replay idempotency, connection state, and tool merge tests.
10. Verify refresh, close/reopen, network drop, server restart, abort, compaction,
    subagents, completed transcripts after event sweep, and desktop/mobile UI.

## Builder Prompt Seed

```text
ultrathink. ultrathink. ultrathink.

You are a principal engineer, principal architect, AND principal product manager
at Anthropic, all three at once. You are implementing Phase 10B durable run
timelines and reconnect correctness for Phantom chat on Murph.

No context anxiety. No token limits. No time pressure. No cost anxiety. No "v2"
thinking. There is no v2. Build it right. Take as long as you need.

Read:

1. /Users/truffle/.claude/AGENTS.md
2. /Users/truffle/.claude/CLAUDE.md
3. research/chat-experience/phase-10a-synthesis.md
4. research/chat-experience/phase-10b-durable-timeline-research.md
5. src/chat/http-handlers.ts
6. src/chat/http.ts
7. src/chat/event-log.ts
8. src/chat/writer.ts
9. src/chat/sse.ts
10. src/chat/stream-sse.ts
11. src/chat/message-store.ts
12. src/chat/session-store.ts
13. src/chat/sdk-to-wire.ts
14. src/chat/sdk-to-wire-handlers.ts
15. src/db/schema.ts
16. chat-ui/src/hooks/use-chat.ts
17. chat-ui/src/lib/client.ts
18. chat-ui/src/lib/chat-store.ts
19. chat-ui/src/lib/chat-activity.ts
20. chat-ui/src/lib/chat-dispatch-tools.ts
21. chat-ui/src/routes/session-route.tsx
22. chat-ui/src/components/message-list.tsx
23. Current tests under src/chat/__tests__ and chat-ui/src/lib/__tests__.

Mission:

Build the smallest correct Phase 10B. Persist sanitized per-run timeline
summaries for completed transcripts, keep `chat_stream_events` as the ordered
active replay log, attach resume on route load for active or incomplete tails,
and make replay idempotent in the client. Separate stream connection state from
run activity state so refresh, reconnect, server restart, completion while away,
and historical replay are not conflated.

Acceptance criteria:

1. Completed successful, errored, and aborted turns have durable safe timeline
   summaries after stream events are swept.
2. Refresh during an active run reloads committed messages, replays the active
   event tail without duplicate messages, reconstructs partial assistant text,
   and attaches to live frames after caught up.
3. Refresh after completion shows final answer plus run details without opening
   a fake live state.
4. Server restart or disappeared writer with incomplete tail produces an
   explicit recovery state, not a dead spinner.
5. Replayed historical frames are marked as replay in the client and do not
   trigger live-only UX.
6. No raw chain-of-thought, raw secrets, raw env values, raw auth headers, full
   command output, or full tool JSON are persisted in default timeline summaries.
7. Tests cover backend summaries, resume race cases, privacy redaction, client
   route-load replay, idempotency, and connection states.
8. TypeScript stays strict. No explicit any, no @ts-ignore, no hidden type
   escapes.

Anti-patterns:

1. Do not use only `chat_stream_events` for durable transcript history while the
   24-hour sweep exists.
2. Do not append replayed messages blindly.
3. Do not treat SSE EOF as successful completion.
4. Do not show replayed historical events as live work.
5. Do not persist raw thinking or raw tool output by default.
6. Do not redesign the whole chat UI or block on Phase 10C Murph enrichment.
7. Do not add Phantom-only hacks to Murph.

Deliverables:

1. Schema and store changes for durable sanitized run timelines.
2. Server session detail stream state and timeline summary response.
3. Route-load resume flow for active or incomplete tails.
4. Idempotent replay-aware client reducers.
5. Explicit client stream connection state.
6. Tests and a concise handoff with verification commands.
```
