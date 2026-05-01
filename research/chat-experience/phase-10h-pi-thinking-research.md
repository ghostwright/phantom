# Phase 10H Pi Thinking Research

## Scope And Constraints

This report executes the saved prompt at `/Users/truffle/work/phantom-murph-hardening/prompts/phase-10h-pi-thinking-research.md` and incorporates the additional operator direction in `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10h-product-direction.md`.

Constraints honored:

- No application code was edited.
- No files were reverted.
- The only write target used for this task is `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10h-pi-thinking-research.md`.
- This report treats local source files as evidence and labels design recommendations as inference when they go beyond direct source facts.

## Executive Summary

Pi has strong primitives for honest thinking, text streaming, tool calls, tool execution progress, usage, completion, and provider continuity. The strongest reusable layer is not the Pi web UI itself, but the separation it demonstrates: provider adapters preserve protocol details, the agent loop emits a stable event grammar, and UI components render already-normalized facts without mutating the model transcript.

Phantom should adapt Pi concepts, not import Pi UI wholesale. Pi web UI is built around `mini-lit`, its own `Agent` usage model, and an in-memory artifact tool. Phantom already has a React chat UI, Murph-normalized events, durable sessions, page and file concepts, and product-specific artifacts. The next high-impact slice should make files and artifacts first-class chat surfaces, improve markdown and inspection, and keep thinking honest by rendering only provider-backed reasoning events or explicitly labeled redacted/hidden states.

The product direction file is aligned with the Pi evidence: built-in Phantom tools should own native pages, artifacts, files, auth-sensitive previews, and session-specific operations; MCP tools should remain external and reusable integrations; UI affordances should inspect, open, copy, filter, expand, retry, and preview state that already exists. UI affordances must not invent tool execution or fabricate provider thinking.

## Source Inventory

### Doctrine And Project Contract

- `/Users/truffle/.claude/AGENTS.md`: Root orchestration doctrine and operating expectations.
- `/Users/truffle/.claude/CLAUDE.md`: Canonical doctrine, communication constraints, verification expectations, and strict professional output rules.
- `/Users/truffle/work/murph/AGENTS.md`: Murph-specific clean-room contract, required reading list, strict TypeScript rule, v1 library-only scope, and safety constraints.
- `/Users/truffle/work/murph/VISION.md`: Murph product and architecture intent.
- `/Users/truffle/work/murph/PROGRESS.md`: Current phase status and already-completed work.
- `/Users/truffle/work/murph/QUALITY-BAR.md`: Verification and completion bar.
- `/Users/truffle/work/murph/ARCHITECTURE.md`: Runtime boundaries and normalized event architecture.
- `/Users/truffle/work/murph/IMPLEMENTATION-PLAN.md`: Planned Murph phase sequencing and scope boundaries.

Why this matters: the report must keep Murph clean-room, keep Phantom-specific UI outside Murph, and avoid application edits during research.

### Prompt And Product Direction

- `/Users/truffle/work/phantom-murph-hardening/prompts/phase-10h-pi-thinking-research.md`: Required deliverables for this report.
- `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10h-product-direction.md`: Additional operator direction on files and artifacts, tool ownership, markdown quality, interactive inspection, and honest provider thinking.
- `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10g-pi-continuity.md`: Prior Pi continuity research and constraints around provider thinking preservation.
- `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10a-synthesis.md`: Prior synthesis for chat experience direction.
- `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10c-murph-progress-research.md`: Prior Murph progress research.
- `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10d-chat-ui-polish-research.md`: Prior Phantom chat polish research.
- `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10e-progress-ui-implementation-research.md`: Prior progress UI implementation research.

Why this matters: Phase 10H should extend the existing chat-experience research thread, not restart it or recommend conflicting UI semantics.

### Pi Agent Runtime

- `/Users/truffle/work/pi-mono/packages/agent/src/types.ts`: Agent state, messages, tool result shape, tool update callback, and agent events.
- `/Users/truffle/work/pi-mono/packages/agent/src/agent-loop.ts`: Main loop, streaming response handling, tool execution events, transformContext integration, and completion handling.
- `/Users/truffle/work/pi-mono/packages/agent/src/agent.ts`: Agent wrapper, options, thinking-level mapping, event dispatch, state updates, and default LLM conversion.
- `/Users/truffle/work/pi-mono/packages/agent/src/index.ts`: Public exports for the Pi agent package.
- `/Users/truffle/work/pi-mono/packages/agent/src/proxy.ts`: Agent transport/proxy surface.

Why this matters: Murph already uses Pi as a substrate, so Phantom should receive provider facts through Murph normalization rather than coupling directly to Pi UI internals.

### Pi AI Types And Providers

- `/Users/truffle/work/pi-mono/packages/ai/src/types.ts`: `ThinkingLevel`, `ThinkingContent`, `ToolCall`, `Usage`, `AssistantMessageEvent`, and model capability types.
- `/Users/truffle/work/pi-mono/packages/ai/src/stream.ts`: Public simple stream and completion entry points.
- `/Users/truffle/work/pi-mono/packages/ai/src/utils/event-stream.ts`: `AssistantMessageEventStream` lifecycle and `.result()` behavior.
- `/Users/truffle/work/pi-mono/packages/ai/src/providers/transform-messages.ts`: Cross-model thinking handling, redacted thinking preservation, thought signature dropping, synthetic tool result insertion, and partial assistant skip logic.
- `/Users/truffle/work/pi-mono/packages/ai/src/providers/anthropic.ts`: Anthropic thinking display, redacted thinking mapping, signature streaming, tool-use streaming, and usage handling.
- `/Users/truffle/work/pi-mono/packages/ai/src/providers/openai-responses.ts`: OpenAI Responses reasoning configuration and encrypted reasoning inclusion.
- `/Users/truffle/work/pi-mono/packages/ai/src/providers/openai-responses-shared.ts`: OpenAI reasoning summary conversion, encrypted reasoning replay, tool-call conversion, and usage mapping.
- `/Users/truffle/work/pi-mono/packages/ai/src/providers/openai-completions.ts`: Completions-compatible reasoning, reasoning details, tool-call streaming, and provider-specific thinking compatibility.
- `/Users/truffle/work/pi-mono/packages/ai/src/providers/google-shared.ts`: Google thought signature handling and the distinction between `thought: true` and encrypted signatures.
- `/Users/truffle/work/pi-mono/packages/ai/src/models.ts`: Local model capability metadata including reasoning support and xhigh support.

