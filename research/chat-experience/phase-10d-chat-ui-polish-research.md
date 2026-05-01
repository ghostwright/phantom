# Phase 10D Chat UI Polish Research

Date: 2026-04-30
Write scope: `research/chat-experience/phase-10d-chat-ui-polish-research.md`

## Scope

This is a research artifact for a full Phantom chat UI polish pass. I inspected
the current chat UI implementation and adjacent Phase 10A synthesis, but did not
edit source code.

Required screenshot paths were no longer readable:

1. `/var/folders/d3/1cwh67m14qd_tszmmjlktqx00000gp/T/TemporaryItems/NSIRD_screencaptureui_u7zK8O/Screenshot 2026-04-30 at 3.18.38 PM.png`
2. `/var/folders/d3/1cwh67m14qd_tszmmjlktqx00000gp/T/TemporaryItems/NSIRD_screencaptureui_jOdIT4/Screenshot 2026-04-30 at 3.19.17 PM.png`
3. `/var/folders/d3/1cwh67m14qd_tszmmjlktqx00000gp/T/TemporaryItems/NSIRD_screencaptureui_PYcg1I/Screenshot 2026-04-30 at 3.19.23 PM.png`

The critique below is grounded in the screenshot problem statement from the
prompt and verified against the current component and CSS structure.

## Current Evidence

Phase 10A established that Phantom now has enough runtime signal to show active
work, but not enough polished product hierarchy. The product gap is no longer
"does anything stream?" It is "does this feel like a trusted workspace where an
agent is working on its own computer?"

Current implementation facts:

- Global tokens use a warm cream base and Phantom purple primary, with borders
  set to `#e2dfd6` in light mode and `#2e2924` in dark mode:
  `chat-ui/src/styles/globals.css:5`.
- The app shell stacks a sidebar border, sidebar header border, sidebar footer
  border, main header border, and composer top border:
  `chat-ui/src/components/app-shell.tsx:149`,
  `chat-ui/src/components/app-shell.tsx:164`,
  `chat-ui/src/components/sidebar-panel.tsx:26`,
  `chat-ui/src/components/sidebar-footer.tsx:19`,
  `chat-ui/src/components/chat-input.tsx:97`.
- Messages are rendered in a single centered column with `max-w-3xl` and
  `space-y-4`: `chat-ui/src/components/message-list.tsx:77`.
- User messages are saturated purple rounded bubbles:
  `chat-ui/src/components/user-message.tsx:8`.
- Assistant messages are mostly unframed markdown plus inline thinking and
  tools: `chat-ui/src/components/assistant-message.tsx:20`.
- Active run state renders as a separate row after all messages:
  `chat-ui/src/components/message-list.tsx:89`.
- Tool cards have stateful borders and an expandable body, but the expanded body
  only renders `error`, `blockReason`, or `output`. `inputJson` makes the card
  expandable but is not displayed: `chat-ui/src/components/tool-call-card.tsx:100`
  and `chat-ui/src/components/tool-call-card.tsx:131`.
- Code blocks are bordered boxes with optional language header and copy button,
  but no syntax highlighting, wrap policy, line affordances, or download action:
  `chat-ui/src/components/code-block.tsx:21`.
- The composer is a generic bordered card with attach, textarea, and send or
  stop button: `chat-ui/src/components/chat-input.tsx:96`.

## Screenshot-Backed Critique

Because the original screenshots expired, this section treats the prompt's
visible problems as screenshot evidence and uses source inspection to identify
their causes.

1. Header and sidebar borders feel heavy because every structural boundary uses
   the same `border-border` weight and tone. The sidebar does not visually
   recede from the working transcript, and the top header competes with the
   conversation. Linear's 2026 UI refresh explicitly calls out consistent
   headers and dimmer sidebars so the main content stands out. Phantom should
   make the same move.

2. Message bubbles feel coarse because the user bubble is a large saturated
   rounded shape while the assistant answer is mostly raw page text. The result
   is chat-app polarity, not operational workspace hierarchy. User intent should
   read like a compact request object. Assistant answers should read like a
   durable work result.

