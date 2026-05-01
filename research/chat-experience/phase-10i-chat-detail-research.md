# Phase 10I Chat Detail Research

Date: 2026-05-01

Scope: research only. No application code changes.

## Executive Recommendation

The next best slice is not a broad redesign. It is a trust slice: make the
current run feel attached to the current user request, make collapsed tool cards
carry real product meaning, and turn Phantom pages/files into durable chat
objects instead of raw tool logs.

Recommended PR order:

1. **PR 1: Live run presence plus structured collapsed tool summaries.** Keep
   the existing calm visual language, but move the active run surface from a
   detached row after the transcript into the current turn. Add normalized tool
   identity and safe collapsed facts to the durable timeline and client state.
   The immediate win is that a long Bash, preview, compaction, reconnect, or
   subagent run never looks idle.
2. **PR 2: First-class page/file artifact cards plus markdown polish.** Use the
   page metadata already returned by `phantom_create_page` and
   `phantom_preview_page` to render inline artifacts with open/copy/preview
   affordances. Add explicit markdown table/list/code/link handling so generated
   reports and URLs look intentional.

Wait on a full artifact drawer, full memory explorer inside chat, transcript
   search, arbitrary workspace file preview, and provider reasoning summaries
   until the smaller contracts below are stable. Those features are right, but
   they should not block the live trust slice.

Important source updates since Phase 10H:

- Assistant text blocks are no longer dropped. `AssistantMessage` now renders
  every assistant text block through `getAssistantTextBlocks`.
- User attachments now stream, persist, reload, and render as chips in the user
  message.
- Upload failures now block send instead of silently sending without intended
  files.
- SDK terminal errors now avoid committing a successful empty assistant row.

Those fixes mean Phase 10I should focus on product depth, not re-solving the
Phase 10H integrity bugs.

## Current UI Findings By Component

### MessageList

`chat-ui/src/components/message-list.tsx` renders saved run timelines under the
message that owns them, but the live `runActivity` still renders after all
messages as a standalone row. This is visible in the Phase 10H screenshots: the
completed activity reads as a separate object below the answer rather than as
the state of the turn.

Fix direction:

- While there is no assistant content yet, visually attach the active run strip
  to the latest user message.
- Once `message.assistant_start` or text starts, make the strip the header of
  the assistant run.
- Preserve the existing live elapsed timer and facts, but improve labels from
  `Using phantom_create_page...` to product labels like `Creating page`,
  `Previewing page`, `Running Bash`, `Reading file`, `Compacting context`, and
  `Reconnected`.

### RunActivityRow

`run-activity-row.tsx` has the right primitives: status icons, elapsed time,
compaction facts, rate-limit facts, MCP server readiness, subagent facts, and
tool cards. The weakness is hierarchy and label quality.

Current issues:

- The row is visually similar to another transcript message, not the current
  run state.
- `activityFacts` can show useful counts, but completed rows still need a more
  scan-friendly summary such as `4 tools`, `1 page`, `1 preview`, `20s`.
- The vertical rule and nested cards create a heavy left rail when replayed
  under a short assistant answer.
- Long-running quiet tools need a heartbeat line such as `Last update 18s ago`
  once a running tool has no new output for a threshold. This should be derived
  from events and timestamps, not invented agent prose.

### ToolCallCard

`tool-call-card.tsx` is correctly collapsed by default and auto-expands only for
error and blocked states. That is the right default. The missing piece is the
collapsed information model.

Current issues:

- Tool identity is ad hoc. Only Claude-style built-ins receive good subtitles.
  Phantom-native MCP tools, external MCP tools, and generic tools often collapse
  to weak labels.
- The MCP server detection is string-based in the client and translator. It
  does not model origin, server, capability kind, or display name.
- `phantom_create_page` and `phantom_preview_page` already return metadata, but
  collapsed cards do not show title, URL, path, size, preview status, console
  count, failed request count, or screenshot availability.
