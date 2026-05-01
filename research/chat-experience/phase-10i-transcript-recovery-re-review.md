# Phase 10I Transcript Recovery Re-review

Date: 2026-05-01

## Findings

### P2: Attachment metadata bypasses transcript redaction

Files:

- `src/chat/transcript-search.ts:85`
- `src/chat/transcript-search.ts:208`
- `src/chat/transcript-search.ts:228`

The prior redaction finding is mostly fixed for snippet text, unknown structured
objects, private keys, AWS keys, cookies, magic links, auth query values, and
large or line-wrapped base64. However, transcript output still includes the
`attachments` metadata array from `attachmentSummary` without applying the
shared redaction helper to `filename` or `mime_type`.

I verified this with an adversarial local check. A transcript attachment named
`AKIAABCDEFGHIJKLMNOP.pdf` produced a redacted snippet:
`[attachment: [REDACTED_AWS_KEY].pdf application/pdf] alpha`, but the same tool
result also returned:

```json
"attachments": [
  {
    "filename": "AKIAABCDEFGHIJKLMNOP.pdf",
    "mime_type": "application/pdf",
    "size_bytes": 1
  }
]
```

Impact: credential-shaped values can still leak through the transcript recovery
tool output even though the snippet path is redacted. This violates the
transcript trust boundary because the full JSON tool result is intended to be
pasted back into provider context.

Suggested fix: apply `redactSensitiveText` to attachment metadata fields before
returning them, at minimum `filename` and `mime_type`, and add a regression test
that proves credential-shaped attachment metadata is redacted in both the
snippet and the `attachments` array.

## Previous P2 Re-review

1. Soft-delete lifecycle: fixed for the real `ChatSessionStore.softDelete` path.
   `searchChatTranscript` now guards on `chat_sessions.deleted_at IS NULL`, and
   the test uses `new ChatSessionStore(db).softDelete("chat-1")`.
2. Current-session restriction: fixed at the MCP tool layer. The reflective tool
   receives `currentChatSessionId` from the chat MCP factory context and rejects
   mismatched or unbound `session_id` values before querying.
3. MCP factory context: preserved for existing factories. The new factory
   signature accepts optional context, and existing zero-argument factories
   remain valid. The main runtime path still passes MCP servers through, and the
   focused boundary test passes.
4. Structured extraction: fixed for unknown objects and attachment payloads.
   Unknown structured objects now return `[structured content omitted]`, and
   attachments are summarized instead of returning payload bytes. The metadata
   redaction gap above remains.
5. Shared redaction helper and durable timeline behavior: preserved by the
   focused run timeline tests.
6. Tests: adequate for the original soft-delete path, bound-session rejection,
   known snippet redaction, unknown structured omission, and durable timeline
   redaction. Missing coverage for redaction of attachment metadata in the
   returned `attachments` array.

## Verification

- `bun test src/chat/__tests__/transcript-search.test.ts src/chat/__tests__/continuity-context.test.ts src/agent/__tests__/reflective-transcript-tools.test.ts src/chat/__tests__/run-timeline.test.ts src/agent/__tests__/agent-sdk-boundary-callers.test.ts src/agent/__tests__/murph-context.test.ts`: pass, 41 tests, 0 fail.
- `bun run lint`: pass, Biome checked 389 files with no fixes applied.
- `bun run typecheck`: pass, `tsc --noEmit`.
- Additional adversarial check with `bun -e`: confirmed credential-shaped
  attachment filenames are redacted in `snippet` but leaked raw in the returned
  `attachments` array.

## Verdict

No P0 or P1 findings.

One P2 finding remains. The previous soft-delete and bound-session P2 is fixed,
but the redaction P2 is not fully resolved because attachment metadata bypasses
redaction.