3. Code blocks feel coarse because the current block is only a bordered `pre`
   with a hover copy button. It is functional, but it lacks the professional
   affordances users expect in developer tools: syntax color, header metadata,
   persistent copy affordance on touch, sane wrapping, horizontal scroll
   containment, and a calmer surface than full-card chrome.

4. Tool cards prove that tools exist, but not what work happened. Expanded
   details show raw output when available, yet do not render commands,
   parameters, stdout and stderr separation, browser steps, fetched URL
   metadata, file diff summaries, artifacts, timing, redaction state, or retry
   affordances. This is the largest trust gap.

5. The composer feels like a generic chat box because it does not expose the
   job context. There is no visible target environment, attachment status
   beyond thumbnails, tool or mode hint, command affordance, or "agent will work
   on its computer" signal. Cursor's agent composer demonstrates how even tiny
   labels such as `/ for commands` and `@ for files` can make a composer feel
   like a work surface.

6. Thinking, tools, and final answers do not have a clear hierarchy. Thinking is
   currently an inline text row, active run status is a separate row, and tools
   can appear either attached to an assistant message or the active-run sentinel.
   The user sees fragments of work, but not a coherent run story.

## Reference Analysis

These are not decorative inspiration sources. They point to durable product
patterns Phantom should adapt.

### Linear

Linear's March 2026 UI refresh frames the goal well: calmer, more consistent
interface chrome, scannable information, consistent headers and navigation, and
sidebars that visually recede so the main content stands out. Linear's sidebar
customization also reinforces that dense operational products need personalized
left navigation, unread signal, and progressive hiding, not more chrome.

Implication for Phantom: reduce border contrast, dim the sidebar background,
make the main transcript the bright working surface, and keep navigation dense.

Sources:

- https://linear.app/changelog
- https://linear.app/changelog/2024-12-18-personalized-sidebar

### Cursor

Cursor's product page shows agent work as a compact sequence of verbs:
read files, searched handlers, edited a file, done. The same page shows a CLI
agent with a visible thought duration and file-delta chips such as
`summary.py +150 -0`. Recent Cursor changelogs emphasize run-scoped status,
SSE reconnect, clearer terminal states, durable canvases in a side panel, and
multi-agent tiled layouts.

Implication for Phantom: the main unit is a run, not just a message. Tool work
should be summarized as a compact activity sequence with rich expansion. Artifacts
need a durable place, not just markdown links.

Sources:

- https://cursor.com/product
- https://cursor.com/changelog

### OpenAI Codex

OpenAI describes Codex as a command center for long-running, multi-agent work.
The product screenshots and copy emphasize active tasks, workspaces, projects,
skills, and agents running in parallel. The important UI lesson is not to copy
Codex styling. It is that agent work needs coordination surfaces and persistent
task state.

Implication for Phantom: chat should keep the assistant answer primary, but a
run should also expose status, work evidence, artifacts, and resumable context.

Sources:

- https://openai.com/codex/
- https://openai.com/index/introducing-the-codex-app/

### Vercel AI Elements

Vercel AI Elements has explicit components for Tool, Reasoning, Sources, and
Chain of Thought. The Tool component treats pending, running, completed, denied,
and error states as first-class UI states. Reasoning opens while streaming and
can collapse when finished. Chain of Thought models discrete steps with active,
pending, and complete status.

Implication for Phantom: do not dump tools as generic cards. Use status-aware,
collapsible work units. Keep raw reasoning protected, but surface safe progress
steps where the data supports them.

Sources:

- https://elements.ai-sdk.dev/components/tool
- https://elements.ai-sdk.dev/components/reasoning
- https://elements.ai-sdk.dev/components/chain-of-thought

### Notion

Notion AI is strongest where AI work is embedded in the work object. Inline AI
edits can be accepted, discarded, or retried, and AI blocks can be given
specific context from the workspace. The user is not forced to treat every AI
operation as a chat transcript.

