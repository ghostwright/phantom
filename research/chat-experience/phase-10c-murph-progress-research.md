# Phase 10C Murph Progress Research

Date: 2026-04-30

Scope: Phantom chat tool-card progress during Murph-backed runs. This report
does not propose Phantom-specific telemetry inside Murph. It separates generic
runtime facts from Phantom rendering choices.

## Reading Status

All required paths were present and read in the current checkouts:

- Root doctrine: `/Users/truffle/.claude/AGENTS.md`,
  `/Users/truffle/.claude/CLAUDE.md`
- Phantom chat research and code:
  `research/chat-experience/phase-10a-synthesis.md`,
  `src/chat/types.ts`, `src/chat/types-tool.ts`,
  `src/chat/sdk-to-wire.ts`, `src/chat/sdk-to-wire-handlers.ts`,
  `src/agent/chat-query.ts`, `chat-ui/src/lib/chat-types.ts`,
  `chat-ui/src/lib/chat-dispatch-tools.ts`,
  `chat-ui/src/components/tool-call-card.tsx`
- Murph: `/Users/truffle/work/murph/AGENTS.md`, `VISION.md`,
  `PROGRESS.md`, `QUALITY-BAR.md`, `ARCHITECTURE.md`,
  `IMPLEMENTATION-PLAN.md`, `packages/anthropic-sdk-shim/src`,
  `packages/core/src`
- Adjacent substrate and notes: `/Users/truffle/work/pi-mono` and
  `/Users/truffle/work/notes-main`
- Official docs checked: OpenAI streaming and function calling, Anthropic
  streaming messages, Z.AI stream tool call docs.

## Executive Findings

1. Phantom already has wire frames for the full tool-card lifecycle:
   `message.tool_call_start`, `message.tool_call_input_delta`,
   `message.tool_call_input_end`, `message.tool_call_running`,
   `message.tool_call_result`, `message.tool_call_blocked`, and
   `message.tool_call_aborted`. Session-level error and abort frames also
   exist.
2. Murph currently reaches Phantom through SDK-shaped messages, but the richest
   Pi execution facts are compressed before they become SDK messages. Pi has
   `tool_execution_start`, `tool_execution_update`, and `tool_execution_end`
   with tool name, args, partial result, final result, and error state.
3. Murph's current public `tool_progress` type only carries `tool_use_id`,
   `elapsed_ms`, and optional `parent_task_id`. The query mapper turns
   `tool_execution_start` into a zero-elapsed progress pulse, forwards generic
   `tool_progress`, and drops `tool_execution_update` plus
   `tool_execution_end` as lifecycle messages.
4. Phantom can immediately render safer, richer cards from existing start,
   input, result, blocked, and session frames, but it cannot accurately show
   partial output, final duration, exit code, structured artifacts, or real
   execution error state without Murph adding optional generic fields.
5. The right Murph addition is an optional, provider-neutral tool lifecycle
   extension on `tool_progress` or a sibling `tool_lifecycle` message. It
   should describe what happened, not how Phantom should display it.

## Current Event Contract Map

| Runtime fact | Murph or Pi source | SDK-shaped message | Phantom wire | Current UI behavior |
|---|---|---|---|---|
| Provider starts a tool input block | Murph normalized `tool_call_start` from Pi stream events | `stream_event.content_block_start` with `tool_use` | `message.tool_call_start` | Card is created with tool name and MCP flag. |
| Provider streams tool JSON | Murph normalized `tool_call_delta` | `stream_event.content_block_delta` with `input_json_delta` | `message.tool_call_input_delta` | Card stores raw JSON delta in `inputJson`. |
| Provider completes tool input | Murph normalized `tool_call_end` | `stream_event.content_block_stop` or final assistant `tool_use.input` | `message.tool_call_input_end` | Card stores parsed `input`. |
| Runtime starts executing tool | Pi `tool_execution_start` -> Murph normalized `tool_execution_start` | Current Murph emits `tool_progress` with `elapsed_ms: 0` | `message.tool_call_running` | Card becomes running. Tool name is often missing because Murph strips it. |
| Runtime streams partial tool output | Pi `tool_execution_update` with `partialResult` | Current Murph drops it | None | UI has no partial stdout, stderr, status, or artifact updates. |
| Runtime completes tool execution | Pi `tool_execution_end` with `result` and `isError` | Current Murph drops it as lifecycle. Later Pi `toolResult` becomes a synthetic `user` message with `tool_result`. | `message.tool_call_result` if Phantom sees the `user` tool result | UI can show text output, but lacks duration, exit code, artifacts, and often tool name. |
| Tool blocked by hook | Murph `system.hook_response` with `outcome: cancelled` | `system` message | `message.tool_call_blocked` | UI shows blocked state, but current translation uses `hook_id` as `tool_call_id`, so correlation can be wrong unless hook id equals tool id. |
| Query aborted | Phantom writer catches abort | None from Murph needed | `session.aborted`, then `session.done` with `stop_reason: aborted` | Run activity is stopped. Tool-level aborted frame exists but is not emitted by current translator. |
| Tool execution error | Pi `tool_execution_end.isError`, Pi tool result `isError` | Current final tool result can become a safe generic error | `message.tool_call_result` with `status: error`, or `session.error` for run failure | UI expands error cards but hides raw error details by default. |
| Compaction | Murph `system.status: compacting`, `system.compact_boundary` | `system` messages | `session.status`, `session.compact_boundary` | Run activity can show continuity after Phase 10A. |
| Subagent lifecycle | Murph `task_started`, `task_progress`, `task_notification` | `system` messages | `message.subagent_start/progress/end` | Run activity can show subagent status. |

