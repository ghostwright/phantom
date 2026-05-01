# Phase 10I Transcript Recovery Implementation

Date: 2026-05-01

## Goal

Make Phantom on Murph able to recover compacted current-chat facts without
turning durable transcript history into long-term user memory or leaking raw
structured payloads back into provider context.

## Shipped Behavior

1. Phantom now injects a compact current-chat context block on every web chat
   run. The block includes the current Phantom chat session id and instructs
   the agent to call `phantom_chat_transcript_search` when an older detail is
   missing after Murph compaction.
2. The in-process `phantom-reflective` MCP server now exposes
   `phantom_chat_transcript_search` only inside a bound Phantom web chat run.
   The tool rejects unbound calls and rejects any `session_id` other than the
   current chat session id.
3. The runtime MCP factory seam now receives lightweight run context:
   `sessionKey`, `channelId`, `conversationId`, and `chatSessionId` for web
   chat runs. Existing no-argument factories remain compatible.
4. Transcript search reads committed `chat_messages` rows from SQLite with
   query, role, sequence window, and limit controls. Results include
   `session_id`, `seq`, `role`, `created_at`, `status`, citation, snippet, and
   attachment metadata.
5. Transcript search respects both `chat_sessions.status != 'deleted'` and
   the real `deleted_at IS NULL` soft-delete lifecycle.
6. Transcript snippets use a shared chat redaction helper also used by durable
   run timelines. It redacts magic links, auth headers, secret-like query
   parameters, AWS keys, private keys, cookie/header secrets, and large or
   line-wrapped base64 blobs.
7. Transcript extraction is allow-list based. Known text and attachment blocks
   are summarized. Unknown structured objects return
   `[structured content omitted]` instead of raw JSON.
8. Attachment metadata returned by transcript search is redacted through the
   same helper, so credential-shaped filenames and MIME labels cannot bypass
   snippet redaction.

## Files Changed

- `src/agent/mcp-server-factory.ts`
- `src/agent/runtime.ts`
- `src/agent/chat-query.ts`
- `src/agent/in-process-reflective-tools.ts`
- `src/chat/continuity-context.ts`
- `src/chat/transcript-search.ts`
- `src/chat/redaction.ts`
- `src/chat/run-timeline.ts`
- `src/chat/__tests__/continuity-context.test.ts`
- `src/chat/__tests__/transcript-search.test.ts`
- `src/agent/__tests__/reflective-transcript-tools.test.ts`

## Reviewer Findings Addressed

1. P2 soft-delete and arbitrary session search:
   fixed by adding `deleted_at IS NULL` to the transcript query guard and
   threading current web chat session id into the reflective MCP tool factory.
   The tool now rejects mismatched or unbound session ids before querying.
2. P2 redaction and structured extraction:
   fixed by moving timeline redaction into `src/chat/redaction.ts`, extending it
   for transcript needs, and replacing raw unknown-object stringification with
   an omission sentinel.
3. P2 attachment metadata redaction:
   fixed by redacting returned `filename` and `mime_type` fields in
   transcript attachment summaries. Final re-review found no P0, P1, or P2
   findings.

## Verification

- `bun test src/chat/__tests__/transcript-search.test.ts src/chat/__tests__/continuity-context.test.ts src/agent/__tests__/reflective-transcript-tools.test.ts src/chat/__tests__/run-timeline.test.ts src/agent/__tests__/agent-sdk-boundary-callers.test.ts src/agent/__tests__/murph-context.test.ts`: pass, 42 tests.
- `bun run lint`: pass.
- `bun run typecheck`: pass.
- `bun test`: pass, 2112 pass, 10 skip, 1 todo, 0 fail.
- `cd chat-ui && bun test`: pass, 27 tests.
- `cd chat-ui && bun run typecheck`: pass.
- `cd chat-ui && bun run build`: pass with existing font resolution and chunk
  size warnings.

## Remaining Follow-ups

1. Query search still scans only the newest 2000 candidate transcript rows.
   This is acceptable for the first recovery primitive but should become a
   cursor or FTS strategy if real conversations exceed the bound often.
2. Page and file artifact facts should become durable first-class records so
   links survive event-log sweeps without relying on transcript search.
3. The next UI slice should default tool cards collapsed after completion,
   keep active tool cards readable while running, and expose a clearer run
   timeline for long-running tasks.