Implication for Phantom: artifacts and file edits should become inspectable work
objects. Chat can announce and summarize them, but detailed review should happen
in a focused artifact or details surface.

Source:

- https://www.notion.com/id/help/notion-ai-faqs

### Accessibility References

WAI-ARIA disclosure guidance maps directly to tool and details rows: the trigger
must be a button, support Enter and Space, set `aria-expanded`, and optionally
`aria-controls`. WCAG 2.2 target size guidance matters because Phantom's small
icon buttons are fine on desktop but not enough on touch.

Sources:

- https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/
- https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum

## Design System Direction

Phantom should feel like a quiet operator console, not a consumer chat app.

### Visual Principles

1. Quiet chrome. Header, sidebar, composer, and transcript boundaries should use
   low-contrast separators, not stacked box borders. The working surface should
   win.
2. Dense but readable. Reduce decorative card mass and use compact rows, rails,
   metadata chips, and disclosure. No nested cards.
3. Answer primary, work inspectable. The final assistant answer is the main
   content. Work evidence is visible, compact, and expandable.
4. Type hierarchy before color. Use font size, weight, spacing, and icon shape
   before saturated border colors.
5. Status semantics are consistent. Starting, thinking, running, blocked,
   compacting, errored, aborted, and completed should each have one visual
   language across run rows and tool rows.
6. Artifact-first for durable outputs. Files, browser screenshots, generated
   pages, and reports should become artifacts with metadata and actions.

### Token Direction

- Keep Phantom purple as the command color, but stop using it as the whole user
  bubble surface on desktop. Use a pale request surface or subtle accent rail,
  with saturated purple reserved for primary actions and active status.
- Add semantic surfaces:
  - `surface-canvas`: app background.
  - `surface-work`: transcript surface.
  - `surface-raised`: composer and popovers.
  - `surface-subtle`: tool expanded body and code headers.
  - `border-subtle`: structural boundaries.
  - `border-object`: tool, code, and artifact boundaries.
- Add state tokens:
  - `state-working`: primary.
  - `state-success`: green, used sparingly.
  - `state-warning`: amber.
  - `state-danger`: red.
  - `state-muted`: neutral completed and historical.
- Keep radius mostly 6 to 8 px for operational objects. Reserve 10 to 12 px for
  composer and sheets. Avoid 16 to 20 px chat bubbles except on mobile where
  thumb-friendly tactility matters.

### Layout Direction

Desktop should be a three-band workbench:

1. Sidebar: dim navigation, compact sessions, no heavy border stack.
2. Transcript: centered but wider work column, 760 to 920 px depending on
   viewport, with an optional activity rail inside assistant runs.
3. Composer: sticky bottom work surface with status, attachment context, and
   commands, not just a textarea.

## Information Architecture

### User Messages

User messages should be compact request objects:

- Right aligned or full-width aligned to the transcript grid.
- Light surface with a thin accent edge, not a saturated speech bubble on
  desktop.
- Include attachments as small pills or thumbnails under the request.
- Preserve multiline text and long paths without overflow.
- Actions are copy and maybe "start from here" later, but no visible clutter.

### Assistant Final Answers

Assistant answers should be primary content:

- Left aligned, mostly unboxed.
- Markdown should have a polished prose scale.
- Code blocks should have professional headers, syntax highlighting, copy, wrap
  toggle, and horizontal scroll containment.
- Completion metadata should be compact and secondary: duration, tokens, cost,
  model or provider if available.
- Message actions should be reachable by keyboard and visible on touch, not only
  hover.

### Active Run Status

Active run status should attach to the current turn, not float as an unrelated
row after the transcript.

Recommended structure:

- A `RunSummary` strip under the user's request until assistant content begins.
- After assistant content exists, the run strip becomes the header of an
  `AssistantRun` block.
- It shows current label, elapsed time, stop button affordance, and top one to
  three facts.
- It never says "Working..." alone for more than a short grace period when tool
  or status data exists.

### Thinking

Normal mode should show safe thinking state, not raw chain-of-thought:

- Collapsed completed state: "Reasoned for 7s" or "Planned next step".
- Streaming state: animated, but subtle. No pulsing brain as the main visual.
- Expanded state should show safe summaries only if the data contract provides
  them. Until then, expansion can explain that reasoning content is hidden.

### Tool Calls

Use a hybrid layout:

- Inline summary rail for tool sequence inside the assistant run.
- Tool cards as compact rows in that rail, not large standalone cards.
- Rich details drawer or sheet for long output, browser traces, screenshots,
  diffs, and artifacts.

Why hybrid:

- Pure inline details make long tool-heavy runs unreadable.
- A pure drawer hides evidence and makes the transcript look idle.
- A timeline rail preserves trust while a drawer handles inspection.

### Artifacts

Artifacts need a first-class tray:

- Inline artifact chips under the answer for created or modified files,
  screenshots, generated pages, reports, and downloads.
- Desktop can also show a right-side artifact drawer when opened.
- Mobile should use a bottom sheet.
- Each artifact needs type, title, path or URL, creation source, updated time,
  and primary action.

### Compaction

Compaction should be a continuity event:

- Inline run event: "Compacted context and kept working."
- Show pre-token count only in expanded details.
- Avoid implying memory loss or reset.
- In completed transcripts, keep compaction as a historical timeline item.

### Errors

Errors should be recovery states:

- Error summary visible inline with plain language.
- Expanded details include technical error, tool name, last safe action, and
  retry or resume action if supported.
- Fatal run error should not erase previous tool evidence.
- Blocked tools should name the policy source when available and show a safe
  remediation path.

## Pure CSS And Layout Problems

These can be fixed in Phase 10D without changing the server data contract:

1. Reduce structural border weight and contrast across app shell, sidebar,
   header, transcript, and composer.
2. Rebalance light and dark surfaces so the sidebar recedes and the transcript
   feels like the primary work plane.
3. Replace saturated desktop user bubbles with compact request blocks.
4. Refine assistant markdown type scale, list spacing, paragraph rhythm, and
   max-width.
5. Upgrade code-block styling with a calmer header, visible copy button on
   touch, scroll containment, and a clear language label.
6. Convert tool cards from large bordered cards to compact work rows with state
   badges and a consistent disclosure pattern.
7. Make the composer feel like a work surface through layout: taller tap
   targets, status footer, attachment strip polish, and command/file affordance
   copy in the placeholder or toolbar.
8. Fix text truncation and overflow rules for long paths, commands, URLs,
   filenames, and tool facts.
9. Improve mobile shell behavior with an overlay sidebar, bottom-sheet details,
   and safe-area padding.

## Data Model Or Event Improvements Needed

These should not block a visual Phase 10D pass, but they limit how good the
expanded details can be.

1. Tool result kind. `ToolCallState.output` is a string. Rich UI needs a
   discriminated shape for command, stdout, stderr, browser activity, web fetch,
   file operation, artifact creation, permission, and generic JSON.
2. Input summaries. Current `inputJson` is present but the UI does not render it.
   A safe input summary would let the card show command, path, URL, query, or
   browser action without exposing secrets.
3. Output redaction metadata. The UI needs to know whether output was redacted,
   truncated, secret-filtered, or unavailable.
4. Tool timing. `elapsedSeconds` and `durationMs` exist in places, but the run
   story needs started, updated, completed, and duration for every tool.
5. Tool stream chunks. Long-running commands need partial stdout or summarized
   progress, not just a final string.
6. Browser activity. Browser tools need URL, page title, action, screenshot
   reference, console errors, network errors, and privacy gate metadata.
7. File edits. File operations need path, operation, diff stat, insertion and
   deletion counts, language, and optional diff artifact ID.
8. Artifact records. Artifacts need durable IDs, type, title, path or URL,
   preview kind, size, origin tool, and retention.
9. Turn association. `runActivity` is global and rendered after all messages.
   Durable polish needs run IDs and message IDs so activity attaches to the
   correct user turn and assistant answer after refresh.