Evidence anchors:

- Phantom wire lifecycle states exist in `src/chat/types.ts:4-12` and
  `src/chat/types-tool.ts:29-87`.
- Phantom translates system, assistant, stream, result, user tool results,
  tool progress, rate limit, and prompt suggestion messages in
  `src/chat/sdk-to-wire.ts:28-50`.
- Tool start and input frames are emitted from assistant and stream events in
  `src/chat/sdk-to-wire-handlers.ts:129-154` and
  `src/chat/sdk-to-wire-handlers.ts:210-275`.
- Tool results are derived from synthetic user `tool_result` blocks in
  `src/chat/sdk-to-wire.ts:172-203`.
- Tool progress currently becomes only `message.tool_call_running` in
  `src/chat/sdk-to-wire.ts:256-271`.
- The client creates placeholders and handles running/result/blocked/aborted
  frames in `chat-ui/src/lib/chat-dispatch-tools.ts:36-154`.
- Tool cards currently show a header, elapsed seconds for running tools, and
  optional output/error/block body in
  `chat-ui/src/components/tool-call-card.tsx:21-140`.

## What Murph Currently Sends To Phantom

Phantom requests the right stream features in `src/agent/chat-query.ts:96-118`:
`includePartialMessages`, `agentProgressSummaries`, and `promptSuggestions`
are enabled.

Murph sends these useful SDK-shaped messages today:

- `system:init`, including tools, MCP server statuses, model, provider, cwd,
  agents, and session id.
- `system:status` for states like `compacting`.
- `system:compact_boundary`.
- `system:task_started`, `system:task_progress`, and
  `system:task_notification`.
- `system:hook_response` for cancelled hook outcomes.
- `assistant` final messages.
- `stream_event` partial assistant events for text, thinking, and tool input.
- `tool_progress`.
- `rate_limit_event`.
- `prompt_suggestion`.
- `user` messages containing synthetic `tool_result` blocks.
- `result` success and error messages.

The important loss happens in Murph:

- `MurphToolProgressMessage` only has `tool_use_id`, `elapsed_ms`, and
  optional `parent_task_id` in
  `/Users/truffle/work/murph/packages/core/src/types/message.ts:335-340`.
- Murph's normalized event union already has `tool_execution_start`,
  `tool_execution_update`, `tool_execution_end`, and `tool_progress` in
  `/Users/truffle/work/murph/packages/core/src/events/normalized-event.ts:101-125`.
- Pi translation preserves execution start, update, and end in
  `/Users/truffle/work/murph/packages/core/src/events/translator-pi.ts:287-316`.
- The query runtime mapper emits `tool_execution_start` as a minimal
  `tool_progress`, emits minimal `tool_progress`, and has no cases for
  `tool_execution_update` or `tool_execution_end` in
  `/Users/truffle/work/murph/packages/core/src/query/query.ts:247-256`.

## Pi Details Available But Not Forwarded

Pi exposes the richer runtime contract Murph should reuse:

- Tool result shape includes `content`, arbitrary structured `details`, and
  optional `terminate`.
