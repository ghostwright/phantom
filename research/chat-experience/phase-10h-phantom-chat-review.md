# Phase 10H Phantom Chat Review

Date: 2026-05-01

Scope: review only. No application code changes.

## Findings

### P1: SDK result errors can still become empty successful assistant rows

`src/chat/sdk-to-wire.ts:240-250` translates a non-success SDK `result` into a `session.error` frame, but `src/agent/chat-query.ts:154-158` only records cost and keeps going unless the result is the special "No conversation found" shape. `src/chat/writer.ts:121-133` then unconditionally commits an assistant message with `response.text` and `stopReason: "end_turn"`.

Impact: provider errors, including post-compaction overflow failures, can leave a normal empty assistant row in durable chat history. That is exactly the wrong trust signal: the run errored, but reload can show a successful blank assistant turn.

Fix direction: make `executeChatQuery` return or throw a typed terminal error for non-success result subtypes. `ChatSessionWriter` should not commit a successful assistant message when the terminal frame is `session.error`; it should persist only the errored run timeline, or an explicit error assistant row if the product wants one.

### P1: Assistant rendering drops all text after the first text block

`chat-ui/src/lib/chat-store.ts:181-200` supports multiple text blocks on one assistant message. That is required for tool loops because the runtime can stream separate content blocks across a single user turn. `chat-ui/src/components/assistant-message.tsx:15-31` then uses `find((b) => b.type === "text")` and renders only the first block.

Impact: if the assistant emits a pre-tool note and later emits the real answer in another text block, the UI can hide the actual answer. This is a direct correctness issue, not just polish.

Fix direction: render all text blocks in order, at minimum by mapping every `message.content` text block to `Markdown`. A later richer version can preserve exact interleaving between thinking, tools, and text, but the next PR should make no text block invisible.

### P1: Uploaded files are sent to the runtime but disappear from the chat record

`src/chat/http-handlers.ts:102-108` builds the SDK message from `attachment_ids`, so the model can receive files. The writer then commits the user message from the SDK content at `src/chat/writer.ts:67-72`, emits `attachments: []` at `src/chat/writer.ts:76-83`, and never calls `ChatAttachmentStore.commitToMessage` from `src/chat/attachment-store.ts:54-60`. The client reducer also discards any user-frame attachments and stores only text at `chat-ui/src/lib/chat-store.ts:130-146`.

There is a second footgun in `chat-ui/src/routes/session-route.tsx:58-64`: if upload fails and returns no IDs, the message still sends without the intended files.

Impact: the user can attach a file, Phantom can use it, then the transcript gives no durable evidence of what was attached. On upload failure, the user may accidentally send a file-dependent prompt without the file.

Fix direction: pass accepted attachment metadata into `ChatSessionWriter`, call `commitToMessage`, emit populated `user.message.attachments`, add attachment content to `ChatMessage`, and render user-message file chips with preview links. If all intended uploads fail, keep the composer text and block send with a clear error.

### P2: Generated pages and files are not first-class artifacts in the UI

The Phantom page tools already return artifact metadata. `src/ui/tools.ts:74-81` returns `path`, `url`, and `size` for `phantom_create_page`, and `src/ui/preview.ts:227-238` returns a screenshot plus JSON metadata for `phantom_preview_page`. The backend can parse this for future model context in `src/chat/continuity-context.ts:125-148`.

The UI path loses that structure. `src/chat/run-timeline.ts:297-307` records only a safe output summary, and `summarizeToolOutput` collapses non-empty output to `"Tool produced output."` at `src/chat/run-timeline.ts:629-633`. `chat-ui/src/lib/chat-activity.ts:115-128` maps only generic tool fields, and `chat-ui/src/components/tool-call-card.tsx:229-245` renders `full_ref` and output as plain text, not as artifact actions or previews.

Impact: a created page, preview screenshot, or generated file is treated like a raw tool log. The user has to read JSON or markdown links instead of seeing a durable artifact chip with title, URL/path, size, preview status, and open/copy actions.

Fix direction: add a small artifact summary contract for Phantom-native tools first: page title, page URL, path, size, preview status, console issue count, failed request count, and optional screenshot reference. This belongs in Phantom built-in/tool summary plus UI affordances, not in a new MCP call.

### P2: Tool identity conflates built-in tools, Phantom-native MCP tools, external MCP tools, and UI actions

