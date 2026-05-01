# Phase 10H Provider Thinking Research

Date: 2026-05-01

## Provider Capability Matrix Headline

Phantom can honestly show live reasoning state across OpenAI, Anthropic, and ZAI, but it should only show reasoning text when Murph/Pi can prove it is a provider-supported summary or safe display text. Redacted, encrypted, private, or unknown thinking must be hidden or labeled as private. Separate thinking token counts are not available to Phantom today because Pi, Murph, and the Phantom wire protocol drop provider reasoning token fields.

## Executive Findings

Phantom's current UI posture is conservative and mostly correct: it displays "Thinking...", "Thought", or "Reasoning hidden" and does not render thinking text in `ThinkingBlock`. However, the browser store still accumulates `message.thinking_delta` text in memory, so private reasoning can still cross the Phantom wire and land client-side.

OpenAI, Anthropic, and ZAI do not expose the same product object. OpenAI Responses exposes optional reasoning summaries, encrypted reasoning items, and upstream reasoning token counts. Anthropic Messages exposes thinking blocks, signatures, summarized or omitted display modes in Pi, and redacted thinking blocks. ZAI exposes `reasoning_content` for GLM thinking. That ZAI signal is best treated as private reasoning, not a user-facing summary.

The missing product primitive is not another visual treatment. It is an event-contract field that distinguishes `summary`, `display_text`, `private`, `redacted`, `encrypted`, and `unknown` thinking. Without that field, Phantom should not render thinking text verbatim, even when the provider stream calls it "thinking".

The added product direction is the right bar: never fake private chain-of-thought, never let long-running tasks feel dead, and map provider signals into honest UI states. Murph/Pi should own provider semantics and thinking visibility. Phantom should render known states, safe summaries, timing, usage, tools, compaction, retries, blocked states, and errors.

## Source Map

Primary local files reviewed:

- Murph normalized event and usage model: `/Users/truffle/work/murph/packages/core/src/events/normalized-event.ts`
- Murph Pi translator: `/Users/truffle/work/murph/packages/core/src/events/translator-pi.ts`
- Murph message and usage types: `/Users/truffle/work/murph/packages/core/src/types/message.ts`
- Murph harness thinking options: `/Users/truffle/work/murph/packages/core/src/substrate/harness.ts`
- Murph query option normalization: `/Users/truffle/work/murph/packages/core/src/query/options.ts`
- Murph query event mappers: `/Users/truffle/work/murph/packages/core/src/query/query.ts`
- Murph built-in model capability records: `/Users/truffle/work/murph/packages/core/src/providers/models.ts`
- Murph Pi adapter: `/Users/truffle/work/murph/packages/core/src/substrate/pi-adapter.ts`
- Pi shared types: `/Users/truffle/work/pi-mono/packages/ai/src/types.ts`
- Pi OpenAI Responses provider: `/Users/truffle/work/pi-mono/packages/ai/src/providers/openai-responses.ts`
- Pi OpenAI Responses stream processor: `/Users/truffle/work/pi-mono/packages/ai/src/providers/openai-responses-shared.ts`
- Pi Anthropic provider: `/Users/truffle/work/pi-mono/packages/ai/src/providers/anthropic.ts`
- Pi OpenAI-compatible completions provider: `/Users/truffle/work/pi-mono/packages/ai/src/providers/openai-completions.ts`
- Pi message transformer: `/Users/truffle/work/pi-mono/packages/ai/src/providers/transform-messages.ts`
- Phantom wire types and translators: `/Users/truffle/work/phantom-murph-hardening/src/chat/types.ts`, `/Users/truffle/work/phantom-murph-hardening/src/chat/sdk-to-wire.ts`, `/Users/truffle/work/phantom-murph-hardening/src/chat/sdk-to-wire-handlers.ts`
- Phantom durable timeline: `/Users/truffle/work/phantom-murph-hardening/src/chat/run-timeline.ts`
- Phantom UI state and thinking component: `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/lib/chat-types.ts`, `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/lib/chat-store.ts`, `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/thinking-block.tsx`
- Product direction: `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10h-product-direction.md`