- `fullRef` renders as inert text. It should remain safe and redacted, but it
  needs an explicit copy action and a clear label.
- Expanded output is still a wall of text. It should be structured into
  Parameters, Output, Artifacts, Errors, Redactions, and Full output.

Collapsed cards should show:

- Origin: Phantom, Shell, Files, Web, Memory, External MCP.
- Subject: command, path, URL, title, query, memory type, or artifact filename.
- State: running, completed, blocked, errored, stopped.
- Timing: elapsed while running, duration when complete.
- Result facts: output truncated, full output saved, issue counts, file size,
  match count, or generated artifact count.
- Actions when safe: open page, copy URL, copy path, copy output reference,
  expand details.

### AssistantMessage

Current `AssistantMessage` renders all text blocks, but it still groups
thinking blocks first, then tool calls, then text blocks. Pi web UI renders
assistant chunks in source order, including text, thinking, and tool calls.

Fix direction:

- Do not reintroduce the hidden-text bug. Keep every text block visible.
- In a later slice, preserve interleaving by representing assistant content,
  thinking blocks, and tool calls in one ordered render stream.
- Keep private reasoning hidden. The current `ThinkingBlock` duration support
  is useful, but redacted thinking should remain clearly labeled as hidden.

### UserMessage

User attachment chips are now present and durable. The remaining polish is
ergonomic:

- Long filenames truncate without an explicit copy/open icon.
- User request cards are still bubble-like and use a stronger tint than the
  rest of the chat surface.
- User messages do not get a copy affordance, while assistant messages do.
- File-only sends are blocked by the composer because send requires non-empty
  text. That can wait, but it is a natural file workflow.

### ChatInput

The composer is functional and now blocks failed upload sends. Remaining polish:

- Uploading is represented by attachment tile spinners, but the composer itself
  has no upload-progress or upload-error state.
- Remove buttons on pending attachment tiles are hover-only. Touch users can
  miss them.
- The shell header, sidebar, composer, and card borders all use the same border
  tone, which makes the layout stack feel heavier than the product needs.
- The toolbar has only attachments. Memory, transcript search, and artifact
  controls should eventually be explicit controls, not hidden commands.

### Markdown And Code

`markdown.tsx` uses `react-markdown`, `remark-gfm`, and `rehype-sanitize`, but
only customizes code and links. `package.json` does not include
`@tailwindcss/typography`, so the `prose` classes may not provide the intended
table/list/blockquote styling.

Needed polish:

- Explicit components for tables, lists, blockquotes, horizontal rules, links,
  generated `/ui/...` URLs, and code blocks.
- Tables in a horizontal overflow container with tabular numerics.
- Code copy visible on focus and touch, not only hover.
- Optional wrap toggle for long code and logs.
- Link cards for generated Phantom pages when the URL is known to be safe.

### Chat Activity And Store

`chat-activity.ts` and `chat-store.ts` have a strong foundation for live and
replayed activity. They already support attachments, thinking duration,
compaction, rate limits, subagents, MCP readiness, stream replay, caught-up
state, and durable run timelines.

Missing state shape:

- Tool origin and capability kind.
- Artifact summaries attached to tool summaries.
- Safe output references with copy/open affordances.
- Per-tool updated-at timestamps for quiet long-running tools.
- Provider/model reasoning capability labels. Show `Reasoning hidden`,
  `Reasoned for 8s`, or `Provider did not expose reasoning`; do not show raw
  private thinking.

### Durable Run Timeline

`src/chat/run-timeline.ts` persists the right high-level run structure, but the
tool summary schema is too generic for the next UI slice. It stores name, state,
input/output summaries, timing, truncation, MCP flags, and block reason, but no
artifact data.

The key gap is `summarizeToolOutput`: for successful non-empty output it returns
`Tool produced output.`. That is safe, but it discards exactly the metadata the
chat UI needs for Phantom-native page tools.

Add a structured, allowlisted artifact summary contract for known Phantom tools:

- `phantom_create_page`: title, path, URL, size, created/updated state.
- `phantom_preview_page`: title, path, HTTP status, screenshot reference or
  screenshot availability, console issue count, failed request count, viewport.
- File-producing tools when safe: path, filename, extension, byte count, action.

Do not parse arbitrary external MCP JSON into artifacts. Start with
Phantom-native tools and strictly validate shape.

### UI Tools And Preview

`src/ui/tools.ts` returns exactly the metadata the chat needs for created pages:
`created`, `path`, `url`, `size`, and a note that the URL is not a login link.

`src/ui/preview.ts` returns a PNG image block plus JSON metadata with HTTP
status, title, console messages, and failed network requests. Today that is
useful to the agent, but the chat UI should also use the safe summary.

Fix direction:

- Keep full image bytes out of durable chat summaries unless a bounded storage
  reference exists.
- Store counts and status in the tool summary.
- Render the screenshot thumbnail only through a safe reference or live frame,
  not by dumping base64 into the transcript.

### Pi Web UI Patterns To Borrow

Pi has three patterns worth borrowing, not porting wholesale:

- `ChatPanel` automatically opens an artifact panel when new artifacts are
  created, reconstructs artifacts from existing messages, and exposes a compact
  floating artifact pill with a count.
- `ArtifactsToolRenderer` uses inline artifact pills in tool headers and keeps
  code/log details collapsed by default.
- `ArtifactsPanel` uses tabs for multiple artifacts and per-artifact header
  buttons like preview/code toggle, reload, copy, and download.
- `AttachmentTile` opens a file overlay and keeps touch removal discoverable.
- `Messages.ts` renders assistant chunks in source order.

Phantom should borrow the mental model: inline artifact pills first, a session
artifact rail later, and source-order rendering when the data model supports it.

## Concrete Next Slices, In Order

### Slice 1: Live Run Presence

Goal: the user never wonders if the agent is alive.

Build:

- Attach live run activity to the current turn.
- Keep elapsed time live every second.
- Show the current phase within one second of send.
- Improve labels from raw tool names to capability labels.
- Add quiet-tool heartbeat based on last event time.
- Keep replayed timelines visually identical to live timelines after reload.
- Add mobile-safe wrapping and fixed dimensions so labels, badges, and timers do
  not resize the transcript.

Acceptance:

- A `sleep 12 && pwd` style task shows active state within one second.
- The timer increments while the tool is running.
- The stopped state appears immediately when the user presses stop.
- Reload after completion shows the same run timeline collapsed by default.
- No hidden reasoning or fake progress prose is introduced.

### Slice 2: Tool Identity And Collapsed Card Summaries

Goal: a collapsed tool card is useful without expansion.

Build:

- Add normalized identity:
  `{ origin, serverName, rawName, displayName, capabilityKind }`.
- Add capability mappings for Shell, Files, Search, Web, Phantom pages,
  Phantom preview, Scheduler, Memory, Secrets, Browser, and External MCP.
- Add safe primary subject:
  command, path, URL, title, query, memory type, or artifact filename.
- Add safe result facts:
  duration, output truncated, full output saved, page size, preview status,
  console issue count, failed request count, file size, match count.
- Add open/copy buttons only when data is already known and safe.
- Preserve collapsed-by-default behavior for completed cards. Auto-open only
  error and blocked cards.

Acceptance:

- Bash collapsed card shows command summary, elapsed or duration, and output
  saved/truncated if relevant.
- `phantom_create_page` collapsed card shows page title/path and URL action.
- `phantom_preview_page` collapsed card shows HTTP status, title, issue counts,
  and screenshot availability.
- External MCP cards show server plus tool, not a generic unknown label.
- Expanded card sections are structured and redacted.

### Slice 3: First-Class Page And File Artifacts

Goal: generated files/pages are visible chat objects, not JSON archaeology.

Build:

- Add `ArtifactSummary` to durable tool summaries and client state.
- Render inline artifact cards under the relevant tool or assistant message.
- Page artifact card fields:
  title, path, URL, size, preview status, console issue count, failed request
  count, last preview time, actions.
- File artifact card fields:
  filename, extension/type, path, size when known, action, open/copy affordance.
- Use a `Details` expansion for raw parameters and redacted output.
- Keep the future session artifact rail out of this PR unless the inline card
  contract proves too cramped.

Acceptance:

- Created `/ui/...` pages can be opened from chat without reading JSON.
- The URL can be copied from chat.
- Preview failures show a clear issue count and expandable details.
- Reload preserves artifact cards.
- Login links from `phantom_generate_login` never render as page artifacts.

### Slice 4: Markdown And Small Interaction Polish

Goal: generated reports, code, tables, and links look like product output.

Build:

- Explicit markdown table/list/blockquote/link/code components.
- Code copy visible on touch and keyboard focus.
- Wrap toggle for code and logs.
- Generated Phantom page URL cards when URL is safe.
- Softer shell boundaries, keep object borders on tool/code/artifact cards.
- Attachment tile error styling and touch-visible remove buttons.

Acceptance:

- Tables are readable on desktop and horizontally scroll on mobile.
- Long links do not overflow.
- Copy controls are reachable on touch and keyboard.
- No text overlaps on 390 px mobile width.

### What Should Wait

- Full artifact side panel or gallery.
- Full transcript search UI.
- Full memory explorer inside chat.
- Editing artifacts from chat.
- Arbitrary local filesystem preview.
- Provider reasoning summaries until Murph exposes an explicit safe summary
  contract.
- Rich syntax highlighting unless it is a small dependency choice with no bundle
  or security cost.

## Icon Recommendations

Use `lucide-react` consistently. Avoid emojis as state or object primitives.

- User-visible memory: `BookOpenText`.
- Agent-visible memory context: `Brain` for the cognitive surface,
  `Database` for storage/health.
- Transcript search: `Search` for the action, `ScrollText` for transcript
  history.
- Artifacts: `PanelsTopLeft` for the artifact surface, `SquareStack` for an
  artifact collection, `FileCode2` for code artifacts.
- Files: `File`, `FileText`, `FileCode2`, `Image`, `FileArchive`, `Table`.
- Pages and URLs: `PanelTop` or `Globe2` for pages, `ExternalLink` for open,
  `Copy` for copy URL/path.
- Shell and tools: `Terminal` for Bash, `Search` for Grep/WebSearch,
  `Wrench` for generic tools.
- Tool states: `Loader2` running, `CheckCircle2` complete, `CircleX` error,
  `ShieldAlert` blocked, `AlertCircle` warning, `Square` or `CircleStop`
  stopped.
- Progress: `Activity` for run activity, `Clock3` for elapsed time, `Radio`
  for live connection, `RotateCw` or `RefreshCw` for reconnect/retry,
  `Hourglass` for waiting.
- Preview: `Eye` for preview, `RefreshCw` for re-preview.

## Visual Acceptance Criteria

Desktop criteria:

- At 1440 x 1000, the active run strip is visually attached to the current turn.
- Completed run timelines do not dominate short assistant answers.
- Tool cards stay collapsed by default and fit inside the transcript width.
- Page artifact cards show title/path/action in one scan.
- Expanded details do not show an unstructured JSON wall before the useful
  sections.

Mobile criteria:

- At 390 x 844, no label, badge, filename, URL, code block, or action row
  overlaps adjacent content.
- Tool card headers wrap gracefully and keep state icons visible.
- Attachment remove buttons and code copy buttons are reachable without hover.
- Tables and code scroll horizontally inside their own containers.
- The composer does not jump when attachment status changes.

State criteria:

- Empty chat: calm empty state, no marketing layer.
- Loading session: visible loading skeleton or simple text in the transcript
  area, not only an inert blank screen.