Phantom registers core app capabilities as in-process MCP servers in `src/index.ts:249-256`, including dynamic tools, scheduler, reflective memory, web UI, secrets, preview, and browser. The wire translator only infers MCP via string heuristics at `src/chat/sdk-to-wire-handlers.ts:141-150` and `src/chat/sdk-to-wire-handlers.ts:223-232`. For canonical `mcp__server__tool` names, `toolName.split(":")[0]` does not extract the server. The card subtitle logic handles only Claude-style built-ins like `Read`, `Write`, `Bash`, and `WebFetch` at `chat-ui/src/components/tool-call-card.tsx:28-48`.

Impact: a Phantom page creation tool, an external MCP integration, and a generic unknown tool can all render with weak labels. Collapsed cards are less useful than they should be, and the UI cannot choose the right affordance, such as opening a page, previewing a file, showing scheduler metadata, or just labeling an external MCP call.

Fix direction: normalize tool identity into `{ origin, serverName, rawName, displayName, capabilityKind }`. Use Phantom-native mappings for `phantom_create_page`, `phantom_preview_page`, `phantom_generate_login`, scheduler, secrets, memory, and browser. Reserve MCP labeling for external server boundaries. Use UI controls for already-known artifacts instead of forcing the agent to call another tool.

### P2: The live run activity helps, but long tasks can still feel like detached status chrome

`chat-ui/src/components/message-list.tsx:75-94` renders `runActivity` after all messages, separate from the current user request and the assistant answer. `chat-ui/src/components/run-activity-row.tsx:173-249` does show label, elapsed time, facts, subagents, and tool rows, which is the right foundation. The remaining issue is hierarchy: it reads as another transcript row, not the header of the current run.

Impact: long-running tasks no longer go completely silent, but the user still has to infer which request is active and why the agent is quiet. This matters most when a tool has started but there is no assistant prose yet, during compaction, reconnect, browser preview, or long Bash work with little output.

Fix direction: attach the active run strip to the current user message until assistant content starts, then make it the header of the assistant run. Keep elapsed time live. Prefer labels like `Running Bash`, `Previewing page`, `Compacting context`, `Waiting for permission`, and `Reconnected` over generic `Working...` once the frame data supports it.

### P2: Markdown and code rendering are functional, not yet product-grade

`chat-ui/src/components/markdown.tsx:6-49` only customizes code and links. It relies on `prose prose-sm`, but `chat-ui/package.json:13-29` does not include `@tailwindcss/typography`, so those typography classes may be inert depending on the Tailwind v4 setup. `chat-ui/src/components/code-block.tsx:21-45` renders a bordered `pre`, no syntax highlighting, no wrap toggle, no table handling, and copy is hidden behind hover at `chat-ui/src/components/code-block.tsx:28-32`.

Impact: tables, long links, generated URLs, code, and citations will work at a basic level, but they do not feel like a polished developer-facing agent surface. Touch users may not discover copy controls.

Fix direction: add explicit markdown components for tables, lists, blockquotes, links, generated `/ui/...` URLs, and code blocks. Make copy visible on touch/focus, add a wrap toggle, and keep tables horizontally scrollable with tabular numerics.

### P3: Thinking display is safe, but under-informative and not tied to provider capability

The current UI avoids raw chain-of-thought: `chat-ui/src/components/thinking-block.tsx:4-15` shows `Thinking...`, `Thought`, or `Reasoning hidden`. That is safer than exposing private reasoning. However, `src/chat/sdk-to-wire-handlers.ts:269-276` emits `message.thinking_end` without duration, and Murph maps thinking start/delta/end at `/Users/truffle/work/murph/packages/core/src/query/query.ts:317-330` without any UI-facing provider capability summary.

Murph model metadata marks thinking support for OpenAI and ZAI models at `/Users/truffle/work/murph/packages/core/src/providers/models.ts:96-115` and `/Users/truffle/work/murph/packages/core/src/providers/models.ts:162-190`, but Phantom's UI does not know whether the current provider supports visible reasoning, redacted reasoning, summaries, or only effort levels.

Impact: the UI is honest, but it cannot yet tell the user "reasoning is hidden", "reasoned for 8s", or "this provider does not expose reasoning" in a consistent way.

Fix direction: keep raw thinking hidden by default. Add timing and provider/model capability metadata to the safe activity layer. Only show reasoning summaries when Murph has an explicit safe summary contract, not from private thinking deltas.

## Next Builder Slice

Recommended one-PR scope: **chat transcript integrity plus first-class user files**.

Implement:

1. Fix non-success SDK result handling so `session.error` cannot also create an empty successful assistant row.
2. Render every assistant text block, not only the first.
3. Persist, stream, load, and render user attachments as file chips with preview/open metadata.
4. Block send when intended attachments fail to upload.
5. Add small visual polish to the active run strip so it stays visibly attached to the current turn, without building the full artifact drawer yet.

Acceptance criteria:

- No empty assistant commit after SDK `result` subtype errors.
- Multi-block assistant messages show all text blocks.
- Uploaded images, PDFs, and text files appear on the sent user message live and after reload.
- Failed uploads do not silently send the prompt without files.
- A long `sleep` or page-preview run shows visible activity within one second and keeps a live elapsed timer.

## Second Slice Backlog

1. Artifact summaries and previews for `phantom_create_page` and `phantom_preview_page`: URL chip, open, copy, page title, size, preview screenshot, console and network issue counts.
2. Tool identity normalization: distinguish Murph/Pi built-ins, Claude-style built-ins, Phantom-native in-process tools, external MCP tools, and UI-only affordances.
3. Rich tool details: structured parameters, stdout/stderr sections for Bash, file diff summaries for edits, browser/page preview metadata, redaction notices, and safe full-output references.
4. Markdown polish: tables, code highlighting, wrap toggle, always reachable copy, link cards for generated URLs, and mobile-safe overflow.
5. Thinking contract: provider capability labels, duration, hidden reasoning copy, and future safe reasoning summaries when Murph exposes them.
6. Durable artifact gallery: a lightweight session artifact rail fed by existing tool output and file metadata, not by extra agent work.
7. Composer polish: environment/status line, upload progress, attachment error recovery, command affordance, and clearer stop state.

## UI Polish Notes

- Tool cards should stay collapsed by default for completed tools, and auto-open only for error and blocked states. The current behavior at `chat-ui/src/components/tool-call-card.tsx:164-171` is correct.
- Collapsed cards need better content: `phantom_create_page` should show page title/path, `phantom_preview_page` should show preview status and issue counts, Bash should show the command verb and elapsed time, and external MCP should show server plus tool.
- Expanded cards should avoid one raw wall of text. Structure details into Parameters, Output, Artifacts, Errors, Redactions, and Full output.
- The top/header/sidebar/composer borders are still heavy as a stack. `chat-ui/src/components/app-shell.tsx:149-164` and `chat-ui/src/components/chat-input.tsx:97-100` use the same border tone for structural edges and work objects. Keep object borders for tools/code/cards, soften shell boundaries.
- User messages should feel like compact request objects, not chat bubbles. `chat-ui/src/components/user-message.tsx:8-10` is already calmer than saturated purple, but attachments and metadata need to live with the request.
- Avoid faking thinking. The honest states are: reasoning active, reasoning hidden, provider did not expose reasoning, and reasoned for duration if measured.

## Testing Plan

Focused backend:

- `bun test src/chat/__tests__/sdk-to-wire.test.ts`
- Add a non-success `result` test proving `session.error` does not lead to a committed assistant success row.
- `bun test src/chat/__tests__/writer.test.ts`
- Add attachment commit/load tests and upload-failure behavior tests.
- `bun test src/chat/__tests__/run-timeline.test.ts`
- Add page artifact summary tests once the artifact slice starts.

Focused chat UI:

- `cd chat-ui && bun test src/lib/__tests__/chat-store.test.ts`
- Add tests for multi-text-block rendering state, attachment frames, replayed attachment frames, and failed upload no-send behavior.
- Add component tests if the project adds a renderer harness; otherwise verify through production build plus browser.

Build and static gates:

- `bun run typecheck`
- `cd chat-ui && bun run typecheck`
- `cd chat-ui && bun run build`
- `bunx biome check` on touched Phantom files
- `git diff --check`

Live browser verification against Murph:

1. Start Phantom locally with `PHANTOM_AGENT_RUNTIME=murph` and OpenAI.
2. Send a long-running prompt such as `sleep 10 && pwd`; verify activity appears within one second, elapsed time advances, stop works, and the final answer renders.
3. Send a prompt that forces a tool loop with text before and after the tool; verify both text blocks render.
4. Upload an image, a PDF, and a text file; verify chips render live, survive reload, and preview/open actions work.
5. Create and preview a `/ui/...` page; verify tool cards are collapsed but useful, expanded details show structured parameters/output, and follow-up context still knows the page URL after reload.
6. Trigger or simulate a provider result error; verify no empty assistant success row appears and the run timeline shows the error state.
