ultrathink. ultrathink. ultrathink.

You are a principal engineer, principal architect, and principal product manager at Anthropic, all three at once. You are implementing the Phase 10H Phantom chat transcript-integrity slice in `/Users/truffle/work/phantom-murph-hardening`.

No context anxiety. No token limits. No time pressure. No cost anxiety. No "v2" thinking. There is no v2. Build it right. Take as long as you need.

## Mission

Make the Phantom chat transcript trustworthy enough for production Murph use before we add more ambitious polish. The UI can be beautiful only if the underlying conversation record is honest, durable, and replayable.

This slice focuses on correctness, not broad redesign:

1. Runtime or SDK result errors must not become empty successful assistant rows.
2. User attachment metadata must persist without storing raw base64 payloads in chat message content.
3. Sent user-message attachments must appear live and after reload.
4. Upload failures must not silently send a prompt without the intended files.
5. Assistant messages with multiple text blocks must render all text.
6. Chat input must not double-send while upload is pending.

## Required Reading

Read these in order:

1. `/Users/truffle/.claude/AGENTS.md`
2. `/Users/truffle/.claude/CLAUDE.md`
3. `/Users/truffle/work/phantom-murph-hardening/CLAUDE.md`
4. `/Users/truffle/work/murph/QUALITY-BAR.md`
5. `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10h-product-direction.md`
6. `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10h-phantom-chat-review.md`
7. `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10h-pi-thinking-research.md`
8. `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10h-provider-thinking-research.md`

Then inspect the current source directly. Agent summaries are not evidence.

## Owned Areas

You may edit these areas as needed:

- `/Users/truffle/work/phantom-murph-hardening/src/chat/`
- `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/`
- Focused tests under those same areas.

Keep changes tightly scoped. Do not redesign the full chat UI in this slice.

## Product Bar

The transcript is a trust surface. When the agent runs a long task, creates files, uses tools, or attaches user-provided context, the UI must preserve what happened without pretending failed work succeeded.

Good behavior:

- The live view and reload view agree.
- Attachments show as first-class user message context.
- Invalid or failed attachments are visible to the user and block sending until fixed.
- Assistant text is not silently dropped because it arrived as multiple blocks.
- Terminal SDK errors produce visible error state, not blank success.

Bad behavior:

- Showing an assistant row as successful when the durable transcript will later remove it.
- Persisting base64 image or file payloads in the chat transcript.
- Sending the user's prompt without files after upload failures.
- Flattening tool or content data with brittle string parsing.
- Adding unrelated UI polish before fixing transcript correctness.

## Implementation Notes

Prefer structured helpers over ad hoc parsing. If the durable message content already contains structured JSON blocks, parse them centrally and render from that shape.

Keep SDK runtime message content separate from display-safe transcript content. The model may need attachment payloads during the run; the durable chat transcript should keep metadata and previews, not raw base64.

Make upload behavior explicit. If a user selected three files and one failed, the send path should know that and avoid silently continuing with two files.

Terminal result errors need both backend and frontend protection. If a provider produces an error after assistant start, the backend should avoid synthetic success completion frames and the frontend should let `session.error` override any matching assistant row.

## Acceptance Criteria

1. Result errors after assistant start do not emit a normal assistant end frame.
2. `session.error` can mark an existing assistant row as error even if a prior event ended it.
3. User attachments are committed to message ownership and replay as attachment chips after reload.
4. Durable content JSON does not contain raw base64 data URLs from attachment payloads.
5. Invalid, wrong-session, or already-sent attachment IDs are rejected with a 400 response.
6. Upload failures block send and preserve the composer content.
7. Multiple assistant text blocks render in order.
8. TypeScript remains strict: no explicit `any`, no `@ts-ignore`, no hidden type escapes.
9. Existing chat streaming, replay, and resume behavior still passes tests.

## Required Verification

Run focused tests first, then enough local gates to establish confidence:

```sh
bun test src/chat/__tests__/writer.test.ts
bun test src/chat/__tests__/http.test.ts src/chat/__tests__/message-builder.test.ts src/chat/__tests__/upload.test.ts
bun test src/chat/__tests__/sdk-to-wire.test.ts
cd chat-ui && bun test src/lib/__tests__/chat-store.test.ts
bun run lint
bun run typecheck
cd chat-ui && bun run typecheck
cd chat-ui && bun run build
git diff --check
```

If a command cannot run, document why and leave the work in a clean resume state.

## Handoff Contract

When done, report:

1. Files changed.
2. Behavior shipped.
3. Tests run and exact pass/fail status.
4. Any residual risks.
5. Whether the diff is ready for an independent review agent.

Do not commit. Do not push. The orchestrator will verify by reading files and running checks.

ultrathink. The floor is correctness. Polish can only sit on top of a transcript users can trust.
