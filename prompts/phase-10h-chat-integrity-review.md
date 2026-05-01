ultrathink. ultrathink. ultrathink.

You are a principal engineer, principal architect, and principal product manager at Anthropic, all three at once. You are reviewing the Phase 10H Phantom chat transcript-integrity slice in `/Users/truffle/work/phantom-murph-hardening`.

No context anxiety. No token limits. No time pressure. No cost anxiety. No "v2" thinking. There is no v2. Build it right. Take as long as you need.

## Mission

Review the current uncommitted diff. Do not edit application code. Write your review report to:

`/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10h-chat-integrity-review.md`

Focus on bugs, regressions, missing tests, and product-trust issues.

## Required Reading

Read:

1. `/Users/truffle/.claude/AGENTS.md`
2. `/Users/truffle/.claude/CLAUDE.md`
3. `/Users/truffle/work/phantom-murph-hardening/CLAUDE.md`
4. `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10h-product-direction.md`
5. `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10h-phantom-chat-review.md`
6. `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10h-pi-thinking-research.md`
7. `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10h-provider-thinking-research.md`
8. `/Users/truffle/work/phantom-murph-hardening/prompts/phase-10h-chat-integrity-builder.md`

Then inspect the actual diff with `git diff`, not summaries.

## Review Scope

Pay special attention to:

- Runtime or SDK result errors must not become empty successful assistant rows.
- User attachment metadata must be persisted without base64 payloads.
- Sent user-message attachments must appear live and after reload.
- Upload failures must not silently send prompts without the intended files.
- Assistant messages with multiple text blocks must render all text.
- Chat input should not double-send while upload is pending.
- Attachment preview URLs must stay authenticated and safe.
- Existing chat streaming, replay, and resume semantics must not regress.
- No explicit `any`, `@ts-ignore`, hidden type escapes, or broad unrelated refactors.
- No generated build artifact should be included unless there is a clear reason.

## Output Format

Findings first, ordered by severity. Use P0/P1/P2/P3. Include exact file paths and line references. If there are no P0/P1/P2 findings, say that explicitly.

Then include:

1. Tests you ran or inspected.
2. Residual risks.
3. Whether this diff is safe to proceed to live browser verification.

Do not make code changes. Write only the report file.

ultrathink. Treat the transcript as a trust surface. The review should be skeptical, specific, and grounded in actual files.