- Long-running: active phase visible within one second.
- Reconnect/replay: `Replaying recent activity` then `Reconnected`, without
  losing the run timeline.
- Error: assistant status and run row clearly show error, with no successful
  blank assistant row.
- Blocked: tool card auto-expands and states the safe block reason.
- Compaction: visible `Compacted context and kept working` state with token
  fact when available.

## Playwright Verification Plan

Use two layers: deterministic visual fixtures for UI states, plus one live smoke
against Phantom-on-Murph.

### Deterministic Screenshots

Create Playwright scenarios that mock the session API and SSE frames:

1. **Long-running live run**
   - User message arrives.
   - `message.tool_call_start`, `message.tool_call_input_end`, and repeated
     `message.tool_call_running` frames arrive.
   - Capture at 1 second, 6 seconds, stopped, completed, and after reload.
2. **Tool card matrix**
   - Bash running/result/error.
   - Read/Write/Edit file tools.
   - `phantom_create_page` success.
   - `phantom_preview_page` success with console and network issues.
   - Blocked tool.
   - External MCP tool.
   - Capture collapsed default and expanded states.
3. **Artifact cards**
   - Page card with URL, path, size, preview status, issue counts, screenshot
     availability.
   - File card with type, size, path, copy/open actions.
   - Reloaded session with durable artifact summaries.
4. **Markdown report**
   - Table, long URL, ordered and unordered lists, blockquote, inline code,
     fenced code, and generated `/ui/...` URL.
   - Capture desktop and mobile.
5. **Attachment states**
   - Image, PDF, text file, uploading, error, durable sent chip.
   - Capture composer and sent message.
6. **Memory and search controls**
   - Only once built. Verify icons, labels, empty state, and no hidden reasoning.

Required viewports:

- Desktop: 1440 x 1000.
- Narrow laptop: 1024 x 768.
- Mobile: 390 x 844.

Assertions:

- No horizontal page overflow.
- Buttons have accessible names.
- Tool cards are collapsed by default except blocked/error.
- Active elapsed timer changes while running.
- Copy/open buttons are visible on keyboard focus.
- Raw JSON is not visible in collapsed artifact cards.

### Live Smoke

After deterministic screenshots pass, run one real local smoke:

1. Start Phantom locally with Murph and OpenAI.
2. Authenticate through the chat UI.
3. Send a prompt that performs a long Bash or page preview task.
4. Capture before tool start, mid-tool, after completion, and after reload.
5. Create and preview a `/ui/...` page.
6. Verify the page artifact card opens the page and copies the URL.
7. Verify no push-notification 503 noise changes chat behavior.

The deterministic layer catches visual regressions cheaply. The live smoke
proves real Murph frames still feed the same UI contract.

## Risks And Edge Cases

- **Sensitive output:** Tool summaries must remain allowlisted and redacted.
  Do not add open actions for arbitrary local paths.
- **Tool JSON variance:** Parse structured artifact data only for known
  Phantom-native tools. Arbitrary MCP output should stay generic.
- **Large screenshots:** Store bounded references or counts, not unbounded base64
  in durable timelines.
- **Multiple tabs:** Expansion state and active run attachment must survive
  resume/replay without duplicating tool cards.
- **Out-of-order frames:** Tool running/result frames can arrive before start in
  recovery paths. The client already has placeholder tools; keep that posture.
- **Mobile density:** Artifact actions can crowd small screens. Use icon buttons
  with tooltips and accessible names.
- **Provider differences:** Some providers expose reasoning duration, some hide
  it, and some expose no reasoning signal. Label capability truthfully.
- **Compaction:** After compaction, artifact summaries must remain durable enough
  for both the user and the agent-visible continuity context.
- **Auth confusion:** `phantom_generate_login` links must never be treated as page
  artifacts. Created `/ui/...` URLs and login URLs need distinct labels.
- **Memory sensitivity:** User-visible memory and agent-visible memory are
  different surfaces. Show what is stored and editable without exposing hidden
  reasoning or private tool output.