Why this matters: these files define what is protocol-backed thinking, what is continuity metadata, and what is safe to surface in UI.

### Pi Web UI And Artifacts

- `/Users/truffle/work/pi-mono/packages/web-ui/README.md`: Pi web UI purpose, public components, chat panel usage, attachments, artifacts, storage, and event list.
- `/Users/truffle/work/pi-mono/packages/web-ui/src/ChatPanel.ts`: High-level chat panel and artifact panel integration.
- `/Users/truffle/work/pi-mono/packages/web-ui/src/components/AgentInterface.ts`: Event subscription, streaming message container hookup, usage stats, attachments, model and thinking selectors.
- `/Users/truffle/work/pi-mono/packages/web-ui/src/components/MessageList.ts`: Message grouping, tool result pairing, and inline assistant rendering.
- `/Users/truffle/work/pi-mono/packages/web-ui/src/components/Messages.ts`: Assistant message rendering for text, thinking, tool calls, tool results, errors, and usage.
- `/Users/truffle/work/pi-mono/packages/web-ui/src/components/StreamingMessageContainer.ts`: Request-animation-frame batching and streaming assistant rendering.
- `/Users/truffle/work/pi-mono/packages/web-ui/src/components/ThinkingBlock.ts`: Collapsible thinking display with streaming state.
- `/Users/truffle/work/pi-mono/packages/web-ui/src/tools/renderer-registry.ts`: Tool renderer registry, status headers, disclosure, and default renderer selection.
- `/Users/truffle/work/pi-mono/packages/web-ui/src/tools/renderers/DefaultRenderer.ts`: Generic tool-call card with params and output formatting.
- `/Users/truffle/work/pi-mono/packages/web-ui/src/tools/artifacts/artifacts.ts`: In-memory artifact tool, preview panel, tabs, and supported artifact types.
- `/Users/truffle/work/pi-mono/packages/web-ui/src/tools/artifacts/artifacts-tool-renderer.ts`: Artifact tool-call renderer with file pills, diffs, code blocks, console logs, and details.
- `/Users/truffle/work/pi-mono/packages/web-ui/src/tools/artifacts/ArtifactElement.ts`: Artifact preview base class and header-button abstraction.
- `/Users/truffle/work/pi-mono/packages/web-ui/src/tools/artifacts/ArtifactPill.ts`: Clickable artifact pill surface.

Why this matters: Pi web UI contains useful rendering patterns, but Phantom should adapt them into its React, session, and artifact model.

### Pi Mom CLI-Style Surfaces

- `/Users/truffle/work/pi-mono/packages/mom/src/log.ts`: CLI logging for user input, tool start/success/error, response start, thinking, response, downloads, stop, warnings, errors, and usage summary.
- `/Users/truffle/work/pi-mono/packages/mom/src/agent.ts`: Mom agent wiring around Pi coding agent and tool events.
- `/Users/truffle/work/pi-mono/packages/mom/src/store.ts`: JSONL Slack log persistence and downloaded attachment storage.
- `/Users/truffle/work/pi-mono/packages/mom/src/events.ts`: File-driven event scheduling.

Why this matters: Mom is not a Phantom chat UI, but it demonstrates concise progress logging, output truncation, usage summaries, and file download persistence.

### Murph Runtime And Normalization

- `/Users/truffle/work/murph/packages/core/src/types/message.ts`: Murph content blocks, tool progress message shape, compact state, status messages, API retry messages, and file persisted messages.
- `/Users/truffle/work/murph/packages/core/src/events/normalized-event.ts`: Normalized event grammar for text, thinking, redacted thinking, tool calls, tool execution, tool progress, session state, compaction, rate limits, retries, prompts, subagents, hooks, permissions, notifications, and errors.
- `/Users/truffle/work/murph/packages/core/src/events/translator-pi.ts`: Pi-to-Murph translation for thinking, redacted thinking, tool calls, images, tool results, usage, and tool execution events.
- `/Users/truffle/work/murph/packages/core/src/query/query.ts`: SDK stream mapping, runtime event mapping, tool progress preview limits, secret redaction, truncation, and full reference support.
- `/Users/truffle/work/murph/packages/core/src/substrate/pi-harness.ts`: Murph Pi harness, `transformContext`, tool hooks, thinking level, thinking budgets, and normalized event forwarding.
- `/Users/truffle/work/murph/packages/core/src/query/options.ts`: Murph thinking option normalization and Pi thinking-level mapping.
- `/Users/truffle/work/murph/packages/anthropic-sdk-shim/src/index.ts`: Public shim export for `MurphToolProgressMessage`.

Why this matters: Phantom should read the Murph-normalized event stream and avoid reaching around Murph into provider-specific or Pi-specific internals.

### Phantom Chat Backend And UI