- Tool handlers receive an `onUpdate` callback for partial results.
- Agent events include `tool_execution_start` with `toolCallId`, `toolName`,
  and `args`, `tool_execution_update` with `partialResult`, and
  `tool_execution_end` with `result` and `isError`.
- The loop emits `tool_execution_start` before execution, pipes tool
  `onUpdate` callbacks into `tool_execution_update`, and emits
  `tool_execution_end` with final result and error state.

Evidence:

- Pi tool result and callback types are in
  `/Users/truffle/work/pi-mono/packages/agent/src/types.ts:291-322`.
- Pi event types are in
  `/Users/truffle/work/pi-mono/packages/agent/src/types.ts:350-365`.
- Parallel execution emits start and end events in
  `/Users/truffle/work/pi-mono/packages/agent/src/agent-loop.ts:412-459`.
- Partial update emission is in
  `/Users/truffle/work/pi-mono/packages/agent/src/agent-loop.ts:581-590`.
- Final error or result state is emitted in
  `/Users/truffle/work/pi-mono/packages/agent/src/agent-loop.ts:658-665`.

Murph does not yet let Murph-native tool handlers report progress because
`MurphToolHandlerExtra` lacks a progress callback, and
`murphToolToPiTool` does not accept or forward Pi's `onUpdate` parameter.
Evidence:

- Current extra fields are only signal, tool id, cwd, env, session id,
  read state, and spillover dir in
  `/Users/truffle/work/murph/packages/core/src/types/tool.ts:8-16`.
- The Pi adapter's `execute` signature ignores `onUpdate` in
  `/Users/truffle/work/murph/packages/core/src/substrate/pi-adapter.ts:153-183`.

## Provider Compatibility Notes

The generic contract should sit above provider wire differences.

- Anthropic streams tool input as `content_block_start` with `tool_use`,
  `content_block_delta` with `input_json_delta`, and `content_block_stop`.
  Its docs also show thinking deltas and web-search server tool result blocks.
- OpenAI Responses streaming uses typed semantic events. Official docs list
  `ResponseFunctionCallArgumentsDelta` and
  `ResponseFunctionCallArgumentsDone`; the function-calling guide shows
  `response.output_item.added`, repeated
  `response.function_call_arguments.delta`, then
  `response.function_call_arguments.done`.
- OpenAI Chat Completions still streams `delta.tool_calls` and terminates with
  `finish_reason: tool_calls`.
- Z.AI's official docs require `stream=True` plus `tool_stream=True`; deltas
  can contain `reasoning_content`, `content`, and `tool_calls`.

Conclusion: model-authored tool argument streaming is provider-specific, but
runtime tool execution progress is not. Once a provider's tool call is
normalized into Murph's `tool_call_start/delta/end`, every provider should use
the same Murph tool lifecycle contract.

## Proposed Generic Murph Tool Progress Contract

Keep compatibility by extending the current `tool_progress` message with
optional fields. Existing consumers that only read `tool_use_id` and
`elapsed_ms` continue to work.

```ts
export type MurphToolProgressPhase =
  | 'started'
  | 'input'
  | 'running'
  | 'partial_output'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'aborted';

export type MurphSafePreview = {
  text?: string;
  truncated?: boolean;
  full_size?: number;
  full_ref?: string;
};

export type MurphToolArtifactRef = {
  kind: 'file' | 'url' | 'resource';
  uri: string;
  mime_type?: string;
  title?: string;
  size_bytes?: number;
};

export type MurphToolProgressMessage = MurphMessageBase & {
  type: 'tool_progress';
  tool_use_id: string;
  tool_name?: string;
  phase?: MurphToolProgressPhase;
  elapsed_ms: number;
  duration_ms?: number;
  parent_task_id?: string;

  // Runtime facts. Consumers decide display policy.
  input?: unknown;
  input_preview?: MurphSafePreview;
  output_preview?: MurphSafePreview;
  stdout_preview?: MurphSafePreview;
  stderr_preview?: MurphSafePreview;
  exit_code?: number | null;
  signal?: string;
  artifacts?: readonly MurphToolArtifactRef[];
  error?: {
    code?: string;
    message: string;
    recoverable?: boolean;
  };

  // Producer declares these previews are safe to show collapsed by default.
  safe_to_display?: boolean;
  redactions?: readonly string[];
};
```

Runtime mapping:

- `tool_execution_start` should emit `phase: 'started'`, `tool_name`,
  `input`, optional `input_preview`, and `elapsed_ms: 0`.
- `tool_execution_update` should emit `phase: 'partial_output'` or
  `phase: 'running'`, `tool_name`, partial previews, artifacts, and elapsed.
- `tool_execution_end` should emit `phase: 'completed'` or `phase: 'failed'`,
  `tool_name`, duration, result previews, artifacts, and error state.
- Hook blocks should emit `phase: 'blocked'` with the actual `tool_use_id` if
  present, hook name, and a safe reason.
- Abort propagation should emit `phase: 'aborted'` before terminal result if a
  specific tool was active.

This is still generic. Murph exposes lifecycle facts and safe summaries.
Phantom decides which fields are visible, collapsed, or hidden.

## Missing Fields And Ownership

| Missing field or behavior | Current availability | Owner |
|---|---|---|
| `tool_name` on running progress | Pi and NormalizedEvent have it, Murph strips it | Murph |
| `input` on execution start | Pi has validated args, Murph normalized start has input | Murph forwards, Phantom redacts/renders |
| Safe command subtitle from `Bash.command` | Phantom can derive from `tool_call_input_end`; Murph can provide safe preview | Phantom first, Murph optional preview |
| `cwd` | Murph tool extra knows cwd, Phantom can know session cwd only indirectly | Murph optional `input_preview` or metadata, Phantom renders relative path |
| `phase` or status enum | Implied by several event types | Murph |
| Elapsed time | Murph sends elapsed on progress; Phantom can compute local elapsed | Murph for authoritative elapsed, Phantom fallback |
| Final `duration_ms` | Not forwarded for tools | Murph |
| Partial stdout/stderr | Pi `onUpdate` supports partial result, Murph native tools do not call it yet | Murph |
| Exit code and signal | Bash captures them but stringifies into output | Murph |
| Structured result summary | Tool result text exists, structured `details` may exist in Pi | Murph emits previews, Phantom renders |
| Full output reference | Bash spillover path exists in text and spill result | Murph structured artifact/ref, Phantom link rendering |
| Tool error state | Pi has `isError`; final user tool result can carry `is_error` | Murph forwards lifecycle, Phantom safe display |
| Blocked correlation | Current Phantom maps hook id to tool id | Murph should include tool id, Phantom can handle both during migration |
| Tool-level aborted | Phantom frame exists but no Murph emission | Murph |
| Secret redaction | Not guaranteed by generic raw output | Murph producer previews must redact, Phantom must also redact defensively |

## Safe Disclosure Policy For Phantom Tool Cards

Default header:

- Tool name.
- Safe action label, such as "Running command", "Reading file", or
  "Searching web".
- Safe target, preferably project-relative file path, URL host, query preview,
  or command prefix.
- Status: pending, streaming input, running, completed, failed, blocked,
  aborted.
- Elapsed time while running and duration after completion.
- Exit code for command-like tools when available.
- Artifact links when the URI is safe and user-local.

Collapsed by default:

- Full Bash command after redaction and truncation.
- Full cwd, preferably shown as relative path first.
- Raw input preview for known safe keys only.
- stdout and stderr summaries.
- First 200 to 400 lines or a size-bounded preview of text output.
- Full local artifact path, with basename visible in the header.

Expanded only after explicit user action:

- Larger stdout and stderr previews.
- Structured tool input JSON.
- Structured result JSON.
- Full command text.
- MCP server and tool identifiers.

Hidden by default:

- Environment values.
- Secrets, tokens, API keys, OAuth codes, auth headers, cookies, session ids,
  signed URLs, private form values, and request bodies that may contain them.
- Raw hidden reasoning or thinking signatures.
- Base64 payloads, binary content, screenshots, browser page HTML, and fetched
  documents unless converted into explicit artifacts with a privacy gate.
- Full logs that exceed preview limits.

Rendering rules:

- Redact before truncation so a secret cannot survive in the visible prefix.
- Prefer producer-declared safe previews. If absent, Phantom should use a
  conservative allowlist by tool name and input key.
- Treat `output_preview.safe_to_display !== true` as collapsed-only.
- Never execute or auto-link commands. Render them as inert monospace text.
- Treat artifact links as local references or trusted URLs only.

The Manus notes reinforce the same product lesson: command output needs a
presentation layer with exit code, duration, stderr on failure, binary guards,
and overflow handling. Murph should provide those runtime facts; Phantom should
choose the progressive disclosure.

