# Phase 10I Transcript Search Research

Date: 2026-05-01

Scope: research only. No application code changes.

## Executive Recommendation

Build a small SQLite-backed transcript lookup tool for the agent. Do not use
Qdrant for this first slice.

The first production slice should expose one in-process MCP tool,
`phantom_transcript_search`, backed by a shared `src/chat/transcript-search.ts`
service. The default scope should be the current web chat session. The tool
should return compact, redacted snippets cited by `session_id`, `message_seq`,
and, when relevant, `stream_seq` or run timeline id.

Keep the existing injected continuity context, but limit it to tiny high-value
facts that the agent should almost always have without asking, such as recent
page artifacts and compaction checkpoints. Do not inject arbitrary transcript
search results into every prompt. Exact recall should be agent-initiated through
the tool.

SQLite is the right store for this slice because the exact web chat transcript
already lives in SQLite. Qdrant memory is useful for semantic memory, patterns,
and long-term summaries, but it is not a reliable source for exact transcript
details. Current Qdrant consolidation is heuristic, optional, and not wired as
the canonical store for web chat transcript turns. A vector system would add
more moving parts while still requiring a safe SQLite source of truth.

The most important boundary: `chat_stream_events` has useful detail, including
tool inputs, tool result previews, and compaction boundaries, but it is swept
after 24 hours by `src/chat/sweep.ts`. Durable exact recall must rely first on
`chat_messages`, `chat_attachments`, and `chat_run_timelines`, plus a new
durable safe transcript index for selected event-derived facts that must
survive event-log sweep.

The smallest valuable implementation is:

1. Add a safe transcript search service over current durable chat tables.
2. Add `phantom_transcript_search` as an in-process MCP tool available to the
   agent in every chat query.
3. Persist safe artifact/search chunks for page artifacts at run time so page
   URLs do not disappear when `chat_stream_events` is swept.
4. Teach the prompt to use the tool for exact earlier wording, prior user
   details, old artifact URLs, and post-compaction recall.

This is a product trust feature. The user should be able to ask "what did I say
earlier?" after compaction, reload, or process restart, and the agent should
recover the answer without asking the user to manually search.

## Current Persistence Model

### Durable committed messages

`src/chat/message-store.ts` stores committed rows in `chat_messages`:

- `session_id`
- numeric message `seq`
- `role`
- `content_json`
- status, stop reason, model, cost, token counts, and error fields

This is the highest-fidelity durable source for committed user and assistant
turns. `ChatSessionWriter` commits user rows before invoking the runtime and
assistant rows only after successful completion. Current writer tests verify
that non-success SDK results do not commit a fake successful assistant message.

For user attachments, current code stores safe transcript metadata, not raw
payloads. `src/chat/message-builder.ts` builds SDK-native messages with base64
or text payloads for the provider, but `ChatSessionWriter` commits only
attachment metadata plus the user text into `chat_messages.content_json`.
`src/chat/__tests__/writer.test.ts` verifies that raw base64 is not persisted in
the transcript row.

Limitations:

- Assistant rows currently persist final response text, not the complete
  interleaving of text, tool calls, and thinking.
- Thinking deltas must not be part of transcript lookup.
- Raw attachment payloads live on disk under chat attachment storage and should
  never be read by transcript search.

### Durable chat sessions and attachments

`src/db/schema.ts` defines `chat_sessions`, `chat_messages`,
`chat_attachments`, `chat_stream_events`, and `chat_run_timelines`.

`src/chat/session-store.ts` soft-deletes chat sessions and hard-deletes deleted
sessions after 30 days. Hard delete removes timelines, stream events,
attachments, messages, and the session row. Transcript search should respect
this lifecycle.

`src/chat/attachment-store.ts` persists attachment metadata and storage paths.
Search should expose filename, MIME type, size, and message linkage only. It
should not dereference `storage_path`.

### Stream event log

