# Phase 10G Pi Continuity Context

Date: 2026-04-30

## Problem

A live Phantom-on-Murph browser session showed that Murph compaction can preserve
protocol validity and still lose host-level app facts that the user expects the
agent to remember, such as the exact page URL produced by `phantom_create_page`.
The symptom was not specific to page URLs. It was a continuity issue after a
long, tool-heavy run.

## Pi Grounding

Pi already provides the primitive we need:

- `transformContext` runs at the AgentMessage level before `convertToLlm`.
- Pi custom messages require the app to also provide a `convertToLlm`
  implementation. Murph's default Pi converter intentionally passes only
  `user`, `assistant`, and `toolResult` messages.
- Phantom should therefore inject host facts through `transformContext` as a
  normal user-context message, not as a custom role that the default converter
  would filter out.

Murph already exposes this primitive through `MurphOptions.transformContext`,
passes it through query normalization, and forwards it into the Pi harness.

## Decision

Do not build a parallel Phantom continuity runtime. Phantom should derive compact
host facts from its existing durable stream log and pass them to Murph through
`transformContext` as a Pi-compatible user-context message. Murph remains
responsible for raw transcript compaction, replay, tool-call protocol validity,
provider transport, and retry behavior.

## Current Implementation

- `src/chat/continuity-context.ts` scans the tail of `chat_stream_events`.
- It extracts user-visible page artifacts from `phantom_create_page` and
  `phantom_preview_page`.
- It intentionally excludes `phantom_generate_login` authentication links from
  page artifacts.
- It includes recent `session.compact_boundary` checkpoints.
- `src/agent/murph-context.ts` wraps that context in
  `<phantom_chat_context>` and inserts it as a Pi-compatible user-context
  message before the latest user message when possible.
- The chat query path uses this transform only on `agent_runtime: murph`.
  Anthropic fallback can still receive the same context through the system
  prompt append path.
- Tool call cards now default collapsed, with errors and blocked calls still
  opening automatically.

## Verification

- Focused Phantom tests pass:
  `bun test src/agent/__tests__/murph-context.test.ts src/chat/__tests__/continuity-context.test.ts src/chat/__tests__/writer.test.ts src/agent/__tests__/agent-sdk-boundary-callers.test.ts src/agent/__tests__/prompt-assembler.test.ts`
- Full Phantom tests pass: `bun test`.
- Phantom typecheck passes: `bun run typecheck`.
- Phantom lint passes: `bun run lint`.
- Chat UI typecheck and production build pass.
- Murph shim test and typecheck pass for `Options.transformContext`.

## Live Verification

Phantom was run locally on top of the locally rebuilt Murph shim with the OpenAI
provider and `gpt-5.5`.

Verified:

- A chat request created and previewed `/ui/continuity-smoke-final.html`.
- The served page returned HTTP 200 and contained the expected smoke text.
- A follow-up asking for the exact created page URL returned the page URL, not
  a login link.
- Completed tool cards rendered collapsed by default. An errored tool card still
  opened automatically.