10. Suggestions. `session.suggestion` is currently ignored. A polished composer
    can surface safe follow-up suggestions after completion if the contract is
    cleaned up.

## Expanded Tool Details

Phase 10D can make a better shell now, with richer content deferred where data
is missing.

### Stdout

Render as a terminal output panel:

- Header: command tool name, exit state, duration, copy button.
- Body: monospace output with line wrapping toggle, max height, search later.
- Show truncation and redaction badges.
- Separate stdout and stderr when the contract can provide it.

### Command

Render the command separately from output:

- Command block at top with shell icon and copy action.
- Working directory if available.
- Environment indicator only if safe, never raw env values.
- Exit code, signal, and duration when available.

Current limitation: command can be inferred from `inputJson` for Bash, but a
safe parsed command should be explicit.

### Browser Activity

Render as a browser trace:

- Sequence rows: navigate, click, type, wait, screenshot, extract.
- Page title and origin domain.
- Screenshot thumbnail only when safe and available.
- Console or network errors as collapsible subdetails.
- Privacy gate for form values, cookies, auth pages, and user data.

Current limitation: the chat UI has no browser-specific tool result shape.

### Web Fetch

Render as a source card:

- URL, title, status code, content type, fetched time.
- Short safe summary or excerpt.
- Open source action.
- Raw body collapsed and redacted by default.

Current limitation: `WebFetch` subtitle can show URL, but result is still just a
string.

### File Edit

Render as an edit summary:

- Path, operation, language, plus and minus counts.
- Small diff-stat chip.
- Open artifact or view diff action.
- Expanded diff view only when a safe diff artifact exists.

Current limitation: file edit tool input can expose path, but result lacks
structured diff metadata.

### Artifact Creation

Render as an artifact object:

- Type icon, title, path or URL, size, created time.
- Preview thumbnail for images, browser screenshots, pages, and PDFs.
- Actions: open, copy path, download if applicable.
- Link artifact back to the tool that created it.

Current limitation: artifact records are not first-class in chat state.

## Component-Level Plan

### Global Styles

File: `chat-ui/src/styles/globals.css`

- Add surface and state tokens without changing the brand identity.
- Add `.dark` counterparts for new tokens.
- Add reusable utility classes for transcript prose, code surfaces, tool rows,
  and muted separators if Tailwind token use becomes repetitive.
- Keep colors multi-hue and operational. Avoid turning the app into a cream and
  purple one-note palette.

### App Shell

Files:

- `chat-ui/src/components/app-shell.tsx`
- `chat-ui/src/components/sidebar-panel.tsx`
- `chat-ui/src/components/sidebar-session-list.tsx`
- `chat-ui/src/components/sidebar-session-item.tsx`
- `chat-ui/src/components/sidebar-footer.tsx`

Plan:

- Reduce header height or visual weight while preserving the agent identity.
- Replace hard borders with subtle separators or shadowless tonal separation.
- Make sidebar dimmer than main content.
- On mobile, render sidebar as sheet or overlay instead of consuming horizontal
  space from the main chat.
- Ensure active session state remains visible without relying on heavy fill.

### Message List And Runs

Files:

- `chat-ui/src/components/message-list.tsx`
- `chat-ui/src/components/message.tsx`
- `chat-ui/src/components/assistant-message.tsx`
- `chat-ui/src/components/run-activity-row.tsx`

Plan:

- Introduce an `AssistantRun` visual grouping even if the state still arrives as
  `message`, `toolCalls`, `thinkingBlocks`, and `runActivity`.
- Render active run status near the current turn instead of as an unrelated
  trailing row where possible.
- Add a thin activity rail inside assistant runs for thinking, tools,
  compaction, and errors.
- Keep final markdown visually dominant.
- Preserve completed activity after terminal events.

### User Message

File: `chat-ui/src/components/user-message.tsx`

Plan:

- Replace saturated bubble with compact request surface on desktop.
- Keep clear role distinction using alignment, accent, and metadata rather than
  a large filled bubble.
- Add attachment rendering support if user attachments are available in message
  content later.

### Assistant Message

