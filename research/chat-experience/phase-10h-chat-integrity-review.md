# Phase 10H Chat Integrity Review

## Findings

### P1: Live result errors can still leave a committed assistant row

`/Users/truffle/work/phantom-murph-hardening/src/chat/sdk-to-wire.ts:214` emits `message.assistant_end` for any SDK `result` when an assistant has started, before the subtype is checked at `/Users/truffle/work/phantom-murph-hardening/src/chat/sdk-to-wire.ts:228`. The live reducer then treats that `message.assistant_end` as success by changing the streaming assistant row to `committed` at `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/lib/chat-store.ts:332`. When the following `session.error` arrives, `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/lib/chat-store.ts:351` only changes the row to `error` if it is still `streaming`, so the already committed row stays visually successful.

Impact: an SDK run that emits `assistant_start` or partial assistant text and then ends with a non-success `result` can still show a successful assistant row in the live transcript. The backend skip at `/Users/truffle/work/phantom-murph-hardening/src/chat/writer.ts:148` prevents durable assistant commit, so reload later removes that row. That creates a live versus reload trust mismatch and still violates the requirement that runtime or SDK result errors must not become empty successful assistant rows.

The current coverage misses this shape. `/Users/truffle/work/phantom-murph-hardening/src/chat/__tests__/writer.test.ts:231` covers a non-success result with no prior assistant event, and `/Users/truffle/work/phantom-murph-hardening/src/chat/__tests__/sdk-to-wire.test.ts:402` only asserts that a result error creates `session.error`.

Fix direction: for non-success SDK results, either do not emit a normal `message.assistant_end` before `session.error`, or make `session.error` override the assistant row to `error` even after `assistant_end` marked it committed. Add reducer and writer coverage for `assistant_start -> result error` and `assistant_start -> text -> result error`.

No P0 or P2 findings found.

## Tests Ran Or Inspected

- `bun test src/chat/__tests__/writer.test.ts src/chat/__tests__/message-builder.test.ts src/chat/__tests__/http.test.ts`, 40 pass.
- `bun test src/chat/__tests__/sdk-to-wire.test.ts src/chat/__tests__/run-timeline.test.ts src/chat/__tests__/http-resume.test.ts`, 72 pass.
- `cd chat-ui && bun test src/lib/__tests__/chat-store.test.ts`, 26 pass.
- `bun run typecheck`, pass.
- `cd chat-ui && bun run typecheck`, pass.
- `bun run lint`, pass for backend `src/`.
- `cd chat-ui && bun run build`, pass. Vite reported unresolved `/chat/fonts/...` runtime font references and the existing chunk-size warning.
- `git diff --check`, pass.
- `cd chat-ui && bun run lint` was attempted, but `chat-ui/package.json` has no `lint` script.

## Residual Risks

- The required reading file `/Users/truffle/work/phantom-murph-hardening/prompts/phase-10h-chat-integrity-builder.md` is not present on disk. I searched the prompts and chat-experience research directories and continued from the actual diff plus the available Phase 10H materials.
- I did not perform live browser verification.
- The main remaining untested path is the live reducer sequence where an assistant row starts before a terminal SDK result error.

## Live Browser Verification

Not safe to proceed as the candidate diff yet. Fix the P1 live transcript error-row issue first, then run live browser verification against the repaired slice.

## Re-Review

P1 resolved.

Evidence: `/Users/truffle/work/phantom-murph-hardening/src/chat/sdk-to-wire.ts:214` now gates the synthetic `message.assistant_end` on `subtype === "success"`, so a non-success SDK `result` after assistant start emits `session.error` without first producing a normal assistant completion frame. `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/lib/chat-store.ts:366` now lets `session.error` mark the matching assistant row `error` regardless of whether that row was already `streaming` or `committed`.

Targeted coverage is present. `/Users/truffle/work/phantom-murph-hardening/src/chat/__tests__/sdk-to-wire.test.ts:418` asserts that a result error after assistant start does not emit `message.assistant_end`. `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/lib/__tests__/chat-store.test.ts:164` asserts that `session.error` changes a previously ended committed assistant row to `error`.

Re-review tests:

- `bun test src/chat/__tests__/sdk-to-wire.test.ts`, 58 pass.
- `cd chat-ui && bun test src/lib/__tests__/chat-store.test.ts`, 27 pass.