- `/Users/truffle/work/phantom-murph-hardening/src/chat/types.ts`: Phantom wire protocol for session, message, thinking, tool, and error frames.
- `/Users/truffle/work/phantom-murph-hardening/src/chat/types-tool.ts`: Phantom wire tool-event shapes.
- `/Users/truffle/work/phantom-murph-hardening/src/chat/sdk-to-wire-handlers.ts`: Assistant and stream-event conversion into Phantom wire frames, including thinking and tool-use handling.
- `/Users/truffle/work/phantom-murph-hardening/src/chat/sdk-to-wire.ts`: System/result/user event conversion, compaction/rate/subagent/tool-progress mapping, and safe tool error handling.
- `/Users/truffle/work/phantom-murph-hardening/src/chat/writer.ts`: Chat stream writer, durable message commit, final assistant persistence, and timeline persistence.
- `/Users/truffle/work/phantom-murph-hardening/src/chat/message-builder.ts`: User attachment conversion for images, PDFs, documents, and text.
- `/Users/truffle/work/phantom-murph-hardening/src/chat/message-store.ts`: Durable chat message storage and `content_json` handling.
- `/Users/truffle/work/phantom-murph-hardening/src/agent/chat-query.ts`: Phantom runtime query setup with partial messages, progress summaries, prompt suggestions, thinking config, effort, and `transformContext`.
- `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/lib/chat-types.ts`: Frontend message, thinking, tool, run activity, and timeline types.
- `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/lib/chat-store.ts`: Wire-frame reducer for messages, thinking blocks, tools, statuses, compaction, rate limits, MCP connection, and subagents.
- `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/lib/chat-dispatch-tools.ts`: Tool-call state machine and placeholder tool handling.
- `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/lib/chat-activity.ts`: Run-activity summaries, active run timeline, compaction/rate/MCP/subagent/tool activity.
- `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/assistant-message.tsx`: Assistant rendering for thinking blocks, tool cards, markdown text, streaming indicators, and usage.
- `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/thinking-block.tsx`: Phantom reasoning block labels and redacted-state display.
- `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/tool-call-card.tsx`: Tool cards, tool icons, parameter display, output display, error and blocked states, full reference links, and redaction.
- `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/run-activity-row.tsx`: Run activity row with status, facts, subagents, and tool cards.
- `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/markdown.tsx`: ReactMarkdown, GFM, sanitize, custom links, and code block integration.
- `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/code-block.tsx`: Code block header, language label, wrapping, and copy action.
- `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/message-list.tsx`: Message grouping, run timeline placement, current run activity row, and streaming accessibility text.
- `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/hooks/use-chat.ts`: SSE consumption, resume, initial history loading, and durable message parsing.

Why this matters: Phantom already has most of the scaffolding for honest progress and thinking, but file/artifact inspection, markdown polish, and some event coverage remain the highest-impact gaps.

## Pi Representation Model

### Thinking

Evidence:

- `/Users/truffle/work/pi-mono/packages/ai/src/types.ts`
- `/Users/truffle/work/pi-mono/packages/ai/src/providers/transform-messages.ts`
- `/Users/truffle/work/pi-mono/packages/ai/src/providers/anthropic.ts`
- `/Users/truffle/work/pi-mono/packages/ai/src/providers/openai-responses.ts`
- `/Users/truffle/work/pi-mono/packages/ai/src/providers/openai-responses-shared.ts`
- `/Users/truffle/work/pi-mono/packages/ai/src/providers/google-shared.ts`
- `/Users/truffle/work/pi-mono/packages/agent/src/agent.ts`
- `/Users/truffle/work/pi-mono/packages/agent/src/agent-loop.ts`

Direct source facts:

- Pi AI defines `ThinkingLevel` as reasoning levels and Pi agent-core adds an `off` state for agent configuration in `/Users/truffle/work/pi-mono/packages/agent/src/types.ts` and `/Users/truffle/work/pi-mono/packages/ai/src/types.ts`.
- Pi AI represents thinking content as a content block with `type: "thinking"`, `thinking`, optional `thinkingSignature`, and optional `redacted` in `/Users/truffle/work/pi-mono/packages/ai/src/types.ts`.
- Pi streams thinking through `AssistantMessageEvent` variants: `thinking_start`, `thinking_delta`, and `thinking_end` in `/Users/truffle/work/pi-mono/packages/ai/src/types.ts`.
- Pi agent maps `state.thinkingLevel` into provider reasoning settings unless thinking is `off` in `/Users/truffle/work/pi-mono/packages/agent/src/agent.ts`.
- Anthropic provider handling supports summarized or omitted thinking display, maps redacted thinking into a redacted thinking block, and preserves signature data in `/Users/truffle/work/pi-mono/packages/ai/src/providers/anthropic.ts`.
- OpenAI Responses handling requests encrypted reasoning content when reasoning is enabled and maps reasoning summaries into Pi thinking events in `/Users/truffle/work/pi-mono/packages/ai/src/providers/openai-responses.ts` and `/Users/truffle/work/pi-mono/packages/ai/src/providers/openai-responses-shared.ts`.
- Google handling distinguishes visible thought parts from encrypted thought signatures. The Google source states that `thought: true` is the marker for thinking and that `thoughtSignature` can appear on any part type in `/Users/truffle/work/pi-mono/packages/ai/src/providers/google-shared.ts`.
- Cross-model transcript transformation preserves redacted thinking only when safe for same-model continuity, converts non-empty cross-model thinking to text, skips empty thinking, and removes tool-call thought signatures when crossing models in `/Users/truffle/work/pi-mono/packages/ai/src/providers/transform-messages.ts`.
- Pi transform code skips errored or aborted assistant messages because partial reasoning or incomplete tool calls can create API errors in `/Users/truffle/work/pi-mono/packages/ai/src/providers/transform-messages.ts`.

Inference:

- Phantom should treat provider thinking as protocol data, not as a generic UI spinner. If Phantom did not receive a Murph/Pi thinking event, it should show working, waiting, streaming, tool running, or status text instead of claiming the model is thinking.
- Phantom should not display `thinkingSignature`, encrypted reasoning content, or Google `thoughtSignature` as user-readable content. These are continuity artifacts according to the provider adapter source files listed above.
- Phantom's current `thinking-block.tsx` choice to hide the thinking text and show labels such as "Thought", "Thought for Xs", or "Reasoning hidden" is safer than rendering raw provider reasoning by default. Evidence for the current UI behavior is `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/thinking-block.tsx`.

### Streaming Text

Evidence:

- `/Users/truffle/work/pi-mono/packages/ai/src/types.ts`
- `/Users/truffle/work/pi-mono/packages/agent/src/agent-loop.ts`
- `/Users/truffle/work/pi-mono/packages/web-ui/src/components/StreamingMessageContainer.ts`
- `/Users/truffle/work/pi-mono/packages/web-ui/src/components/Messages.ts`
- `/Users/truffle/work/phantom-murph-hardening/src/chat/sdk-to-wire-handlers.ts`
- `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/lib/chat-store.ts`

Direct source facts:

- Pi streams assistant text through `text_start`, `text_delta`, and `text_end` events in `/Users/truffle/work/pi-mono/packages/ai/src/types.ts`.
- Pi agent loop forwards streaming assistant events as `message_update` events in `/Users/truffle/work/pi-mono/packages/agent/src/agent-loop.ts`.
- Pi web UI batches streaming message updates with `requestAnimationFrame` in `/Users/truffle/work/pi-mono/packages/web-ui/src/components/StreamingMessageContainer.ts`.
- Phantom backend maps assistant stream text into `message.text_delta` and related frames in `/Users/truffle/work/phantom-murph-hardening/src/chat/sdk-to-wire-handlers.ts`.
- Phantom frontend appends text deltas into assistant content in `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/lib/chat-store.ts`.

Inference:

- Phantom already has the correct data path for streaming text. The main gap is rendering quality and persistence shape, not transport.
- Phantom should inspect whether multiple text blocks can arrive in a single assistant message. The current assistant renderer uses the first text block from `message.content.find(...)` in `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/assistant-message.tsx`, so later text blocks could be hidden if they occur.

### Tool Calls And Tool Progress

Evidence:

- `/Users/truffle/work/pi-mono/packages/ai/src/types.ts`
- `/Users/truffle/work/pi-mono/packages/agent/src/types.ts`
- `/Users/truffle/work/pi-mono/packages/agent/src/agent-loop.ts`
- `/Users/truffle/work/pi-mono/packages/web-ui/src/tools/renderer-registry.ts`
- `/Users/truffle/work/pi-mono/packages/web-ui/src/tools/renderers/DefaultRenderer.ts`
- `/Users/truffle/work/murph/packages/core/src/types/message.ts`
- `/Users/truffle/work/murph/packages/core/src/events/normalized-event.ts`
- `/Users/truffle/work/murph/packages/core/src/query/query.ts`
- `/Users/truffle/work/phantom-murph-hardening/src/chat/sdk-to-wire.ts`
- `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/lib/chat-dispatch-tools.ts`
- `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/tool-call-card.tsx`

Direct source facts:

- Pi tool calls are content blocks with `type: "toolCall"`, `id`, `name`, `arguments`, and optional `thoughtSignature` in `/Users/truffle/work/pi-mono/packages/ai/src/types.ts`.
- Pi tools accept `onUpdate` callbacks during execution in `/Users/truffle/work/pi-mono/packages/agent/src/types.ts`.
- Pi agent loop emits `tool_execution_start`, `tool_execution_update`, and `tool_execution_end` events around execution in `/Users/truffle/work/pi-mono/packages/agent/src/agent-loop.ts`.
- Pi web UI renders tools through a renderer registry and default renderer in `/Users/truffle/work/pi-mono/packages/web-ui/src/tools/renderer-registry.ts` and `/Users/truffle/work/pi-mono/packages/web-ui/src/tools/renderers/DefaultRenderer.ts`.
- Murph normalizes Pi and runtime tool activity into `tool_progress` and `tool_execution_*` events in `/Users/truffle/work/murph/packages/core/src/events/normalized-event.ts` and `/Users/truffle/work/murph/packages/core/src/query/query.ts`.
- Murph tool progress includes phase, elapsed time, duration, input preview, output preview, truncation flag, safe display flag, redactions, and full reference in `/Users/truffle/work/murph/packages/core/src/types/message.ts`.
- Phantom converts tool progress into `tool.running` and `tool.result` frames in `/Users/truffle/work/phantom-murph-hardening/src/chat/sdk-to-wire.ts`.
- Phantom frontend has a tool state machine that handles pending, input streaming, running, result, error, blocked, and aborted states in `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/lib/chat-dispatch-tools.ts`.
- Phantom tool cards already show parameters, redacted output, block reasons, errors, full output reference, and a 12000-character display limit in `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/tool-call-card.tsx`.

Inference:

- Phantom's progress and tool-card foundation is sound after Phase 10E. The next improvement should specialize built-in Phantom tools, MCP tools, file outputs, generated pages, and full references into richer inspection surfaces rather than adding more generic status rows.
- Tool output is not equivalent to artifact state. A tool output may mention a file, page, public URL, or full reference, but Phantom needs explicit artifact extraction or explicit frames to make those surfaces first-class.

### Usage And Completion

Evidence:

- `/Users/truffle/work/pi-mono/packages/ai/src/types.ts`
- `/Users/truffle/work/pi-mono/packages/ai/src/utils/event-stream.ts`
- `/Users/truffle/work/pi-mono/packages/agent/src/agent-loop.ts`
- `/Users/truffle/work/pi-mono/packages/web-ui/src/components/AgentInterface.ts`
- `/Users/truffle/work/pi-mono/packages/web-ui/src/components/Messages.ts`
- `/Users/truffle/work/murph/packages/core/src/events/translator-pi.ts`
- `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/assistant-message.tsx`

Direct source facts:

- Pi `Usage` includes input, output, cache read, cache write, total tokens, and cost in `/Users/truffle/work/pi-mono/packages/ai/src/types.ts`.
- Pi stream completion uses `done` and `error` assistant events in `/Users/truffle/work/pi-mono/packages/ai/src/types.ts` and `/Users/truffle/work/pi-mono/packages/ai/src/utils/event-stream.ts`.
- Pi agent loop emits message and turn lifecycle events in `/Users/truffle/work/pi-mono/packages/agent/src/agent-loop.ts`.
- Pi web UI displays usage when available in `/Users/truffle/work/pi-mono/packages/web-ui/src/components/Messages.ts` and session stats in `/Users/truffle/work/pi-mono/packages/web-ui/src/components/AgentInterface.ts`.
- Murph translates Pi usage into normalized usage in `/Users/truffle/work/murph/packages/core/src/events/translator-pi.ts`.
- Phantom assistant messages render cost and token usage when `message.usage` exists in `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/assistant-message.tsx`.