`src/chat/event-log.ts` stores every SSE frame in `chat_stream_events` with:

- `session_id`
- optional `message_id`
- stream `seq`
- `event_type`
- raw `payload_json`
- `created_at`

This table has enough fidelity for recent replay and recent continuity:

- streamed text deltas
- tool call starts
- tool call inputs
- tool result previews and truncated outputs
- compaction boundaries
- MCP status
- run status and errors

`src/chat/continuity-context.ts` already uses this event log to recover page
artifacts from `phantom_create_page` and `phantom_preview_page`, while excluding
`phantom_generate_login` auth links. It also includes recent compaction
checkpoints.

The problem is durability. `src/chat/sweep.ts` deletes stream events older than
24 hours. That is correct for replay storage, but it means the event log cannot
be the only source for historical transcript lookup. Event-derived facts that
matter after 24 hours need to be copied into a durable safe index or represented
in durable run timelines.

### Durable run timeline

`src/chat/run-timeline.ts` stores a compact safe run summary in
`chat_run_timelines`. It already redacts many credential shapes, drops raw
thinking, avoids raw command output, tracks tools and subagents, and persists
compaction metadata.

This is useful for search, especially for tool names, safe input summaries,
safe output summaries, subagent summaries, errors, and compaction boundaries.
It is not enough for exact artifact recovery today because page tool outputs
are summarized as generic "Tool produced output." rather than persisted as
first-class artifacts.

### Murph compaction and replay

`/Users/truffle/work/murph/packages/core/src/query/query.ts` and
`/Users/truffle/work/murph/packages/core/src/query/session-replay.ts` show that
Murph compaction affects provider context and future replay, not Phantom's
SQLite chat store. Murph writes compact checkpoints and future replay starts
from the latest compact summary. That is correct for provider context health,
but it means Phantom must provide a separate exact lookup path for compacted-out
details.

`/Users/truffle/work/murph/packages/core/src/substrate/pi-harness.ts` passes
`transformContext` through to Pi, and Phase 10G already uses that seam for
small host facts. Transcript search should use tools for exact lookup, not
try to stuff all prior detail into `transformContext`.

### Qdrant memory

`src/memory/system.ts`, `src/memory/consolidation.ts`, and
`src/memory/context-builder.ts` show that Qdrant memory is optional, dependent
on Qdrant and Ollama health, and stores episodes, facts, and procedures. The
current consolidation path creates heuristic episodes and facts from session
summaries. It is not the exact web chat transcript.

Therefore Qdrant should remain a semantic memory layer. Transcript lookup
should use SQLite.

## Proposed Transcript Search Contract

### Agent tool

Add an in-process MCP tool named `phantom_transcript_search`.

Suggested description:

```text
Search the durable Phantom chat transcript for exact earlier user messages,
assistant replies, safe tool/artifact summaries, and attachment metadata. Use
this when the user asks about something earlier in this chat, when compaction
may have removed details from provider context, or when you need the exact URL,
filename, sequence, wording, or prior answer. Results are redacted and safe to
quote, with session and sequence citations.
```

Suggested input schema:

```ts
{
  query?: string;
  scope?: "current_session" | "all_sessions";
  session_id?: string;
  roles?: Array<"user" | "assistant" | "tool" | "system">;
  kinds?: Array<
    | "message"
    | "attachment"
    | "artifact"
    | "tool_input"
    | "tool_result"
    | "compaction"
    | "error"
  >;
  since?: string;
  until?: string;
  seq_from?: number;
  seq_to?: number;
  artifact_only?: boolean;
  limit?: number;
}
```

Defaults:

- `scope`: `current_session`
- `session_id`: injected by the tool server from the active chat session when
  scope is `current_session`
- `roles`: user, assistant, tool
- `kinds`: message, attachment, artifact, tool_input, tool_result, compaction,
  error
- `limit`: 10, max 25