Official provider docs checked:

- OpenAI reasoning guide: https://developers.openai.com/api/docs/guides/reasoning
- OpenAI Responses API reference: https://developers.openai.com/api/reference/resources/responses/methods/create
- Anthropic extended thinking guide: https://platform.claude.com/docs/en/build-with-claude/extended-thinking
- ZAI chat completion API: https://docs.z.ai/api-reference/llm/chat-completion
- ZAI thinking mode guide: https://docs.z.ai/guides/capabilities/thinking-mode
- ZAI deep thinking guide: https://docs.z.ai/guides/capabilities/thinking
- ZAI tool streaming guide: https://docs.z.ai/guides/capabilities/stream-tool

## Event Taxonomy

### Thinking

Pi has `thinking_start`, `thinking_delta`, and `thinking_end` stream events in `AssistantMessageEvent`. `ThinkingContent` has `thinking`, optional `thinkingSignature`, and optional `redacted`.

Murph normalizes Pi thinking into `thinking_start`, `thinking_delta`, and `thinking_end`. `NormalizedUsage` only has input, output, cache read, cache write, total, and cost. It does not have `reasoningTokens` or `thinkingTokens`.

Murph SDK-style stream mapping converts normalized thinking events into `stream_event` content block start, delta, and stop with `content_block.type: "thinking"`.

Phantom converts SDK stream events to `message.thinking_start`, `message.thinking_delta`, and `message.thinking_end`. `ThinkingStartFrame` includes `redacted: boolean`; `ThinkingDeltaFrame` only has text delta; `ThinkingEndFrame` has optional duration.

Current UI state stores thinking text in `ThinkingBlockState.text`, but `ThinkingBlock` does not render it. Durable run timelines also drop raw thinking text and only retain labels such as "Thinking..." or "Finished reasoning."

Existing event basis:

- Pi `AssistantMessageEvent`
- Murph `NormalizedEvent` thinking variants
- SDK `stream_event`
- Phantom `message.thinking_start`, `message.thinking_delta`, `message.thinking_end`

Contract gaps:

- No `thinkingVisibility` or `thinkingKind` field exists to say whether text is a provider summary, user-displayable thinking, private chain-of-thought, redacted, encrypted, or unknown.
- No server-side Phantom rule prevents private thinking deltas from crossing into the browser.

### Redacted Thinking

Pi represents redaction as `ThinkingContent.redacted` with opaque encrypted payload stored in `thinkingSignature`. Anthropic redacted thinking enters Pi as a thinking block with `redacted: true`, placeholder text, and signature data.

Murph final assistant content maps Pi redacted thinking to `MurphRedactedThinkingBlock` with `type: "redacted_thinking"` and optional `data`. The normalized event union has a `redacted_thinking` event type, but the Pi stream translator currently maps Pi stream `thinking_start` the same way for redacted and non-redacted blocks. It does not emit a normalized redacted content-block start during streaming.

Phantom final assistant handling recognizes `redacted_thinking` and emits `message.thinking_start` with `redacted: true` and no delta. Stream handling can also handle a `content_block_start` with `content_block.type: "redacted_thinking"`, but Murph does not reliably produce that stream shape today.

Existing event basis:

- Pi `ThinkingContent.redacted`
- Murph final content block `redacted_thinking`
- Phantom `message.thinking_start.redacted`

Contract gaps:

- Murph should emit a streaming redacted-thinking signal when the provider says a block is redacted, not only rely on final assistant reconciliation.
- The redacted payload must remain opaque and must never be displayed, parsed, summarized, or copied into user-visible text.

### Progress Summaries