## Phantom-Only Phase 10C Work

These improvements do not require Murph changes:

1. Render richer known-tool subtitles from existing `message.tool_call_input_end`
   inputs:
   - Bash: command preview, timeout, relative cwd if available from session.
   - Read, Write, Edit: project-relative path.
   - Grep, Glob: pattern plus path.
   - WebFetch, WebSearch: URL host or query.
   - Agent and Task: description or workflow name.
2. Improve result body rendering:
   - Parse Murph Bash text output for `exit_code`, `stdout`, and `stderr` as a
     compatibility fallback.
   - Detect the current spillover sentence and surface a file artifact link as
     best effort.
   - Keep large output collapsed and bounded.
3. Harden blocked and error cards:
   - Show hook name and safe reason.
   - Use generic copy when the reason may include sensitive data.
4. Keep cards attached to the assistant message after terminal events.
5. Add defensive redaction in the UI path for common secret patterns.
6. Add tests proving unknown fields are ignored and optional rich fields render
   only when present.

## Murph Phase 10C Work

These need Murph changes:

1. Extend `MurphToolProgressMessage` with optional generic fields:
   `tool_name`, `phase`, `input`, safe previews, stdout/stderr previews,
   `exit_code`, `duration_ms`, artifacts, and structured error.
2. Update `NormalizedRuntimeEventMapper` so:
   - `tool_execution_start` emits `tool_progress` with `phase: 'started'`,
     name, input, and elapsed zero.
   - `tool_execution_update` emits `tool_progress` with
     `phase: 'partial_output'` or `running`, name, partial output preview, and
     elapsed.
   - `tool_execution_end` emits `tool_progress` with `phase: 'completed'` or
     `failed`, result preview, duration, and error state.
3. Add a `reportProgress` callback to `MurphToolHandlerExtra` and pass Pi's
   `onUpdate` through the adapter.
4. Make built-in Bash report:
   - started with command and cwd preview,
   - partial stdout/stderr chunks if feasible,
   - completed or failed with exit code, signal, duration, previews, and
     artifact ref for spillover.
5. Preserve current SDK compatibility:
   - optional fields only,
   - no breaking rename of existing `tool_progress`,
   - same assistant and stream event ordering.
6. Fix hook-block correlation so blocked tool cards use the real tool id when
   available.
7. Emit a tool-level aborted progress frame during abort propagation when a
   tool id is active.
8. Add provider-agnostic fixture tests across Anthropic, OpenAI, and ZAI routes
   so provider-specific stream deltas all normalize into the same lifecycle.

## Test Cases

Phantom unit tests:

- `tool_progress` with only legacy fields still renders a running card.
- Rich `tool_progress` with `tool_name`, `phase`, `elapsed_ms`, and `input`
  updates an orphan placeholder.
- Rich completed progress with `duration_ms`, `exit_code`, stdout/stderr
  previews, and artifact ref renders a collapsed result card.
- Error progress renders safe error copy and does not show raw output by
  default.
- Blocked progress correlates by real `tool_use_id`, with fallback for old
  `hook_id` frames.
- Redaction masks API keys, bearer tokens, cookies, and env assignments in
  command, stdout, stderr, and input previews.
- Unknown optional fields are ignored.
- Existing SDK-style `user.tool_result` frames still produce
  `message.tool_call_result`.

Murph unit tests:

- Pi `tool_execution_start/update/end` produces the new optional progress
  fields in order.
- Murph-native tool handlers receive `reportProgress` and the Pi adapter
  forwards it to `tool_execution_update`.
- Built-in Bash emits command/cwd preview, partial output, final exit code,
  duration, and spillover artifact.
- Bash failure emits `phase: 'failed'` and `exit_code` without throwing away
  stderr.
- Tool abort emits `phase: 'aborted'`.
- Hook block emits `phase: 'blocked'` with real `tool_use_id`.
- No explicit `any` or hidden type escapes are introduced.

SDK compatibility tests:

- A legacy consumer that only reads `tool_use_id` and `elapsed_ms` still passes.
- `includePartialMessages: false` still emits runtime progress.
- `includePartialMessages: true` still emits Anthropic-shaped stream events for
  text, thinking, tool input, assistant stop, and final assistant reconcile.
- Final `user.tool_result` carrier still appears for model-visible tool
  results.
