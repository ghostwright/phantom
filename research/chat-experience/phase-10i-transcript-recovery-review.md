# Phase 10I Transcript Recovery Review

Date: 2026-05-01

## Summary

No P0 or P1 findings.

I found two P2 findings that should be fixed before commit. The slice is pointed in the right direction: it keeps Murph generic, injects only a small current chat context, returns per-entry `session_id` and `citation` fields, and gives the agent a bounded SQLite-backed transcript tool. The current implementation is not yet production-safe because the tool does not fully enforce the chat session lifecycle and its redaction/extraction path can still expose credential-shaped or raw structured payloads.

## Findings

### P2: Transcript search misses the real soft-delete lifecycle and trusts any supplied active chat session id

Files:

- `src/chat/transcript-search.ts:108`
- `src/agent/in-process-reflective-tools.ts:180`

The latest implementation adds an `EXISTS` guard for `chat_sessions.status != 'deleted'`, and the new unit test covers that status value. That does not match the actual app delete path. `ChatSessionStore.softDelete` sets `deleted_at` and leaves `status` unchanged, while normal session reads and lists filter on `deleted_at IS NULL`. A local check against the current code showed a soft-deleted session still returns transcript rows through `searchChatTranscript`.

The MCP tool also accepts an arbitrary `session_id` string from the model and passes it directly into the search service. If the agent has or recovers another active chat id, it can search that transcript even though the tool contract says to use the current chat session id.

Impact: a soft-deleted chat remains searchable until hard deletion. Unrelated active chat ids are also not rejected. This violates the research requirement to respect deleted sessions and weakens the "current session" boundary.

Suggested fix: change the session guard to require `chat_sessions.deleted_at IS NULL`, and keep or add the status check if status-level deletion is still meaningful. Ideally pass the current chat session id into the in-process transcript tool factory for chat runs and reject mismatched session ids unless a future explicitly privileged all-session scope is added.

### P2: Redaction and structured extraction are too narrow for a transcript recovery trust boundary

Files:

- `src/chat/transcript-search.ts:59`
- `src/chat/transcript-search.ts:192`
- `src/chat/transcript-search.ts:234`

The redaction patterns cover the tested magic link, `sk-` token, bearer/basic auth, a few key names, and long contiguous base64. They miss common secrets already handled elsewhere in the repo, including AWS access keys, PEM private keys, and line-wrapped base64. A quick local check showed `redactSensitiveText("AWS AKIAABCDEFGHIJKLMNOP")` and a small PEM private key block are returned unchanged.

The extractor also falls back to `stableStringify(value)` for any unrecognized object. That means a future or malformed persisted content object with fields such as `source.data`, attachment bytes, secret fields, or hidden protocol payloads can be dumped wholesale into tool output.

Impact: the agent tool can leak API keys, private keys, raw base64, or attachment-like payloads despite the tool description promising safe redaction. This is especially risky because the output is intended to be pasted back into provider context.

Suggested fix: move the stronger redaction logic from `src/chat/run-timeline.ts` into a shared helper and use it here. Add PEM, AWS key, cookie, wrapped base64, and auth-query coverage. Change extraction to an allow-list: known text fields and attachment summaries only, with unknown objects summarized as `[structured content omitted]` instead of raw JSON.

## Lower Priority Follow-ups

### P3: Query search is bounded but may miss older compacted details

When `query` is present, the service scans only the latest 2000 candidate rows in descending seq order. That is a reasonable safety bound for the first slice, but a very long chat can still fail to recover the exact older detail that compaction removed. Consider documenting this limit in the tool response or adding a cursor strategy.

### P3: Test gaps

The focused tests now cover per-entry citations and `status = 'deleted'`, but not the real `ChatSessionStore.softDelete` path. They also do not cover mismatched session ids, private keys, AWS keys, line-wrapped base64, unknown structured content, or the full chat query boundary proving the transcript tool remains available on the Murph path while the session id reaches `transformContext`.

## Review Questions

1. Production-safe transcript recovery after Murph compaction: partially implemented, but not until the two P2 findings are fixed.
2. Current session id without provider bloat: yes for Murph. The context is small and goes through `transformContext`, not the system prompt. Non-Murph fallback still appends the same small block to the prompt.
3. Agent tool bounded, cited, redacted enough: bounded mostly yes. Cited yes for committed message rows through `chat:<session_id>#msg:<seq>`. Redacted no.
4. Leakage risk: magic links in the tested form are redacted. API keys, private keys, wrapped base64, and unknown structured payloads can leak.
5. Query, role, seq window, and limit behavior: generally correct. Role and seq filters are exclusive as described. Limits clamp to 1 through 50. Query is simple case-insensitive phrase or all-token matching over the newest bounded candidate rows.
6. Murph or Pi misuse: no. The slice keeps Phantom chat semantics in Phantom and uses Murph's existing context transform seam.
7. Blocking P0, P1, P2 issues: two P2 findings above.
8. Non-blocking follow-ups: P3 items above.

## Verification

- `bun test src/chat/__tests__/transcript-search.test.ts src/chat/__tests__/continuity-context.test.ts src/agent/__tests__/reflective-transcript-tools.test.ts`: pass, 13 tests.
- `bun run lint`: pass.
- `bun run typecheck`: pass.