For `all_sessions`, require at least one of `query`, `since`, `until`, or
`artifact_only`, and default to a recent bounded window such as 30 days when no
explicit date window is supplied. This prevents accidental whole-database scans.

Suggested output:

```ts
{
  query: string | null;
  scope: "current_session" | "all_sessions";
  results: Array<{
    session_id: string;
    message_seq?: number;
    stream_seq?: number;
    run_id?: string;
    role: "user" | "assistant" | "tool" | "system";
    kind: string;
    created_at: string;
    citation: string;
    snippet: string;
    metadata?: {
      tool_name?: string;
      attachment_id?: string;
      filename?: string;
      mime_type?: string;
      size_bytes?: number;
      url?: string;
      path?: string;
    };
    redacted: boolean;
  }>;
  warnings: string[];
}
```

Citation format should be deterministic and compact:

- `chat:<session_id>#msg:<seq>` for committed message rows
- `chat:<session_id>#stream:<seq>` for safe event-derived entries
- `chat:<session_id>#run:<run_id>` for run timeline summaries

### Search sources

For the first slice, search these durable sources:

1. `chat_messages`
   - user text
   - assistant final text
   - attachment metadata blocks in `content_json`

2. `chat_run_timelines`
   - status
   - compaction metadata
   - safe tool input/output summaries
   - safe subagent summaries
   - safe error summaries

3. A new durable safe artifact/search chunk table
   - page URLs and paths from `phantom_create_page`
   - preview metadata from `phantom_preview_page`
   - future first-class artifacts

`chat_stream_events` may be used as a recent fallback and as the source for
building artifact chunks, but it should not be the only durable search source
because it is swept after 24 hours.

### SQLite approach

SQLite is enough. Prefer a safe transcript index table in SQLite, optionally
with FTS5. I verified Bun's SQLite build supports FTS5 locally.

The safest first implementation is:

- Extract safe searchable chunks in TypeScript.
- Store only redacted, compact text in a new durable table.
- Query with SQLite FTS5 if the table is materialized, or with bounded LIKE
  over extracted durable rows for the narrow first slice.
- Never index raw attachment bytes, raw thinking, raw secret tool outputs, or
  magic login tokens.

FTS5 is an implementation detail, not a product requirement. The product
contract is safe cited lookup. If FTS5 makes the implementation harder, bounded
SQLite scans over durable rows are acceptable for the first PR because the
default scope is a single chat session and result limits are small.

### Tool versus continuity versus API

Use all three surfaces over time, but not all in the first slice.

First slice:

- Agent tool: yes. This is the main product behavior. The agent should recover
  details without asking the user to search.
- Injected continuity summary: keep it, but narrow. Use it for recent page
  artifacts and compaction checkpoints only.
- User-visible API: not required. Do not force manual search into the product
  path.

Later slice:

- Add an authenticated `/chat/sessions/:id/search` API and UI search panel if
  the chat UI needs manual search. That should call the same service as the
  tool.

## Safety And Redaction Model

Transcript lookup must be safe to paste directly into model context.

Rules:

1. Never read attachment storage files.
   Search returns attachment metadata only: filename, MIME type, size, and
   message citation.

2. Never return thinking deltas.
   Exclude `message.thinking_start`, `message.thinking_delta`, and
   `message.thinking_end` from search chunks.

3. Never return raw login links or magic tokens.
   Exclude `phantom_generate_login` outputs and redact `/ui/login?...` URLs.
   Keep the Phase 10G distinction between page URLs and auth URLs.

4. Never return secret tool values.
   Exclude `phantom_get_secret` values and `phantom_collect_secrets` payloads.
   If a secret-related tool appears, return only that a secret workflow
   happened, not field values or magic links.

5. Redact credential-shaped text everywhere.
   Move the existing redaction logic from `src/chat/run-timeline.ts` into a
   shared chat redaction helper and apply it to message snippets, tool input
   summaries, tool output summaries, errors, URLs, paths, and metadata.