Murph has runtime events for `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, direct `tool_progress`, `subagent_start`, `subagent_progress`, `subagent_end`, `compact_started`, `compact_completed`, `session_state`, `prompt_suggestion`, `permission_request`, `permission_decision`, hooks, notifications, and errors.

Murph maps tool execution events into `tool_progress` messages with safe previews, truncation, and secret redactions. It maps subagent events into task system messages. Phantom maps these into tool cards, subagent activity, and durable run activity labels.

Phantom product direction says long-running tasks should never feel dead. Existing event support is enough for thinking, tool running, compaction, rate limits, subagents, blocked tools, aborted tools, done, and error. Waiting and retry states need better surfaced contracts.

Existing event basis:

- Murph normalized `tool_execution_*`, `tool_progress`, `subagent_*`, `compact_*`, `session_state`
- Phantom `message.tool_call_*`, `message.subagent_*`, `session.status`, `session.compact_boundary`

Contract gaps:

- Murph has normalized `api_retry`, and `MurphAPIRetryMessage` exists, but `NormalizedRuntimeEventMapper` does not map `api_retry` to an SDK message and Phantom has no `session.retry` or equivalent frame.
- `compact_completed` includes post-token count in Murph, but Phantom's `session.compact_boundary` only carries `pre_tokens`.

### Token Usage

Pi `Usage`, Murph `NormalizedUsage`, Murph `MurphUsage`, Murph `MurphModelUsage`, and Phantom `SessionDoneFrame.usage` carry normal input, output, cache, total, and cost fields. None carry separate thinking or reasoning token counts.

OpenAI upstream exposes reasoning token counts under `output_tokens_details.reasoning_tokens`, but Pi's Responses stream processor discards that field and only persists output token totals. ZAI docs show prompt, completion, cached prompt, and total token usage in Chat Completions, not a separate reasoning token field. Anthropic usage in Pi is also reduced to input, output, cache read, cache write, total, and cost.

Existing event basis:

- Murph `NormalizedUsage`
- Murph `MurphUsage`
- Phantom `session.done.usage`

Contract gaps:

- Add `reasoningTokens?: number` or `thinkingTokens?: number` at Pi `Usage`, Murph `NormalizedUsage`, Murph `MurphUsage`, Murph `MurphModelUsage`, result messages, Phantom `SessionDoneFrame.usage`, and run timeline summaries.
- Add provider attribution for whether reasoning tokens are provider-counted, estimated, or unavailable. Do not estimate counts in UI.

### Tool Calls

Pi streams `toolcall_start`, `toolcall_delta`, and `toolcall_end`. Murph normalizes these as `tool_call_start`, `tool_call_delta`, and `tool_call_end`. Phantom exposes `message.tool_call_start`, `message.tool_call_input_delta`, `message.tool_call_input_end`, `message.tool_call_running`, `message.tool_call_result`, `message.tool_call_blocked`, and `message.tool_call_aborted`.

ZAI supports `tool_stream` for streaming tool calls on supported GLM routes, and Murph's ZAI OpenAI-compatible route enables `zaiToolStream`.

Existing event basis:

- Pi toolcall stream events
- Murph normalized tool call and tool execution events
- Phantom tool call frames

Contract gaps:

- Tool cards can be richer with structured parameters, safe output references, files, and previews, but that is product/UI work rather than provider thinking semantics.

### Rate Limits

Murph normalized `rate_limit` has status, reset time, type, utilization, and overage status. Murph maps it to `rate_limit_event`. Phantom maps it to `session.rate_limit` with status, type, reset time, and utilization.

Existing event basis:

- Murph `rate_limit`
- SDK `rate_limit_event`
- Phantom `session.rate_limit`

Contract gaps:

- Phantom drops `overageStatus`.
- Retry and waiting states should be surfaced separately from rate-limit state.

## Provider Capability Matrix

| Provider route | Upstream signal | Pi/Murph today | Honest UI treatment | Token count status |
| --- | --- | --- | --- | --- |
| OpenAI via `openai-responses` | Reasoning models use private reasoning tokens. Raw reasoning tokens are not exposed through the API. Optional reasoning summaries appear only when opted in. Encrypted reasoning items can be included for continuity. Usage includes upstream `output_tokens_details.reasoning_tokens`. | Murph marks GPT-5.x and o3 routes as thinking-capable. Pi sends `reasoning.effort`, defaults `summary` to `auto`, includes `reasoning.encrypted_content`, streams reasoning summaries as Pi `thinking_*`, stores the final reasoning item JSON in `thinkingSignature`, and drops separate `reasoning_tokens` from usage. | Show active "Reasoning" state. Show summary text only after Murph/Pi labels it `summary`. Hide encrypted content and signatures. Do not claim raw chain-of-thought is visible. | Upstream count exists for OpenAI Responses. Phantom cannot show it today because Pi and Murph discard it. |
| Anthropic via `anthropic-messages` | Extended thinking can return thinking blocks, signatures, and `redacted_thinking` blocks. Anthropic docs describe redacted data as opaque encrypted content with no readable summary. Pi also supports summarized or omitted thinking display. | Murph marks Opus/Sonnet routes as thinking-capable and Haiku as not thinking-capable. Pi maps thinking blocks to `thinking_*`, maps redacted thinking to Pi `ThinkingContent.redacted`, computes standard usage only, and can choose summarized or omitted display. Murph final assistant content preserves `redacted_thinking`; streaming redaction is not clearly distinguished at normalized event level. | Show active "Reasoning" state. Show provider summary only if Murph/Pi labels the text as summary or displayable. Show "Reasoning hidden" for redacted blocks. Never display signature or `data`. | No separate thinking-token field reaches Phantom today. Do not show a count. |
| ZAI GLM via `openai-compat` config `zai` and `openai-completions` | ZAI GLM thinking is enabled by default for GLM-5.1, GLM-5, and GLM-4.7. Responses can include `reasoning_content`; streaming deltas can include `reasoning_content`, visible content, and tool calls. Preserved thinking requires exact unmodified `reasoning_content` replay. | Murph routes `glm-5` and `glm-5.1` through OpenAI-compatible completions with `thinking: true` and `toolStreaming: true`. Pi sets top-level `enable_thinking` when reasoning effort is present, enables `tool_stream`, and streams `reasoning_content`, `reasoning`, or `reasoning_text` as `thinking_*`. | Treat as private reasoning by default. Show active "Reasoning" state and timing. Do not render `reasoning_content` verbatim unless a future provider policy and Murph event label explicitly mark it user-displayable. | ZAI docs show normal prompt, completion, cache, and total usage. No separate reasoning token field reaches Phantom today. |

## What Can Be Shown

### Safe to Show Verbatim

- Assistant final answer text.
- User-authored text and attachments metadata already visible to the user.
- Tool names, structured parameters, and outputs only through existing safe preview, truncation, redaction, and full-reference rules.
- Rate limit status, reset time, utilization, compaction trigger, pre-token count, subagent summaries, and run status labels.
- OpenAI reasoning summaries and Anthropic summarized thinking only after Murph/Pi explicitly labels them as summaries or user-displayable provider text.

### Can Be Shown as Summary or Status

- "Reasoning", "Thinking", "Reasoning hidden", "Provider reasoning summary available", "Compacting context", "Retrying provider request", "Waiting for rate limit", "Using tool", "Blocked", "Errored", and "Completed" states.
- Provider reasoning summary text when it is a real upstream summary signal, not generated from private chain-of-thought.
- Tool progress summaries generated from safe tool events.
- Token usage totals that are actually present in the event stream.

### Must Be Hidden or Labeled Private

- OpenAI raw reasoning tokens. OpenAI does not expose raw reasoning tokens through the API.
- OpenAI `encrypted_content` and full reasoning item payloads used only for continuity.
- Anthropic `signature` and `redacted_thinking.data`.
- Anthropic redacted thinking blocks. Display only a hidden or redacted label.
- ZAI `reasoning_content` until the event contract marks it safe display text. Treat it as private chain-of-thought, because the provider describes it as reasoning process content rather than a summary.
- Any thinking text with unknown provenance.

## Can Phantom Show Thinking Tokens Today?

No.

OpenAI upstream can expose reasoning token counts, but the value is lost before Phantom:

1. OpenAI Responses usage includes `output_tokens_details.reasoning_tokens`.
2. Pi `processResponsesStream` reads response usage and stores input, output, cache read, cache write, total, and cost only.
3. Pi `Usage` has no reasoning-token field.
4. Murph `NormalizedUsage`, `MurphUsage`, `MurphModelUsage`, and `RunAttemptResult.usage` have no reasoning-token field.
5. Phantom `SessionDoneFrame.usage`, assistant `usage_delta`, chat message state, and durable run timeline have no reasoning-token field.

Required event-contract addition:

```ts
type ReasoningTokenUsage = {
  reasoningTokens?: number;
  reasoningTokenSource?: "provider" | "unavailable";
};
```

This should be threaded from Pi provider usage parsing through Murph normalized usage and into Phantom `session.done.usage`. Phantom should display a count only when `reasoningTokenSource === "provider"` and `reasoningTokens` is a finite number.

Do not estimate thinking tokens from text length. Do not infer hidden reasoning effort from duration. Do not show counts for providers that only expose blended output tokens.

## Recommended Honest UI Model

### Product Model

Use one "Live Activity" stack driven by real events:

- Reasoning: active or completed, with elapsed duration.
- Reasoning hidden: provider redacted, encrypted, private, or unknown.
- Provider reasoning summary: expandable only when `thinkingVisibility === "summary"` or equivalent exists.
- Tool activity: started, input streaming, running, partial output, result, error, blocked, aborted.
- Waiting and retrying: visible provider retry or rate-limit wait states.
- Compacting: explicit compaction start and completion state.
- Subagents: started, progress, completed, failed, stopped.
- Done, blocked, aborted, or errored: terminal state.

### Event Contract

Add a Murph/Pi thinking visibility field before rendering any thinking text:

```ts
type ThinkingVisibility =
  | "summary"
  | "display_text"
  | "private"
  | "redacted"
  | "encrypted"
  | "unknown";
