ultrathink. ultrathink. ultrathink.

You are a principal engineer, principal architect, AND principal product
manager at Anthropic, all three at once. You are researching the richer Murph
progress contract needed for Phantom chat.

No context anxiety. No token limits. No time pressure. No cost anxiety. No v2
thinking. There is no v2. Build it right. Take as long as you need. This prompt
is your starting point, not your ceiling. Exceed it.

You are fully autonomous. You may inspect Phantom, Murph, pi-mono, Pi Code,
OpenClaw, Claw Code, opencode, and notes already cloned under `/Users/truffle/work`.
Use authentic source code and official docs only. Do not use SEO summaries.
Do not edit source code. Your only write target is:

`research/chat-experience/phase-10c-murph-progress-research.md`

## Mission

Phantom can now show basic active-run activity, but tool call cards are too thin:
they show that a tool ran, but not enough safe, useful detail inside the
dropdown. We need to understand what Murph and pi-mono can already provide,
what Phantom is failing to translate, and what small generic Murph additions
would unlock a best-in-class UI.

## Required Reading

Read these files in order:

1. `/Users/truffle/.claude/AGENTS.md` around 70 lines.
2. `/Users/truffle/.claude/CLAUDE.md` around 300 lines.
3. `research/chat-experience/phase-10a-synthesis.md` around 351 lines.
4. `src/chat/types.ts` around 222 lines.
5. `src/chat/types-tool.ts` around 151 lines.
6. `src/chat/sdk-to-wire.ts` around 297 lines.
7. `src/agent/chat-query.ts` around 177 lines.
8. `chat-ui/src/lib/chat-types.ts` around 190 lines.
9. `chat-ui/src/lib/chat-dispatch-tools.ts` around 158 lines.
10. `chat-ui/src/components/tool-call-card.tsx` around 144 lines.
11. `/Users/truffle/work/murph/AGENTS.md` around 40 lines.
12. `/Users/truffle/work/murph/ARCHITECTURE.md` if present.
13. `/Users/truffle/work/murph/packages/anthropic-sdk-shim/src` relevant files.
14. `/Users/truffle/work/murph/packages/core/src` relevant runtime files.
15. `/Users/truffle/work/pi-mono` relevant agent/runtime files if present.
16. `/Users/truffle/work/notes-main` relevant notes on compaction, tool use,
    progress, and agent event design.

If a path is missing, note it and continue.

## Questions To Answer

1. Which Phantom wire frames exist for tool start, tool input, running,
   result, blocked, aborted, and error?
2. Which Murph events currently reach Phantom?
3. Which Pi or pi-mono event details are available but not forwarded?
4. What should a generic Murph progress contract expose without leaking UI
   policy into Murph?
5. How should Phantom safely render:
   - command
   - cwd
   - status
   - elapsed time
   - partial progress
   - exit code
   - stdout/stderr summaries
   - artifact paths or URLs
   - errors
6. What must remain hidden by default?
7. What parts can be fixed entirely in Phantom translation/rendering?
8. What parts require Murph changes?
9. How should this work across OpenAI, Anthropic, and ZAI?
10. What tests must prove compatibility with SDK-style streams?

## Acceptance Criteria

Your research file must include:

1. A current event-contract map from Murph to Phantom wire frames to UI.
2. A list of missing fields and whether each belongs in Phantom or Murph.
3. A proposed generic `tool_progress` or tool lifecycle schema extension.
4. A safe disclosure policy for tool-card contents.
5. A concrete Phase 10C implementation plan split into Phantom-only and Murph
   changes.
6. Test cases and real provider verification scenarios.
7. A "builder prompt seed" section.

## Anti-Patterns

Do not:

1. Recreate pi-mono behavior that Murph already exposes.
2. Build Phantom-specific telemetry into Murph.
3. Show raw JSON by default.
4. Show secrets, env values, auth headers, cookies, or raw hidden reasoning.
5. Break Anthropic SDK compatibility to improve OpenAI behavior.
6. Assume every provider emits identical lifecycle events.
7. Treat tool cards as decorative. They are trust surfaces.

ultrathink before finalizing. Self-review the output against every acceptance
criterion. Your final answer should list the output file you wrote and the top
five findings only.
