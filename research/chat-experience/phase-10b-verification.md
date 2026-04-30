# Phase 10B Durable Timeline Verification

Date: 2026-04-30

Branch: `codex/pr106-chat-experience-work`

Target PR branch: `codex/murph-agent-runtime-clean`

## Scope

Phase 10B makes chat route loads and reconnects durable enough for Phantom to
recover Murph runs without depending only on the live SSE connection.

Implemented surfaces:

- `chat_run_timelines` durable table and indexes.
- writer-side run timeline persistence.
- session detail response with `stream_state` and `run_timelines`.
- client route-load replay and connection state handling.
- completed timeline rendering under committed messages.
- incomplete-tail recovery behavior for stale streams.

## Reviewer Fixes

Independent review found three blockers before this breadcrumb:

1. Durable timeline summaries could persist raw tool output or credential-shaped
   command/input/output values.
2. Resume state treated benign post-terminal `session.suggestion` frames as an
   incomplete tail.
3. Migration tests still expected the pre-timeline migration count and did not
   assert the new table/indexes.

Fixes applied:

- Durable tool output summaries now record status-level summaries instead of
  raw stdout/stderr.
- Tool input summaries reduce shell commands to the executable token, strip URL
  query params, skip sensitive keys, and redact common secret shapes.
- A re-review found one remaining P1 in allowed fields such as `query`,
  `pattern`, `description`, `task`, and `title`. Redaction now also catches AWS
  access key IDs, private key block markers, full cookie headers, and CSRF/XSRF
  key-value pairs across all durable safe-text fields.
- A second re-review found header-style CSRF/XSRF tokens still needed explicit
  coverage. Redaction now catches colon-delimited credential headers such as
  `X-CSRF-Token`, `X-XSRF-Token`, and `X-API-Key`.
- Stream state now computes recovery relevance separately from raw max seq and
  ignores known benign post-terminal suggestion events.
- Resume emits synthetic server-restart recovery only for recovery-relevant
  incomplete tails.
- Migration tests now expect 51 migrations and assert `chat_run_timelines` plus
  its indexes.

## Verification

Passed:

- `bun test`
  - 2074 pass
  - 10 skip
  - 1 todo
  - 0 fail
- `cd chat-ui && bun test`
  - 19 pass
  - 0 fail
- `bun run typecheck`
- `cd chat-ui && bun run typecheck`
- targeted `bunx biome check` on all Phase 10B changed files
- `git diff --check`

Targeted reviewer-regression tests passed:

- `bun test src/chat/__tests__/run-timeline.test.ts`
- `bun test src/chat/__tests__/event-log.test.ts`
- `bun test src/chat/__tests__/http-resume.test.ts`
- `bun test src/db/__tests__/migrate.test.ts`

Known gate caveat:

- Full repo `bunx biome check .` currently reports many unrelated pre-existing
  diagnostics outside Phase 10B files, including untouched JSON and chat UI
  components. The changed-file Biome gate is clean.

## Next Work

Phase 10C should improve Murph progress fidelity:

- show richer tool running/result state while a long run is active;
- preserve useful live details without persisting raw secret-bearing output;
- decide whether Murph needs a generic `tool_progress` payload extension for
  partial output, exit code, artifact paths, duration, and error metadata.

Phase 10D should polish the chat UI:

- stronger layout hierarchy for thinking, tool activity, answers, and final
  messages;
- more refined tool cards and expanded details;
- calmer borders, spacing, composer, and mobile behavior.