File: `chat-ui/src/components/assistant-message.tsx`

Plan:

- Split assistant output into three stacked zones: run evidence, final answer,
  completion metadata.
- Move cost and token metadata into a subtle footer row with consistent spacing.
- Make message actions visible on focus and touch, not hover only.

### Tool Call Card

File: `chat-ui/src/components/tool-call-card.tsx`

Plan:

- Rename conceptually from card to row in the UI, even if the file name stays.
- Use a status badge plus tool icon. Do not animate the tool icon itself.
- Show one safe primary fact: command, path, query, URL, or tool name.
- Add `aria-expanded` and `aria-controls` for the disclosure trigger.
- Render parsed input when output is absent, because current `hasBody` includes
  `inputJson`.
- Use different expanded templates for command-like, file-like, web-like, and
  generic tools using current available fields.
- Keep errors and blocked states auto-open.

### Thinking Block

File: `chat-ui/src/components/thinking-block.tsx`

Plan:

- Move from brain icon row to small disclosure-style reasoning state.
- Completed state should collapse to duration.
- Streaming state should be subtle and should not compete with tool activity.
- Redacted state should be framed as normal privacy behavior, not a failure.

### Code Block And Markdown

Files:

- `chat-ui/src/components/code-block.tsx`
- `chat-ui/src/components/markdown.tsx`

Plan:

- Add syntax highlighting if an existing lightweight dependency or local highlighter
  is acceptable to the branch owner. If not, improve shell only.
- Keep copy action visible on touch and focus.
- Add a wrap toggle for long single-line output.
- Prevent code from expanding the transcript width.
- Normalize prose spacing for tables, lists, blockquotes, and inline code.

### Composer

Files:

- `chat-ui/src/components/chat-input.tsx`
- `chat-ui/src/components/chat-input-toolbar.tsx`
- `chat-ui/src/components/attachment-strip.tsx`
- `chat-ui/src/components/attachment-tile.tsx`

Plan:

- Turn the composer into a work surface with two zones:
  - Main textarea.
  - Footer toolbar with attach, command hint, context hint, stop/send, and upload
    state.
- Replace placeholder with agent-specific work language, for example "Ask
  Phantom to work..." if product approves.
- Add visible affordances for files and commands. Cursor's `/` and `@` pattern
  is a useful reference, but Phantom should only claim commands that exist.
- Make touch targets at least 40 px on mobile, and ideally 44 px for primary
  send and stop controls.
- Improve attachment remove button size and always-visible behavior on touch.

## Responsive Plan

### Desktop

- Keep a persistent sidebar above roughly 900 px.
- Transcript max width should increase from `max-w-3xl` to a workbench width
  that supports code and tool details, approximately 820 to 920 px.
- Use inline activity rail for run evidence.
- Use right-side drawer for rich tool details and artifacts when opened.
- Composer should stay sticky, centered to the transcript width, with safe bottom
  padding.

### Tablet

- Sidebar becomes collapsible overlay.
- Transcript remains single column.
- Tool details open in a modal sheet or full-width drawer.
- Activity rail remains inline but more compact.

### Mobile

- Sidebar is a sheet with backdrop.
- User request block can keep a more bubble-like shape, but must not exceed
  container width.
- Tool rows show icon, status, one-line label, duration, and chevron.
- Expanded tool details open in a bottom sheet, not inline, for long output.
- Composer uses safe-area padding and 44 px primary touch targets.
- Header should avoid taking too much vertical space.
- Message actions must be visible without hover.

## Phase 10D Recommendation

Build Phase 10D as a visual and interaction polish pass on top of existing
signals. Do not wait for a richer Murph contract to fix the obvious interface
quality issues.

Do in Phase 10D:

1. Shell polish: quieter borders, better surfaces, sidebar hierarchy.
2. Transcript polish: request block, assistant answer hierarchy, message actions.
3. Code block polish: header, copy behavior, overflow, optional highlighting.
4. Run evidence polish: coherent run row and activity rail using existing
   `runActivity`, `thinkingBlocks`, and `activeToolCalls`.