```

Map providers conservatively:

- OpenAI reasoning summary deltas: `summary`
- OpenAI encrypted reasoning content: `encrypted`
- Anthropic `redacted_thinking`: `redacted`
- Anthropic summarized display: `summary` or `display_text`, depending on the provider payload and selected display mode
- Anthropic omitted thinking: `encrypted` or `private`
- ZAI `reasoning_content`: `private` by default
- Any unclassified OpenAI-compatible `reasoning`, `reasoning_text`, or `reasoning_content`: `unknown` or `private`

Phantom should only render text for `summary` and `display_text`. For all other values, it should show state, duration, and a short label. It should not ship private text to the browser when the visibility is `private`, `redacted`, `encrypted`, or `unknown`.

### Current Safe Builder Slice

The smallest safe slice is:

1. Keep the current non-rendering thinking component.
2. Add server-side suppression of private or unknown thinking deltas once Murph/Pi can label them.
3. Add UI labels for `summary`, `private`, `redacted`, and `encrypted`.
4. Add retry/waiting frames for `api_retry`.
5. Add reasoning token usage only for provider-counted values.

Until the visibility field exists, leave thinking text hidden and use only state, duration, tool progress, compaction, rate limits, and subagent progress for liveliness.

## Provider-Specific Notes

### OpenAI

OpenAI docs say reasoning models generate reasoning tokens that are not visible through the API, while optional reasoning summaries can be requested. The docs also show encrypted reasoning items for stateless or zero-data-retention continuity and upstream reasoning-token usage under `output_tokens_details.reasoning_tokens`.

Pi already requests `reasoning.encrypted_content` and defaults the summary setting to `auto` for reasoning-capable OpenAI Responses models. Pi streams `response.reasoning_summary_text.delta` as `thinking_delta`, so that stream is a provider summary, not raw chain-of-thought. The missing piece is a label that preserves this distinction for Phantom.

OpenAI UI rule:

- Render as "Reasoning" while active.
- Render summary text only after Murph/Pi labels it `summary`.
- Hide encrypted reasoning content and JSON signatures.
- Display reasoning token count only after the OpenAI `reasoning_tokens` field is preserved through Pi, Murph, and Phantom.

### Anthropic

Anthropic extended thinking can return thinking blocks, signatures, and redacted thinking. Anthropic docs say redacted thinking contains opaque encrypted data and no readable summary, and the opaque fields should be passed back unchanged for continuity when needed.

Pi supports `thinkingDisplay: "summarized" | "omitted"`. It defaults to summarized in local code, even though the docs note model-specific display behavior. Pi maps redacted thinking to a redacted `ThinkingContent`, but the stream currently looks like a normal `thinking_start` until final content reconciliation.

Anthropic UI rule:

- Render as "Reasoning" while active.
- If Murph/Pi labels a displayed block as summarized thinking, optionally show it as "Provider reasoning summary".
- For `redacted_thinking`, show "Reasoning hidden" with no text.
- Never expose `signature` or redacted `data`.

### ZAI

ZAI docs show GLM thinking can be enabled or disabled with a `thinking` parameter, and current GLM-5.1, GLM-5, and GLM-4.7 thinking is enabled by default. The Chat Completion API includes `reasoning_content`, and streaming can include `reasoning_content`, `content`, and `tool_calls`. ZAI preserved thinking requires exact unmodified reasoning-content replay.

Murph routes ZAI as OpenAI-compatible completions. Pi recognizes `reasoning_content`, `reasoning`, or `reasoning_text` and streams those fields as thinking. Because this is described as reasoning process content rather than an explicit summary, Phantom must treat it as private by default.

ZAI UI rule:

- Render as "Reasoning" while active.
- Do not display `reasoning_content` text.
- Preserve provider-required reasoning content for replay only inside the provider transport layer, not as user-visible UI.
- Use `tool_stream` events for live tool cards and progress.

## Tests Needed

### Murph and Pi Contract Tests

- OpenAI Responses fixture: `response.reasoning_summary_text.delta` becomes thinking with `thinkingVisibility: "summary"`, final encrypted reasoning payload remains hidden, and upstream `reasoning_tokens` is preserved into usage.
- Anthropic fixture: `thinking` with summarized display becomes `thinkingVisibility: "summary"` or `display_text`; `redacted_thinking` becomes `thinkingVisibility: "redacted"` and emits a redacted start signal during streaming.
- ZAI fixture: streaming `delta.reasoning_content` becomes `thinkingVisibility: "private"` and is not marked displayable.
- OpenAI-compatible fallback fixture: unknown `reasoning` or `reasoning_text` fields become `private` or `unknown`, not displayable.
- Usage fixture: reasoning-token counts are included only when the upstream provider sent a dedicated field.
- Replay fixture: encrypted and redacted provider continuity payloads round-trip unchanged where required, but never become visible text.

### Phantom Translator Tests

- `thinkingVisibility: "summary"` maps to an explicit user-displayable summary frame.
- `private`, `redacted`, `encrypted`, and `unknown` thinking never emit `message.thinking_delta` containing raw private text.
- Existing `redacted_thinking` final assistant content still emits `message.thinking_start` with `redacted: true` and no delta.
- `api_retry` maps to a visible retry or waiting frame.
- `compact_completed` can update post-token count if Phantom chooses to show it.
- `session.done.usage.reasoning_tokens` appears only for provider-counted values.

### Phantom UI Tests

- Thinking card renders state, duration, and redacted/private labels without showing private text.
- Provider summary text renders only when the frame says it is displayable.
- Browser store and durable run timeline do not retain private thinking text.
- Long-running canned streams show transitions for thinking, tool running, partial output, rate limit, compacting, retrying, done, and error.
- Mobile and desktop snapshots show no layout jumps when labels change from active to completed.

## Recommendation Checklist

- Keep thinking text hidden by default: existing Phantom UI supports this today.
- Add thinking visibility provenance: contract gap in Pi/Murph normalized events and Phantom wire frames.
- Add server-side suppression for private thinking deltas: contract gap in Phantom translation once provenance exists.
- Preserve OpenAI reasoning token counts: contract gap in Pi usage, Murph usage, SDK result messages, Phantom frames, and timelines.
- Treat Anthropic redacted thinking as hidden: existing final content support exists, streaming redaction needs a Murph normalization fix.
- Treat ZAI `reasoning_content` as private: existing stream support exists, display safety requires visibility metadata and UI suppression.
- Surface retries and waiting: Murph has `api_retry`, but SDK and Phantom mapping are missing.
- Use existing tool progress, rate limit, compaction, and subagent events for best-in-class liveness now.
