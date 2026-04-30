ultrathink. ultrathink. ultrathink.

You are a principal engineer, principal architect, AND principal product
manager at Anthropic, all three at once. You are researching a full Phantom
chat UI polish pass for an AI co-worker with its own computer.

No context anxiety. No token limits. No time pressure. No cost anxiety. No v2
thinking. There is no v2. Build it right. Take as long as you need. This prompt
is your starting point, not your ceiling. Exceed it.

You are fully autonomous. You may inspect code, screenshots, and current UI
structure. You may use web research for best-in-class public product patterns,
but only from real products or primary sources, not SEO blogs. Do not edit
source code. Your only write target is:

`research/chat-experience/phase-10d-chat-ui-polish-research.md`

## Mission

The current chat UI works, but it does not yet feel like a polished, trusted
agent workspace. The screenshots show rough edges:

1. Header/sidebar borders feel heavy and inconsistent.
2. Message bubbles and code blocks are too coarse.
3. Tool cards show that a tool exists, but their expanded content is not
   visually useful enough.
4. The composer feels like a generic chat box, not a work surface.
5. The visual hierarchy around thinking, tools, and final answers needs a
   better system.

Research how to make Phantom chat feel closer to the best AI work products,
while staying quiet, dense, and operational. Think Linear, Notion, Vercel,
Claude Code, OpenAI Codex, Cursor, and high-quality developer consoles.

## User Screenshot References

Use these screenshots as concrete evidence:

1. `/var/folders/d3/1cwh67m14qd_tszmmjlktqx00000gp/T/TemporaryItems/NSIRD_screencaptureui_u7zK8O/Screenshot 2026-04-30 at 3.18.38 PM.png`
2. `/var/folders/d3/1cwh67m14qd_tszmmjlktqx00000gp/T/TemporaryItems/NSIRD_screencaptureui_jOdIT4/Screenshot 2026-04-30 at 3.19.17 PM.png`
3. `/var/folders/d3/1cwh67m14qd_tszmmjlktqx00000gp/T/TemporaryItems/NSIRD_screencaptureui_PYcg1I/Screenshot 2026-04-30 at 3.19.23 PM.png`

If a file path fails because macOS temporary files expired, use the textual
description above and note that the image could not be reopened.

## Required Reading

Read these files in order:

1. `/Users/truffle/.claude/AGENTS.md` around 70 lines.
2. `/Users/truffle/.claude/CLAUDE.md` around 300 lines.
3. `research/chat-experience/phase-10a-synthesis.md` around 351 lines.
4. `chat-ui/src/index.css` or equivalent global styles.
5. `chat-ui/src/components/app-shell.tsx`.
6. `chat-ui/src/components/sidebar.tsx` if present.
7. `chat-ui/src/components/message-list.tsx` around 113 lines.
8. `chat-ui/src/components/message.tsx`.
9. `chat-ui/src/components/assistant-message.tsx`.
10. `chat-ui/src/components/run-activity-row.tsx` around 91 lines.
11. `chat-ui/src/components/tool-call-card.tsx` around 144 lines.
12. `chat-ui/src/components/thinking-block.tsx`.
13. `chat-ui/src/routes/session-route.tsx` around 93 lines.
14. `chat-ui/src/components/chat-composer.tsx` if present.

Use `rg --files chat-ui/src` to locate renamed components.

## Questions To Answer

1. What are the current visual system problems visible in the screenshots?
2. Which problems are pure CSS/layout?
3. Which problems require data model or event improvements?
4. What should the information architecture be for:
   - user messages
   - assistant final answers
   - active run status
   - thinking
   - tool calls
   - artifacts
   - compaction
   - errors
5. Should tool cards live inline, in a timeline rail, in a details drawer, or
   in a hybrid layout?
6. How should expanded tool details look when the content is stdout, command,
   browser activity, web fetch, file edit, or artifact creation?
7. How should mobile differ from desktop?
8. What should be changed in Phase 10D, and what should wait until the data
   contract is richer?
9. What accessibility and keyboard details matter?
10. What visual regression/browser checks are required?

## Acceptance Criteria

Your research file must include:

1. A screenshot-backed critique.
2. A best-in-class reference analysis from real products.
3. A proposed Phantom chat design system direction.
4. A component-level implementation plan.
5. A responsive layout plan.
6. A test and screenshot verification plan.
7. A "builder prompt seed" section.

## Anti-Patterns

Do not:

1. Make a marketing page or decorative hero. This is an operational tool.
2. Use oversized cards, one-note palettes, gradient blobs, or decorative noise.
3. Hide important work state behind tiny icons only.
4. Show raw chain-of-thought or raw secret-bearing logs by default.
5. Let long paths, code, or buttons overflow their containers.
6. Put cards inside cards.
7. Ignore mobile.
8. Redesign around vibes without grounding in current code and screenshots.

ultrathink before writing. Self-review the output against every acceptance
criterion. Your final answer should list the output file you wrote and the top
five findings only.
