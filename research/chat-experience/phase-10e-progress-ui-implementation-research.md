# Phase 10E Progress UI Implementation Research

Date: 2026-05-01
Status: first implementation slice built and verified

## Goal

Make the Murph-backed Phantom chat experience feel alive, inspectable, and
durable during long agent runs. The target is not a lucky demo. The target is a
production chat surface where users can see what the agent is doing, reconnect
without losing state, inspect safe tool details, and trust that long work is
still moving.

## Current Ground Truth

Phantom already runs locally on top of Murph and has been verified through real
provider browser flows:

- OpenAI browser proof with Murph SDK shim, real chat route, Bash tool call,
  reload, and durable timeline readback.
- Anthropic browser proof with the same flow.
- Murph provider proof across OpenAI, Anthropic, and Z.AI.
- Murph long-session proof across OpenAI and Anthropic, including SDK shim
  compatibility.

The current product problem is now in the experience layer, not in basic
provider execution.

## Reference Patterns

These are product and protocol inputs, not copy sources.

- Vercel AI Elements says AI chat components should be composable, deeply tied
  to streaming/status state, and expose collapsible tool details with status
  indicators, parameters, results, and errors.
  Sources:
  - https://elements.ai-sdk.dev/
  - https://elements.ai-sdk.dev/components/tool
  - https://elements.ai-sdk.dev/components/reasoning
- OpenAI Codex describes long-running agent work as monitorable in real time,
  with verifiable evidence through terminal logs and test outputs.
  Source: https://openai.com/index/introducing-codex/
- Cursor's current changelog calls out durable agents, per-prompt runs,
  run-scoped streaming, SSE reconnect with `Last-Event-ID`, and clearer
  terminal states.
  Source: https://cursor.com/en-US/changelog
- Linear's UI redesign notes emphasize hierarchy, balance, density, clearer
  headers, lower visual noise, and better contrast.
  Sources:
  - https://linear.app/changelog/2024-03-20-new-linear-ui
  - https://linear.app/changelog
- WAI-ARIA disclosure guidance requires a real button trigger, keyboard toggle
  with Enter and Space, and `aria-expanded` reflecting collapsed state.
  Source: https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/
- WCAG 2.2 target sizing guidance sets the practical floor for dense controls:
  interactive targets should fit a 24 by 24 CSS pixel square or have adequate
  spacing.
  Source:
  https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html
- Anthropic's fine-grained tool streaming docs confirm that streamed tool input
  deltas are part of the tool-call contract and may be partial until the block
  closes. We should preserve the stream contract and add display metadata around
  it, not mutate the model-facing tool blocks.
  Source:
  https://platform.claude.com/docs/en/agents-and-tools/tool-use/fine-grained-tool-streaming
- OpenAI's function-calling docs reinforce that tool calls, tool outputs, and
  reasoning items have strict multi-turn semantics. We should not change the
  transcript shape merely to improve UI display.
  Source: https://developers.openai.com/api/docs/guides/function-calling

## Local Reference Lessons

From `/Users/truffle/work/notes-main` and `/Users/truffle/work/pi-mono`:

- Pi already has the right event spine. `pi-agent-core` emits
  `tool_execution_start`, `tool_execution_update`, and `tool_execution_end`.
- Pi tools receive `onUpdate`, which can stream accumulated partial output.
  Pi's own RPC docs say clients can correlate by `toolCallId` and replace their
  display with the latest accumulated output.
- Pi's Bash tool uses `onUpdate` while stdout arrives, with truncation metadata
  and a full output path when needed.
- The notes emphasize a two-layer model: execution remains raw and lossless,
  presentation is bounded, redacted, and navigable.
- The notes also emphasize discoverability and visible stderr. A tool detail UI
  should make failed commands actionable, not silent.

## Runtime Signal Map

Murph already receives richer Pi execution events:

- `packages/core/src/events/normalized-event.ts`
  - `tool_execution_start` has `toolUseId`, `name`, and `input`.
  - `tool_execution_update` has `toolUseId`, `name`, and `update`.
  - `tool_execution_end` has `toolUseId`, `name`, `isError`, and `result`.
- `packages/core/src/events/translator-pi.ts`
  - Pi agent events are translated into those normalized events.
- `packages/core/src/substrate/pi-harness.ts`
  - The harness subscribes to Pi events and passes every normalized event to
    `params.onEvent`.
- `packages/core/src/query/query.ts`
  - Current gap: `tool_execution_start` is compressed into a minimal
    `tool_progress`.
  - Current gap: `tool_execution_update` and `tool_execution_end` are not
    mapped to SDK messages.
  - Current gap: the minimal `tool_progress` drops tool name, input, partial
    output, result, and duration.

Phantom can already consume richer wire frames:

- `src/chat/types-tool.ts`
  - `message.tool_call_start`, input deltas, input end, running, result,
    blocked, and aborted are already modeled.
- `src/chat/sdk-to-wire.ts`
  - Current `tool_progress` handling only emits `message.tool_call_running`.
  - Tool results from synthetic user `tool_result` blocks are already translated
    safely into `message.tool_call_result`.
- `src/chat/run-timeline.ts`
  - Durable run timeline already persists safe tool input/output summaries,
    compaction, rate limits, MCP status, subagents, terminal state, and errors.
- `chat-ui/src/lib/chat-activity.ts`
  - Durable summaries replay into `RunActivityRow`.
- `chat-ui/src/components/tool-call-card.tsx`
  - Current bug: `hasBody` is true when `inputJson` exists, but the expanded
    body renders only `error`, `blockReason`, and `output`. Inputs are silently
    hidden.

## Product Gaps