6. Prefer summaries over raw tool output.
   Use `chat_run_timelines.summary.tools[].safeOutputSummary` for tools. Do not
   dereference `full_ref`. Do not expose `output` from raw stream events except
   through a strict artifact parser and redactor.

7. Bound result size.
   Snippets should be short, for example 240 to 500 characters. Tool result
   summaries should be even shorter. `limit` should max at 25.

8. Include redaction signals.
   Every result should carry `redacted: true` if the snippet or metadata passed
   through redaction and changed.

9. Respect deleted sessions.
   Search must ignore `chat_sessions.deleted_at IS NOT NULL` and must not
   return rows for hard-deleted sessions.

10. Treat broad all-session search as privileged and bounded.
    The in-process tool is only available to the agent running inside the
    owner's Phantom process, but it should still require a query or date window
    for all-session searches.

## Test Plan

### Unit tests for the search service

Add `src/chat/__tests__/transcript-search.test.ts`.

Cases:

1. Searches current-session user and assistant `chat_messages` by exact canary
   text and returns `chat:<session_id>#msg:<seq>`.
2. Supports `roles`, `seq_from`, `seq_to`, `since`, `until`, and `limit`.
3. Ignores deleted sessions.
4. Returns attachment metadata from user transcript content and does not read
   or return raw attachment payloads.
5. Searches durable run timeline summaries for safe tool names, safe input
   summaries, compaction checkpoints, and errors.
6. Redacts API keys, bearer tokens, cookies, private keys, magic tokens, and
   auth query parameters from snippets and metadata.
7. Excludes thinking deltas entirely.
8. Excludes `phantom_generate_login` magic links while preserving safe
   `/ui/<path>` artifact URLs.
9. Keeps working after `eventLog.sweep(24)` by finding committed messages and
   durable artifact chunks, not relying only on `chat_stream_events`.

### Tool server tests

Add `src/agent/__tests__/transcript-tools.test.ts` or extend a focused
in-process MCP test.

Cases:

1. `phantom_transcript_search` returns JSON with compact cited results.
2. Current-session scope injects the active chat session id and refuses to
   search an unrelated session unless `scope: "all_sessions"` is explicit.
3. `limit` is capped.
4. Broad all-session search without query/date/artifact filter returns a clean
   validation error.

### Chat writer and artifact tests

Extend `src/chat/__tests__/writer.test.ts` or add a focused index test.

Cases:

1. User message commit writes a durable searchable chunk.
2. Assistant successful commit writes a durable searchable chunk.
3. Non-success SDK result does not write an assistant success chunk.
4. `phantom_create_page` and `phantom_preview_page` events produce durable safe
   artifact chunks.
5. `phantom_generate_login` events do not produce artifact chunks.

### Agent boundary tests

Extend `src/agent/__tests__/agent-sdk-boundary-callers.test.ts`.

Cases:

1. Chat query path includes the transcript tool server in `mcpServers`.
2. Stale resume retry recreates the transcript tool server factory, matching
   the current factory pattern for in-process MCP servers.
3. Murph chat queries still receive continuity via `transformContext`, and the
   transcript tool remains available as an MCP server.

### Post-compaction recovery test

Add a deterministic backend test that does not depend on model judgment:

1. Seed a chat session with an early user message containing a unique canary.
2. Add enough later transcript rows and a `session.compact_boundary` event to
   represent compaction.
3. Invoke `phantom_transcript_search` with the current session id and the canary
   query.
4. Assert the result returns the canary with a `chat:<session_id>#msg:<seq>`
   citation.

Then add one live verification for the full behavior:

1. Run Phantom locally with `PHANTOM_AGENT_RUNTIME=murph` and a small context
   model or aggressive auto-compaction settings.