5. Tool row polish: compact rows, disclosure semantics, render current parsed
   input and output more usefully.
6. Composer polish: work-surface layout, better attachment treatment, mobile
   targets.
7. Mobile polish: sidebar overlay and details sheet behavior if feasible without
   broad state changes.

Wait for richer data contract:

1. Browser trace thumbnails and action-level browser replay.
2. Structured stdout and stderr separation.
3. File diff previews and exact changed-line summaries.
4. Durable artifact tray backed by artifact IDs.
5. Per-run durable timeline after refresh.
6. Safe reasoning summaries beyond simple duration and hidden state.
7. Retry/resume actions that depend on tool or run IDs.

## Accessibility And Keyboard Details

Must-have:

- Tool and reasoning disclosures use real `button` controls with
  `aria-expanded`, optional `aria-controls`, and Enter and Space activation.
- Interactive controls must be reachable by keyboard in source order matching
  visual order.
- Hover-only actions need focus-visible and touch-visible equivalents.
- Streaming status should use restrained `aria-live` updates. The current
  debounced text live region is a good start, but tool status and errors also
  need screen-reader understandable updates.
- Stop generation must remain keyboard reachable and announced while streaming.
- Icon-only buttons need accessible names and tooltips on desktop.
- Mobile touch targets should be 44 px for primary controls, and no target
  should be below the WCAG 2.2 24 px minimum with inadequate spacing.
- Color cannot be the only status cue. Use icon, label, and state text.
- Focus rings must not be clipped by overflow-hidden card containers.
- Long output panels need focus management so keyboard users can enter, scroll,
  copy, and leave without trapping focus.
- Reduced motion should disable non-essential pulse and spin animations.

## Verification Plan

### Static And Unit Checks

- `cd chat-ui && bun run typecheck`
- `cd chat-ui && bun run test`
- `bun run typecheck`
- Targeted component tests for:
  - tool disclosure open and closed states
  - error and blocked tools auto-open
  - active run row before assistant text
  - completed activity preserved
  - long command, long path, long URL, and long output containment
  - attachment remove button keyboard and touch visibility

### Browser Screenshot Matrix

Use real browser checks, not only component snapshots.

Desktop:

- 1440 x 1000 light
- 1440 x 1000 dark
- 1280 x 800 light

Tablet:

- 834 x 1112 light
- 834 x 1112 dark

Mobile:

- 390 x 844 light
- 390 x 844 dark
- 360 x 740 light for narrow overflow

### Scenario Matrix

1. Empty state plus composer.
2. Short user message and short assistant answer.
3. Long multiline user prompt with paths and URLs.
4. Assistant answer with headings, list, table, inline code, and code block.
5. Active run before assistant text.
6. Running Bash tool with elapsed time.
7. Completed Bash tool with long output.
8. Error tool.
9. Blocked tool.
10. WebFetch or WebSearch tool.
11. File read or edit tool.
12. Compaction event.
13. Rate-limit warning or rejection.
14. Aborted run.
15. Attachment strip with image, PDF, and code file.
16. Sidebar open and closed on mobile.
17. Details drawer or sheet open for a long tool result.

### Manual QA

- Keyboard tab order from sidebar to transcript to composer.
- `Cmd` or `Ctrl` shortcuts still work: new session, focus composer, stop
  generation, command palette, keyboard help.
- Screen reader smoke test for streaming status, disclosure state, and errors.
- Text resize to 200 percent.
- Forced colors or high contrast smoke test for icon-only state indicators.
- No horizontal page scroll at narrow widths.
- No overlapping header, composer, dropdown, sheet, or toast.

## Builder Prompt Seed

ultrathink. ultrathink. ultrathink.

You are a principal engineer, principal architect, and principal product manager
at Anthropic, all three at once. You are implementing Phantom Phase 10D chat UI
polish for an AI co-worker with its own computer.

No context anxiety. No token limits. No time pressure. No cost anxiety. No v2
thinking. There is no v2. Build it right. Take as long as you need.