Inference:

- Phantom can continue to show usage at assistant-message level, but should avoid making usage the primary sign of completion. Session lifecycle, stream stop, and tool completion events are better completion signals because usage can be absent or provider-dependent.

## Pi Rendering Patterns

### Web UI Pattern To Adapt

Evidence:

- `/Users/truffle/work/pi-mono/packages/web-ui/README.md`
- `/Users/truffle/work/pi-mono/packages/web-ui/src/components/ThinkingBlock.ts`
- `/Users/truffle/work/pi-mono/packages/web-ui/src/components/StreamingMessageContainer.ts`
- `/Users/truffle/work/pi-mono/packages/web-ui/src/components/MessageList.ts`
- `/Users/truffle/work/pi-mono/packages/web-ui/src/components/Messages.ts`
- `/Users/truffle/work/pi-mono/packages/web-ui/src/tools/renderer-registry.ts`
- `/Users/truffle/work/pi-mono/packages/web-ui/src/tools/artifacts/artifacts.ts`
- `/Users/truffle/work/pi-mono/packages/web-ui/src/tools/artifacts/artifacts-tool-renderer.ts`
- `/Users/truffle/work/pi-mono/packages/web-ui/src/tools/artifacts/ArtifactPill.ts`

Direct source facts:

- Pi web UI provides a complete chat panel, message list, streaming container, thinking block, tool renderers, attachments, and artifacts in `/Users/truffle/work/pi-mono/packages/web-ui/README.md`.
- Pi web UI renders thinking as a collapsible block in `/Users/truffle/work/pi-mono/packages/web-ui/src/components/ThinkingBlock.ts`.
- Pi web UI pairs tool calls with tool results and skips standalone tool-result messages in `/Users/truffle/work/pi-mono/packages/web-ui/src/components/MessageList.ts`.
- Pi web UI has a tool renderer registry with headers, status treatment, disclosure, and fallback rendering in `/Users/truffle/work/pi-mono/packages/web-ui/src/tools/renderer-registry.ts`.
- Pi web UI includes an artifacts tool, artifact panel, artifact pills, tabs, preview types, diffs, code blocks, logs, and console surfaces in `/Users/truffle/work/pi-mono/packages/web-ui/src/tools/artifacts/artifacts.ts`, `/Users/truffle/work/pi-mono/packages/web-ui/src/tools/artifacts/artifacts-tool-renderer.ts`, and `/Users/truffle/work/pi-mono/packages/web-ui/src/tools/artifacts/ArtifactPill.ts`.

Inference:

- Phantom should adapt these patterns: paired inline tool results, collapsible tool details, streaming update batching, honest thinking disclosure, artifact pills, artifact preview tabs, and file/page side-panel inspection.
- Phantom should not import Pi web UI as-is. The Pi implementation is `mini-lit`, has its own chat surface and artifact storage pattern, and does not match Phantom's React components, durable sessions, or native Phantom page/artifact model. Evidence for Phantom's React UI is in `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/assistant-message.tsx`, `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/lib/chat-store.ts`, and `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/hooks/use-chat.ts`.

### CLI-Style Pattern To Adapt Selectively

Evidence:

- `/Users/truffle/work/pi-mono/packages/mom/src/log.ts`
- `/Users/truffle/work/pi-mono/packages/mom/src/store.ts`
- `/Users/truffle/work/pi-mono/packages/mom/src/agent.ts`

Direct source facts:

- Mom logs user input, tool lifecycle, response start, thinking, response text, downloads, stop, warnings, errors, and usage in `/Users/truffle/work/pi-mono/packages/mom/src/log.ts`.
- Mom truncates long output and adds context to tool logs in `/Users/truffle/work/pi-mono/packages/mom/src/log.ts`.
- Mom persists conversation events and downloaded attachments to local workspace files in `/Users/truffle/work/pi-mono/packages/mom/src/store.ts`.

Inference:

- Phantom can adapt Mom's concise temporal log shape for compact activity summaries and run timelines.
- Phantom should not adapt Mom as a UI implementation. It is a CLI-style surface around Slack/mom workflows, not a browser chat UI. Evidence for that workflow is `/Users/truffle/work/pi-mono/packages/mom/src/agent.ts`.

## Ownership Split

### What Murph And Pi Should Own

Evidence:

- `/Users/truffle/work/murph/AGENTS.md`
- `/Users/truffle/work/murph/ARCHITECTURE.md`
- `/Users/truffle/work/murph/packages/core/src/events/normalized-event.ts`
- `/Users/truffle/work/murph/packages/core/src/events/translator-pi.ts`
- `/Users/truffle/work/murph/packages/core/src/substrate/pi-harness.ts`
- `/Users/truffle/work/pi-mono/packages/ai/src/providers/transform-messages.ts`
- `/Users/truffle/work/pi-mono/packages/ai/src/providers/anthropic.ts`
- `/Users/truffle/work/pi-mono/packages/ai/src/providers/openai-responses-shared.ts`
- `/Users/truffle/work/pi-mono/packages/ai/src/providers/google-shared.ts`

Direct source facts:

- Murph is a clean-room TypeScript agent runtime and should build generic runtime behavior rather than Phantom-specific shortcuts according to `/Users/truffle/work/murph/AGENTS.md`.
- Murph already owns normalized event grammar and Pi translation in `/Users/truffle/work/murph/packages/core/src/events/normalized-event.ts` and `/Users/truffle/work/murph/packages/core/src/events/translator-pi.ts`.
- Murph's Pi harness owns Pi substrate integration, tool hooks, thinking levels, thinking budgets, and normalized event forwarding in `/Users/truffle/work/murph/packages/core/src/substrate/pi-harness.ts`.
- Pi provider adapters own provider-specific reasoning and continuity details in `/Users/truffle/work/pi-mono/packages/ai/src/providers/anthropic.ts`, `/Users/truffle/work/pi-mono/packages/ai/src/providers/openai-responses-shared.ts`, and `/Users/truffle/work/pi-mono/packages/ai/src/providers/google-shared.ts`.

Inference:

- Murph and Pi should own provider transport, model capability handling, transcript transformation, thinking budgets, encrypted or redacted reasoning continuity, normalized stream events, tool execution lifecycle, tool progress envelopes, usage, retries, compaction, and cross-model safety.
- Murph should expose facts. It should not own Phantom page previews, artifact side panels, chat-specific visual affordances, or product-specific file browsing.

### What Phantom Built-In Tools Should Own

Evidence:

- `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10h-product-direction.md`
- `/Users/truffle/work/phantom-murph-hardening/src/chat/message-builder.ts`
- `/Users/truffle/work/phantom-murph-hardening/src/chat/writer.ts`
- `/Users/truffle/work/phantom-murph-hardening/src/chat/message-store.ts`
- `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/tool-call-card.tsx`
- `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/hooks/use-chat.ts`

Direct source facts:

- The product direction file explicitly asks for files and artifacts as first-class UI surfaces, clear built-in versus MCP versus UI ownership, markdown quality, interactive inspection, and no fake provider thinking in `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10h-product-direction.md`.
- Phantom already transforms user attachments into message content in `/Users/truffle/work/phantom-murph-hardening/src/chat/message-builder.ts`.
- Phantom persists final assistant content and timelines in `/Users/truffle/work/phantom-murph-hardening/src/chat/writer.ts` and `/Users/truffle/work/phantom-murph-hardening/src/chat/message-store.ts`.
- Phantom tool cards already understand local tool names such as Read, Write, Edit, Bash, Glob, Grep, WebSearch, and WebFetch in `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/tool-call-card.tsx`.

Inference:

- Phantom built-in tools should own Phantom-native operations that require product state, workspace state, auth, session identity, and safe preview semantics: page creation, page preview, generated file registration, attachment registration, durable artifact metadata, safe full-output references, and Phantom-owned file browsing.
- Phantom built-ins should produce explicit artifact metadata when they create or modify files or pages. UI should not have to scrape arbitrary prose when a built-in tool already knows the artifact identity.

### What MCP Tools Should Own

Evidence:

- `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10h-product-direction.md`
- `/Users/truffle/work/murph/packages/core/src/events/normalized-event.ts`
- `/Users/truffle/work/phantom-murph-hardening/src/chat/sdk-to-wire-handlers.ts`
- `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/lib/chat-types.ts`

Direct source facts:

- Phantom wire and UI types track MCP connection state and MCP server metadata in `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/lib/chat-types.ts`.
- Phantom backend marks tools as MCP based on tool naming conventions in `/Users/truffle/work/phantom-murph-hardening/src/chat/sdk-to-wire-handlers.ts`.
- Murph normalized events include MCP-adjacent generic tool execution events rather than Phantom-specific tool semantics in `/Users/truffle/work/murph/packages/core/src/events/normalized-event.ts`.

Inference:

- MCP tools should own external, reusable integrations such as third-party systems, browser automation, email, calendar, source control, search, and other portable capabilities.
- MCP tools should not be used as a substitute for Phantom-native file/page/session UI when the product already owns the underlying state and authorization model.

### What UI Affordances Should Own

Evidence:

- `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10h-product-direction.md`
- `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/tool-call-card.tsx`
- `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/markdown.tsx`
- `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/code-block.tsx`
- `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/run-activity-row.tsx`

Direct source facts:

- Phantom UI already renders expandable tool cards, copied code blocks, markdown, and run activity rows in the files listed above.

Inference:

- UI affordances should open, copy, preview, filter, expand, collapse, retry, and inspect already-produced state.
- UI affordances should not execute hidden tools, invent artifacts, infer provider thinking, or mutate transcript content sent back to providers.

## Phantom Recommendations Ordered By Impact

### 1. Make Files And Artifacts First-Class Chat Surfaces

Evidence:

- `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10h-product-direction.md`
- `/Users/truffle/work/pi-mono/packages/web-ui/src/tools/artifacts/artifacts.ts`
- `/Users/truffle/work/pi-mono/packages/web-ui/src/tools/artifacts/artifacts-tool-renderer.ts`
- `/Users/truffle/work/pi-mono/packages/web-ui/src/tools/artifacts/ArtifactPill.ts`
- `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/tool-call-card.tsx`
- `/Users/truffle/work/murph/packages/core/src/types/message.ts`

Inference:

- Add an artifact extraction and rendering layer in Phantom UI that treats created files, edited files, generated pages, attachments, public URLs, and `full_ref` outputs as inspectable objects.
- Render compact artifact pills inline in tool cards and assistant messages.
- Add an artifact inspector side panel or drawer with type-specific previews: text, markdown, code, image, PDF, HTML/page preview, diff, logs, and metadata.
- Preserve the tool card as the execution record, but let the artifact inspector become the place where users inspect durable outputs.
- Keep full references safe. A `full_ref` should be an opaque reference until a server endpoint validates scope, path, auth, and display safety.

### 2. Keep Thinking Honest And Provider-Backed

Evidence:

- `/Users/truffle/work/pi-mono/packages/ai/src/providers/anthropic.ts`
- `/Users/truffle/work/pi-mono/packages/ai/src/providers/openai-responses-shared.ts`
- `/Users/truffle/work/pi-mono/packages/ai/src/providers/google-shared.ts`
- `/Users/truffle/work/pi-mono/packages/ai/src/providers/transform-messages.ts`
- `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/thinking-block.tsx`
- `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10h-product-direction.md`