2. Put a unique early detail in chat, such as `PHASE10I_CANARY_<timestamp>`.
3. Force a long enough interaction to emit a compaction boundary.
4. Ask "what was the canary I gave you earlier?"
5. Verify the answer recovers the detail and the run timeline shows the
   transcript search tool call after compaction.

## Builder Slice Proposal

### Scope

One PR should implement exact, safe, current-session transcript lookup for
committed messages, attachment metadata, durable run summaries, and page
artifacts. All-session search can be included if bounded and using the same
service, but it should not expand into a full UI search product.

### Likely files touched

Production files:

1. `src/db/schema.ts`
   - Optional: add `chat_transcript_entries` and `chat_transcript_entries_fts`.
   - If the builder chooses bounded on-demand search first, this file may not
     need to change.

2. `src/chat/transcript-search.ts`
   - New shared service.
   - Parses durable message rows, run timeline summaries, and safe artifact
     entries.
   - Applies filtering, matching, redaction, snippet building, and citation
     formatting.

3. `src/chat/transcript-redaction.ts`
   - New shared redaction helper, extracted from current run timeline logic.
   - Used by transcript search and, ideally, by `run-timeline.ts` after a
     narrow refactor.

4. `src/chat/run-timeline.ts`
   - Import shared redaction helper.
   - No behavioral change except shared implementation.

5. `src/chat/continuity-context.ts`
   - Reuse safe artifact extraction helpers or read durable artifact chunks so
     page continuity does not depend only on 24-hour stream events.

6. `src/agent/in-process-transcript-tools.ts`
   - New in-process MCP server factory for `phantom_transcript_search`.
   - Keeps transcript lookup separate from reflective memory, which currently
     exposes `phantom_memory_search` and `phantom_list_sessions`.

7. `src/index.ts`
   - Register the new factory, for example `"phantom-transcript"`.

8. `src/agent/prompt-assembler.ts`
   - Add short guidance: use `phantom_transcript_search` for exact earlier chat
     wording, prior user details, artifact URLs, filenames, and post-compaction
     recall.

9. `src/chat/writer.ts`
   - If using a materialized durable index, write user, assistant, and artifact
     chunks at commit time.
   - If using on-demand search, no change needed except possibly wiring a
     transcript search dependency into the tool server.

Test files:

1. `src/chat/__tests__/transcript-search.test.ts`
2. `src/agent/__tests__/transcript-tools.test.ts`
3. `src/chat/__tests__/writer.test.ts`
4. `src/chat/__tests__/continuity-context.test.ts`
5. `src/chat/__tests__/run-timeline.test.ts`
6. `src/agent/__tests__/prompt-assembler.test.ts`
7. `src/agent/__tests__/agent-sdk-boundary-callers.test.ts`

### Acceptance criteria

1. After compaction, an agent tool call can recover an exact earlier user detail
   from the current chat session with a session and sequence citation.
2. Search works after browser reload and process restart because it reads
   durable SQLite data.
3. Search does not depend on Qdrant, Ollama, provider memory, or raw provider
   context.
4. Search results never include raw attachment payloads, thinking deltas,
   secret values, magic login links, or large raw tool outputs.
5. Page artifacts from `phantom_create_page` and `phantom_preview_page` are
   recoverable as page URLs, while `phantom_generate_login` remains excluded.
6. Broad searches are bounded by scope, date, role, sequence, kind, and limit.
7. Existing continuity context keeps working and can eventually be backed by
   the same safe artifact extraction contract.

### Anti-patterns to avoid

1. Do not use Qdrant as the exact transcript source.
2. Do not inject large transcript search results into every prompt.
3. Do not expose a manual-only UI search path and call the feature done.
4. Do not read attachment files during transcript lookup.
5. Do not return raw `payload_json` from `chat_stream_events`.
6. Do not rely on `chat_stream_events` for history older than 24 hours.
7. Do not treat auth links as page artifacts.
8. Do not add a generic data dump tool. This is a narrow safe recall tool.
