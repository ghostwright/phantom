ultrathink. ultrathink. ultrathink.

# Phase 10M Architecture Prompt: Artifacts, User Memory, Agent Continuity

You are a principal engineer, principal architect, and principal product
manager at Anthropic, all three at once. This is read-only architecture work.
Do not edit files.

No context anxiety. No token limits. No time pressure. No cost anxiety. No
"v2" thinking. There is no v2. Build it right. Take as long as you need.

## Context

Cheema wants Phantom on Murph to handle long-running sessions like a serious
agent product. After compaction, the agent should continue smoothly. It should
not forget created pages, confuse magic-login links with artifacts, lose file
paths, or make the user repeat prior context.

He also raised an architectural split:

- User memory: durable user-visible facts and preferences.
- Agent continuity: operational facts for the current or recent runs, such as
  created files, page URLs, task status, failures, and transcript-search
  pointers.
- Historical transcript: searchable prior chat records for recovery after
  compaction.

Your job is to decide what should exist in Phantom versus Murph, what should
be MCP tools versus built-in server state, and what the next shippable slice is.

## Required Reading

Read:

1. `/Users/truffle/.claude/AGENTS.md`
2. `/Users/truffle/.claude/CLAUDE.md`
3. `/Users/truffle/work/murph/AGENTS.md`
4. `/Users/truffle/work/murph/VISION.md`
5. `/Users/truffle/work/murph/ARCHITECTURE.md`
6. `/Users/truffle/work/murph/PROGRESS.md`
7. `/Users/truffle/work/phantom-murph-hardening/CLAUDE.md`
8. `/Users/truffle/work/phantom-murph-hardening/docs/memory.md`
9. `/Users/truffle/work/phantom-murph-hardening/src/memory/system.ts`
10. `/Users/truffle/work/phantom-murph-hardening/src/chat/continuity-context.ts`
11. `/Users/truffle/work/phantom-murph-hardening/src/chat/transcript-search.ts`
12. `/Users/truffle/work/phantom-murph-hardening/src/chat/run-timeline.ts`
13. `/Users/truffle/work/phantom-murph-hardening/src/agent/in-process-reflective-tools.ts`
14. `/Users/truffle/work/phantom-murph-hardening/src/ui/tools.ts`
15. `/Users/truffle/work/phantom-murph-hardening/src/db/schema.ts`
16. Relevant notes under `/Users/truffle/work/notes-main`.

## Questions

1. Should created pages/files become a durable `chat_artifacts` table, or can
   run timelines plus stream events carry enough for now?
2. If we add artifacts, what exact schema is minimal but future-proof:
   type, title, URL, path, MIME, size, preview kind, safety metadata,
   retention, source tool, source message, source run?
3. Should artifacts be exposed to the agent through an MCP tool, injected
   continuity context, or both?
4. How should user memory stay separate from operational run continuity?
5. How should historical transcript search be presented to the agent after
   compaction without raw replay bloat?
6. What is the smallest next slice that improves real post-compaction behavior
   and user-visible UI without prematurely building a full artifact system?

## Acceptance Criteria

- Cite file paths and line references.
- Make a clear recommendation.
- Include tradeoffs for MCP tool versus built-in server state versus UI-only.
- Identify migration and testing requirements if a schema change is proposed.
- Explicitly state what belongs in Murph and what belongs in Phantom.

## Anti-Patterns

- Do not put Phantom-specific artifact logic into Murph.
- Do not make TypeScript reason about user intent when an agent prompt/tool
  can do it better.
- Do not store secrets, magic-login tokens, raw screenshots, or giant payloads
  as continuity facts.
- Do not replace transcript search with raw transcript injection.

## Final Output

Return:

1. Recommended architecture.
2. Minimal next slice.
3. Schema or no-schema decision.
4. Agent-facing tool/context decision.
5. Test plan.
6. Risks and non-goals.

ultrathink. ultrathink. ultrathink.
