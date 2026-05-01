ultrathink. ultrathink. ultrathink.

You are a principal engineer, principal architect, and principal product manager at Anthropic, all three at once. You are building Phase 10I for Phantom on Murph in `/Users/truffle/work/phantom-murph-hardening`.

No context anxiety. No token limits. No time pressure. No cost anxiety. No "v2" thinking. There is no v2. Build it right.

## Mission

Add the smallest production-ready transcript recovery slice so a Phantom chat agent can continue naturally after Murph compaction.

The agent needs access to a compact, cited, redacted view of the durable pre-compaction transcript. It must not dump the whole transcript into the provider context, and it must not ask the user to repeat context when Phantom can safely recover it from the chat database.

## Required Reading

Read these files directly before implementation:

1. `/Users/truffle/.claude/AGENTS.md`
2. `/Users/truffle/.claude/CLAUDE.md`
3. `/Users/truffle/work/murph/QUALITY-BAR.md`
4. `/Users/truffle/work/phantom-murph-hardening/CLAUDE.md`
5. `/Users/truffle/work/phantom-murph-hardening/src/agent/in-process-reflective-tools.ts`
6. `/Users/truffle/work/phantom-murph-hardening/src/chat/continuity-context.ts`
7. `/Users/truffle/work/phantom-murph-hardening/src/chat/message-store.ts`
8. `/Users/truffle/work/phantom-murph-hardening/src/agent/murph-context.ts`
9. `/Users/truffle/work/phantom-murph-hardening/src/agent/chat-query.ts`
10. `/Users/truffle/work/murph/packages/core/src/compaction/compact.ts`
11. `/Users/truffle/work/murph/packages/core/src/compaction/summary-prompt.ts`
12. `/Users/truffle/work/pi-mono/packages/coding-agent/docs/compaction.md`

## Implementation Scope

Build a current-session transcript search capability:

1. Add a helper that reads durable `chat_messages` rows for a session.
2. Return compact search results with `seq`, `role`, `created_at`, and redacted snippets.
3. Support a query, role filter, seq window, and result limit.
4. Redact secrets, API keys, authorization fields, cookies, and magic-login tokens.
5. Preserve page URLs and normal opaque IDs, because those are often exactly what the agent needs to recover.
6. Register the helper as an in-process MCP tool on `phantom-reflective`.
7. Update chat continuity context so every Murph chat run includes the current chat session id and instructs the agent to use transcript search when earlier context is missing after compaction.
8. Keep tool output compact and safe for model context.

## Non-Goals

- Do not create a vector search system.
- Do not expose raw provider reasoning.
- Do not expose attachment base64.
- Do not create a user-facing memory UI in this slice.
- Do not alter Murph compaction internals unless the tests prove Phantom is using them incorrectly.
- Do not change broad chat UI visuals in this slice.

## Acceptance Criteria

1. A post-compaction agent can discover the current chat session id from `# Current Chat Context`.
2. The agent has an in-process tool named `phantom_chat_transcript_search`.
3. The tool can find an earlier user or assistant detail by text query in the current session.
4. The tool can list recent transcript entries when no query is given.
5. Tool results are compact, cited by seq, and redacted.
6. Login magic tokens are not returned.
7. Existing memory search and session listing tools continue to exist.
8. Unit tests cover query search, recent lookup, redaction, role filters, and continuity context injection.
9. Full local checks pass before commit.

## Verification

Run focused tests first:

- `bun test src/chat/__tests__/transcript-search.test.ts src/chat/__tests__/continuity-context.test.ts`
- `bun test src/agent/__tests__/reflective-transcript-tools.test.ts`

Then run the broader gate required by the quality bar:

- `bun test`
- `bun run lint`
- `bun run typecheck`
- `cd chat-ui && bun test`
- `cd chat-ui && bun run typecheck`
- `cd chat-ui && bun run build`

After local checks, run a live Phantom-on-Murph browser smoke with a long session if time permits.

## Anti-Patterns

- Do not stringify whole messages without truncation.
- Do not let query text become raw SQL.
- Do not use explicit `any`.
- Do not use `@ts-ignore`.
- Do not ask the user to repeat information that exists in the transcript.
- Do not call a login link a created page URL.
- Do not hide tool failures as successful empty assistant responses.

ultrathink. Build the runtime affordance that makes compaction feel trustworthy instead of forgetful.