Inference:

- Render thinking only when Murph/Phantom receives actual thinking events.
- For redacted or hidden reasoning, show explicit labels such as "Reasoning hidden" and optionally duration. Do not show fake summaries.
- For providers without reasoning events, use status language such as "Working", "Calling tools", "Reading files", or "Waiting for model" instead of "Thinking".
- Never expose `thinkingSignature`, encrypted reasoning content, Google `thoughtSignature`, or provider replay payloads in UI.
- Avoid treating tool progress, compaction, retries, or MCP connection events as model thinking.

### 3. Clarify Built-In Tool, MCP Tool, And UI Labels

Evidence:

- `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10h-product-direction.md`
- `/Users/truffle/work/phantom-murph-hardening/src/chat/sdk-to-wire-handlers.ts`
- `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/lib/chat-types.ts`
- `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/tool-call-card.tsx`

Inference:

- Add visible but compact metadata for tool origin: Phantom built-in, MCP server, or local/runtime tool.
- For built-in tools, prefer product words such as "Created page", "Updated file", "Read workspace", or "Generated preview".
- For MCP tools, show the server name and tool name, because the current backend already derives MCP metadata from tool naming conventions in `/Users/truffle/work/phantom-murph-hardening/src/chat/sdk-to-wire-handlers.ts`.
- For UI affordances, do not present actions such as opening, copying, expanding, previewing, or filtering as tool calls. They are inspection controls.

### 4. Upgrade Markdown Rendering Quality

Evidence:

- `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/markdown.tsx`
- `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/code-block.tsx`
- `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10h-product-direction.md`

Inference:

- Keep `remark-gfm` and `rehype-sanitize`, but add polished table, task-list, blockquote, ordered-list, unordered-list, inline-code, pre/code, and link treatments.
- Add syntax highlighting or language-aware styling to code blocks while preserving copy actions.
- Detect safe local artifact references and generated page links, then render them as artifact pills or preview links.
- Keep raw HTML sanitized. Any custom renderer for links, images, or code must preserve sanitize guarantees.

### 5. Fill Event Coverage Gaps Before Building More UI States

Evidence:

- `/Users/truffle/work/murph/packages/core/src/types/message.ts`
- `/Users/truffle/work/murph/packages/core/src/events/normalized-event.ts`
- `/Users/truffle/work/phantom-murph-hardening/src/chat/sdk-to-wire.ts`
- `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/lib/chat-types.ts`

Inference:

- Phantom currently maps compaction, rate limits, subagents, and tool progress, but should audit additional Murph events such as `api_retry`, `files_persisted`, `tool_use_summary`, `auth_status`, `local_command_output`, hook progress, plugin install, session state, notification, memory recall, and mirror errors before adding separate bespoke UI states.
- Event coverage should stay factual. If Murph does not emit an event, Phantom UI should not synthesize a provider-like state.

## Risks And Anti-Patterns

### Protocol And Provider Risks

Evidence:

- `/Users/truffle/work/pi-mono/packages/ai/src/providers/transform-messages.ts`
- `/Users/truffle/work/pi-mono/packages/ai/src/providers/google-shared.ts`
- `/Users/truffle/work/pi-mono/packages/ai/src/providers/openai-responses-shared.ts`
- `/Users/truffle/work/pi-mono/packages/ai/src/providers/anthropic.ts`
- `/Users/truffle/work/murph/packages/core/src/events/translator-pi.ts`

Risks:

- Displaying encrypted reasoning payloads, `thinkingSignature`, or `thoughtSignature` as user-readable thinking would leak continuity metadata and misrepresent provider semantics.
- Treating Google `thoughtSignature` as proof of visible thinking would contradict the adapter comment in `/Users/truffle/work/pi-mono/packages/ai/src/providers/google-shared.ts`.
- Rewriting provider transcript content for UI display can break tool-call protocol and cross-model continuity. Pi transform code already has explicit safeguards in `/Users/truffle/work/pi-mono/packages/ai/src/providers/transform-messages.ts`.
- Rendering raw provider reasoning by default can expose unsafe or private reasoning material. The product direction file asks to avoid fake provider thinking, and the provider files show that visible reasoning semantics vary by provider.

### Tool And Artifact Risks

Evidence:

- `/Users/truffle/work/murph/packages/core/src/query/query.ts`
- `/Users/truffle/work/murph/packages/core/src/types/message.ts`
- `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/tool-call-card.tsx`
- `/Users/truffle/work/pi-mono/packages/web-ui/src/tools/artifacts/artifacts.ts`

Risks:

- Full output references can become path traversal or data exposure risks if the UI dereferences them without server-side validation. Murph exposes `full_ref` as part of tool progress in `/Users/truffle/work/murph/packages/core/src/types/message.ts`.
- Tool inputs and outputs can contain secrets. Murph redaction exists in `/Users/truffle/work/murph/packages/core/src/query/query.ts`, and Phantom tool cards have frontend redaction in `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/tool-call-card.tsx`; neither should be weakened by artifact previews.
- Importing Pi's in-memory artifact tool directly would duplicate Phantom storage and authority. Pi's artifact implementation is in `/Users/truffle/work/pi-mono/packages/web-ui/src/tools/artifacts/artifacts.ts`, while Phantom durability is in `/Users/truffle/work/phantom-murph-hardening/src/chat/writer.ts` and `/Users/truffle/work/phantom-murph-hardening/src/chat/message-store.ts`.
- UI-only artifact messages must not leak back into model context. Pi web UI has conversion logic to filter artifact messages in `/Users/truffle/work/pi-mono/packages/web-ui/src/components/Messages.ts`.

### UX And Product Risks

Evidence:

- `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/assistant-message.tsx`
- `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/markdown.tsx`
- `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/message-list.tsx`
- `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10h-product-direction.md`

Risks:

- A chat UI that only shows transient tool cards leaves generated files and pages feeling like log output instead of first-class product artifacts.
- The current assistant renderer appears to render only the first text block from an assistant message in `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/assistant-message.tsx`. If multiple text blocks can arrive, content may be hidden.
- Markdown that is technically correct but visually weak can make good model output feel untrustworthy. Current markdown support is grounded in `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/markdown.tsx`.
- Confusing UI affordances with tools can make the user think opening or copying a file changed runtime state. The product direction file asks for clear separation in `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10h-product-direction.md`.

## Concrete Acceptance Criteria For Next Builder Slice

Inference: the next builder slice should be a Phantom chat UI slice focused on first-class artifacts, honest thinking display, and markdown polish. It should not require Murph runtime changes unless the event coverage audit finds a missing normalized event that already exists in Murph but is not wired into Phantom.

Acceptance criteria:

1. Artifact extraction
   - Phantom frontend derives artifact candidates from existing wire frames, tool outputs, tool names, `full_ref`, generated page URLs, and attachment metadata.
   - Artifact candidates preserve source message id, tool call id when present, display label, type, origin, safe preview status, and raw reference.
   - Extraction does not mutate model transcript content.

2. Artifact rendering
   - Tool cards and assistant markdown can render compact artifact pills for recognized files, pages, URLs, and full references.
   - Clicking an artifact pill opens an inspector panel or drawer without starting a new model or tool call.
   - Inspector supports at least text, markdown, code, image, PDF, generated page URL, and opaque full reference metadata.
   - Full reference preview is disabled unless a server endpoint validates it as safe to display.

3. Thinking honesty
   - Thinking UI renders only from received thinking frames.
   - Redacted thinking displays a redacted or hidden label and does not expose signatures or encrypted content.
   - No provider without thinking frames is shown as "thinking"; status language uses runtime facts such as tool running, compaction, retry, or streaming text.
   - Tests cover text thinking, redacted thinking, and no-thinking provider behavior.

4. Tool-origin clarity
   - Tool cards visually distinguish Phantom built-in, MCP, and generic runtime tools using existing metadata or clearly documented heuristics.
   - MCP cards show server name when available.
   - UI-only actions such as preview, copy, open, expand, collapse, filter, and retry are not displayed as tool calls.

5. Markdown polish
   - Tables, lists, blockquotes, inline code, fenced code, links, and task lists render with polished spacing and wrapping.
   - Code blocks keep copy behavior and add language-aware presentation.
   - Sanitization remains enabled.
   - Safe artifact links in markdown render as links or artifact pills without enabling raw HTML execution.

6. Persistence and replay
   - Reloaded chat history shows durable assistant text, historical run timeline, and artifact references when their source data is persisted.
   - If artifact details are transient and unavailable after reload, the UI clearly shows metadata instead of a broken preview.
   - Existing session resume behavior in `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/hooks/use-chat.ts` remains intact.

7. Verification
   - Unit tests cover reducer/extractor behavior for thinking, tool outputs, artifact candidates, and markdown link rendering.
   - Component tests or browser checks cover artifact inspector open/close, tool-card expansion, markdown tables, code blocks, and redacted thinking.
   - No application code outside the approved builder slice is changed.
   - No explicit `any`, no `@ts-ignore`, and no hidden type escapes are introduced.

## Highest-Signal Findings

1. Pi already has honest thinking primitives, including redacted/encrypted continuity handling, but those primitives are provider-specific. Phantom should render only Murph/Pi-backed thinking frames and should never display signatures or encrypted reasoning payloads. Evidence: `/Users/truffle/work/pi-mono/packages/ai/src/types.ts`, `/Users/truffle/work/pi-mono/packages/ai/src/providers/anthropic.ts`, `/Users/truffle/work/pi-mono/packages/ai/src/providers/openai-responses-shared.ts`, `/Users/truffle/work/pi-mono/packages/ai/src/providers/google-shared.ts`.

2. Pi web UI is a valuable pattern library, not a drop-in dependency for Phantom. Adapt the ideas of paired tool results, collapsible thinking, streaming batching, renderer registry, artifact pills, and artifact inspector, but implement them in Phantom's React and durable session model. Evidence: `/Users/truffle/work/pi-mono/packages/web-ui/src/components/Messages.ts`, `/Users/truffle/work/pi-mono/packages/web-ui/src/tools/renderer-registry.ts`, `/Users/truffle/work/pi-mono/packages/web-ui/src/tools/artifacts/artifacts.ts`, `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/lib/chat-store.ts`.

3. The next product jump is first-class files and artifacts. Current Phantom tool cards are useful execution records, but generated pages, edited files, attachments, URLs, and `full_ref` outputs need artifact pills and an inspector so outputs are not trapped inside log text. Evidence: `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10h-product-direction.md`, `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/tool-call-card.tsx`, `/Users/truffle/work/murph/packages/core/src/types/message.ts`.

4. Ownership should stay split: Pi and Murph own provider protocol, transcript safety, thinking continuity, normalized events, usage, and tool progress; Phantom owns product-specific built-ins, pages, files, artifacts, previews, and UI inspection; MCP owns external reusable integrations. Evidence: `/Users/truffle/work/murph/packages/core/src/substrate/pi-harness.ts`, `/Users/truffle/work/murph/packages/core/src/events/translator-pi.ts`, `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10h-product-direction.md`.

5. Markdown quality and replay durability are now part of trust. Phantom has GFM and sanitize, but needs stronger table/code/link/artifact rendering, and the current assistant renderer should be checked for multi-text-block messages because it selects only the first text block. Evidence: `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/markdown.tsx`, `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/code-block.tsx`, `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/assistant-message.tsx`.

## Self Review

- Every direct factual claim in this report is tied to a local source path in the same paragraph or bullet group.
- Recommendations and product choices are labeled as inference.
- No external source was needed because the requested evidence exists in local Pi, Murph, and Phantom source files.
- No application code was edited.
- The only file written for this task is `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10h-pi-thinking-research.md`.