- Error result and session terminal frames remain unchanged.

Live provider verification:

- Anthropic: streamed custom tool call with input JSON deltas, long Bash,
  blocked PreToolUse, failed Bash, large output spillover.
- OpenAI Responses: function call argument delta/done path, long Bash,
  failed Bash, no raw reasoning disclosure.
- OpenAI Chat Completions fallback: streamed `delta.tool_calls` path if the
  selected model uses chat completions.
- Z.AI: `stream=True` and `tool_stream=True` on GLM model, proving
  `reasoning_content`, `content`, and `tool_calls` normalize correctly.
- Provider without tool-argument streaming: one-shot start/input_end still
  creates a good card.
- Compaction during a long tool-heavy turn does not erase active cards.
- Abort during Bash produces session abort and tool aborted progress.

## Builder Prompt Seed

ultrathink. ultrathink. ultrathink.

You are a principal engineer, principal architect, and principal product
manager at Anthropic, all three at once. You are implementing Phase 10C: rich
generic Murph tool progress for Phantom chat, without leaking Phantom UI policy
into Murph.

No context anxiety. No token limits. No time pressure. No cost anxiety. No v2
thinking. There is no v2. Build it right. Take as long as you need.

Mission:

1. Extend Murph's SDK-compatible `tool_progress` message with optional generic
   lifecycle, preview, duration, exit, artifact, and error fields.
2. Forward Pi `tool_execution_start`, `tool_execution_update`, and
   `tool_execution_end` through Murph into SDK-shaped messages.
3. Add Murph-native progress reporting to tool handler extras and wire it
   through the Pi adapter.
4. Update Phantom translation and rendering to use the richer fields while
   staying compatible with legacy frames.
5. Preserve strict TypeScript, clean-room boundaries, and SDK-style stream
   compatibility.

Required reading:

1. `/Users/truffle/.claude/AGENTS.md`
2. `/Users/truffle/.claude/CLAUDE.md`
3. `/Users/truffle/work/murph/AGENTS.md`
4. `/Users/truffle/work/murph/QUALITY-BAR.md`
5. This report
6. Phantom: `src/chat/types.ts`, `src/chat/types-tool.ts`,
   `src/chat/sdk-to-wire.ts`, `src/chat/sdk-to-wire-handlers.ts`,
   `chat-ui/src/lib/chat-types.ts`,
   `chat-ui/src/lib/chat-dispatch-tools.ts`,
   `chat-ui/src/components/tool-call-card.tsx`
7. Murph: `packages/core/src/types/message.ts`,
   `packages/core/src/types/tool.ts`,
   `packages/core/src/events/normalized-event.ts`,
   `packages/core/src/events/translator-pi.ts`,
   `packages/core/src/query/query.ts`,
   `packages/core/src/substrate/pi-adapter.ts`,
   `packages/core/src/tools/built-ins/bash.ts`
8. Pi: `packages/agent/src/types.ts`,
   `packages/agent/src/agent-loop.ts`

Acceptance criteria:

1. Legacy `tool_progress` consumers remain compatible.
2. Tool start/update/end lifecycle facts reach Phantom with tool id, name,
   phase, elapsed or duration, and safe previews when available.
3. Bash reports command/cwd preview, exit code, stdout/stderr previews, and
   artifact ref for spillover.
4. Phantom shows richer tool cards using progressive disclosure and defensive
   redaction.
5. Anthropic, OpenAI, and ZAI routes normalize provider-specific tool input
   streams into the same Murph lifecycle.
6. Tests cover legacy and rich frames, tool errors, blocked, aborted, large
   output, and SDK-style stream compatibility.

Anti-patterns:

1. Do not add Phantom-specific fields to Murph.
2. Do not show raw JSON, secrets, env values, auth headers, cookies, or hidden
   reasoning by default.
3. Do not break existing SDK message names or required fields.
4. Do not parse provider-specific events in Phantom that belong in Murph.
5. Do not copy implementation from reference repos.

## Source Links

- OpenAI streaming responses:
  https://developers.openai.com/api/docs/guides/streaming-responses
- OpenAI function calling streaming:
  https://developers.openai.com/api/docs/guides/function-calling
- Anthropic streaming messages:
  https://platform.claude.com/docs/en/build-with-claude/streaming
- Z.AI stream tool call:
  https://docs.z.ai/guides/tools/stream-tool