1. Tool cards are expandable without showing the tool input. This exactly
   matches the screenshot problem where the dropdown looks empty.
2. Long running tool work has too little visible rhythm. If no partial output is
   forwarded, the UI can look frozen.
3. Murph drops Pi's `tool_execution_update` and `tool_execution_end` signal
   before Phantom can use it.
4. Durable run summaries are safe and useful, but the current card rendering
   makes those summaries too quiet.
5. The chat shell still has visual polish debt: heavy user bubble color, uneven
   borders, inconsistent densities, and a composer that feels detached from the
   work timeline.

## Recommended Implementation Split

### Slice 1: Phantom UI Disclosure Fix

Scope:

- Render safe tool input details in `ToolCallCard`.
- Render output, error, blocked reason, duration, truncation, and MCP metadata
  with clearer hierarchy.
- Add proper disclosure accessibility: `aria-expanded`, stable body id, and
  keyboard-safe button behavior.
- Keep every string sourced from existing safe UI state. Do not expose raw
  secrets beyond what the current frame already carries.

Why first:

- It fixes the real user-observed bug.
- It requires no Murph contract changes.
- It makes existing durable timeline summaries visibly useful.

### Slice 2: Generic Murph Tool Progress Extension

Scope:

- Extend `MurphToolProgressMessage` with optional fields:
  - `tool_name`
  - `phase`
  - `duration_ms`
  - `input_preview`
  - `output_preview`
  - `error`
  - `safe_to_display`
  - `redactions`
  - `full_ref`
- Map normalized `tool_execution_start`, `tool_execution_update`, and
  `tool_execution_end` into enriched `tool_progress`.
- Preserve backward compatibility: existing consumers that only read
  `tool_use_id` and `elapsed_ms` keep working.
- Summarize or truncate display previews inside Murph. Do not alter tool result
  messages sent back to the model.

Why second:

- Murph is the SDK/runtime boundary. Phantom should consume generic runtime
  progress, not infer provider-specific internals.
- This uses Pi's existing event spine and `onUpdate` path instead of inventing a
  parallel telemetry path.

### Slice 3: Phantom Wire and Durable Timeline Enrichment

Scope:

- Teach `handleToolProgress` about phases.
- Running and partial-output phases emit `message.tool_call_running`.
- Completed and failed phases emit `message.tool_call_result` with safe preview
  output only.
- Preserve raw `tool_result` translation for actual model-facing tool results.
- Add durable timeline fields only after the wire contract is stable.

### Slice 4: Chat Experience Polish

Scope:

- Replace saturated user bubbles with compact request blocks.
- Improve header, sidebar, borders, and composer density.
- Add an activity rail that remains visible for long running work.
- Add animated but low-noise "working" affordances when the run has no new text.
- Keep tool details collapsible and inspectable, not dumped inline.

## Acceptance Tests

Local unit and build gates:

- Murph `pnpm test` for query mapper tests.
- Murph `pnpm run build`.
- Phantom `bun test src/chat`.
- Phantom `pnpm --dir chat-ui test`.
- Phantom `pnpm --dir chat-ui run build`.

Provider proof:

- Murph provider proof with OpenAI, Anthropic, and Z.AI.
- Murph long-session proof with OpenAI and Anthropic.

Browser proof:

- Run Phantom locally on Murph.
- Log in by magic link.
- Send a Bash request that sleeps and prints output.
- Verify the tool row appears during execution.
- Verify expanded details show safe input while running.
- Verify output appears after completion.
- Refresh during or immediately after execution.
- Verify the durable run timeline rehydrates the same tool summary.
- Repeat at least once with OpenAI and once with Anthropic.

## Decision

Build now, in this order:

1. Fix Phantom's tool card disclosure and activity row polish using existing
   safe state.
2. Extend Murph progress with Pi-derived lifecycle metadata in a backward
   compatible way.
3. Wire enriched progress into Phantom and persist safe summaries.
4. Do browser proofs against real OpenAI and Anthropic before pushing further UI
   polish.

This is buildable now. The important boundary is that Murph owns generic runtime
events, Phantom owns presentation, and neither side mutates model-facing tool
call semantics for the sake of UI.

## Implementation Evidence

Completed in the first build slice:

- Murph now maps Pi `tool_execution_start`, `tool_execution_update`, and
  `tool_execution_end` into backward-compatible enriched `tool_progress`
  messages.
- Phantom now translates enriched progress into running and result wire frames,
  including safe previews, duration, truncation, and full-output references.
- Phantom durable timelines now persist the safe preview fields.
- The chat UI now renders safe tool parameters and output in accessible
  disclosure cards instead of showing empty expanded bodies.

Verification completed:

- Murph `pnpm test`: 396 passed, 17 skipped.
- Murph `pnpm run lint`: passed.
- Murph `pnpm run build`: passed.
- Phantom `bun test`: 2078 passed, 10 skipped, 1 todo.
- Phantom `bun run typecheck`: passed.
- Phantom `bun run lint`: passed.
- Phantom chat UI `pnpm --dir chat-ui test`: 20 passed.
- Phantom chat UI `pnpm --dir chat-ui run build`: passed, with the existing
  font-resolution and chunk-size warnings.
- Murph provider proof against the Phantom branch passed with OpenAI `gpt-5.5`,
  Anthropic `claude-opus-4-7`, and Z.AI `glm-5`.
- Focused browser proof ran Phantom locally on Murph with OpenAI `gpt-5.5`,
  logged in through a magic link, sent a Bash command that slept and printed a
  sentinel, expanded the live Bash card while it was running, verified safe
  parameters were visible, then verified final output and durable session detail
  contained the tool evidence.