Read, in order:

1. `/Users/truffle/.claude/AGENTS.md`
2. `/Users/truffle/.claude/CLAUDE.md`
3. `research/chat-experience/phase-10a-synthesis.md`
4. `research/chat-experience/phase-10d-chat-ui-polish-research.md`
5. `chat-ui/src/styles/globals.css`
6. `chat-ui/src/components/app-shell.tsx`
7. `chat-ui/src/components/sidebar-panel.tsx`
8. `chat-ui/src/components/message-list.tsx`
9. `chat-ui/src/components/user-message.tsx`
10. `chat-ui/src/components/assistant-message.tsx`
11. `chat-ui/src/components/run-activity-row.tsx`
12. `chat-ui/src/components/tool-call-card.tsx`
13. `chat-ui/src/components/thinking-block.tsx`
14. `chat-ui/src/components/code-block.tsx`
15. `chat-ui/src/components/markdown.tsx`
16. `chat-ui/src/components/chat-input.tsx`
17. `chat-ui/src/components/chat-input-toolbar.tsx`
18. `chat-ui/src/components/attachment-strip.tsx`
19. `chat-ui/src/components/attachment-tile.tsx`
20. `chat-ui/src/hooks/use-chat.ts`
21. `chat-ui/src/lib/chat-store.ts`
22. `chat-ui/src/lib/chat-types.ts`
23. `chat-ui/src/lib/chat-activity.ts`
24. `chat-ui/src/lib/chat-dispatch-tools.ts`

Use Context7 for any library APIs you touch, especially Radix, shadcn-style
components, Tailwind, React Markdown, syntax highlighting, and browser testing.

Mission:

Make Phantom chat feel like a quiet, dense, trusted agent workspace. Keep the
answer primary. Make activity inspectable. Do not add marketing surfaces. Do not
redesign around vibes. Ground every change in the current files and this
research.

Deliverables:

1. Quieter app shell and sidebar.
2. Polished transcript hierarchy for user requests and assistant answers.
3. Compact, status-aware run activity and tool rows.
4. Better tool expanded details using existing fields.
5. Better thinking disclosure without raw chain-of-thought exposure.
6. Professional code block styling and overflow behavior.
7. Composer work-surface polish.
8. Mobile layout and touch target improvements.
9. Focused tests for behavior and layout risks.
10. Browser screenshots across desktop and mobile.

Acceptance criteria:

1. No source file uses explicit `any`, `@ts-ignore`, or hidden type escapes.
2. No raw chain-of-thought is shown by default.
3. Long commands, paths, URLs, code, and output never overflow the viewport.
4. Tool disclosures are keyboard accessible and expose expanded state.
5. The active run is visibly working before assistant text exists.
6. Error and blocked tool states are visually clear and inspectable.
7. Mobile has no hover-only required controls.
8. Screenshots prove light and dark desktop and mobile states.
9. `cd chat-ui && bun run typecheck` passes.
10. Relevant tests pass.

Anti-patterns:

1. No oversized cards, decorative hero, gradient blobs, or decorative noise.
2. No cards inside cards.
3. No hiding important work state behind tiny icons only.
4. No raw secret-bearing logs by default.
5. No Phantom-specific runtime shortcuts that belong in Murph.
6. No broad source refactors unrelated to chat polish.
7. No desktop-only polish that leaves mobile broken.
8. No visual churn without browser screenshots.

ultrathink before editing. Self-review against every acceptance criterion before
handoff.

## Self-Review

- Screenshot-backed critique: included, with explicit note that original
  screenshot files expired and with source-verified causes.
- Best-in-class references: included from Linear, Cursor, OpenAI Codex, Vercel
  AI Elements, Notion, and WAI/WCAG primary sources.
- Phantom design system direction: included.
- Component-level implementation plan: included.
- Responsive layout plan: included.
- Test and screenshot verification plan: included.
- Builder prompt seed: included.
- Phase separation: CSS/layout versus data contract work is explicit.
- Safety: no source code edits, no commits, no pushes.
