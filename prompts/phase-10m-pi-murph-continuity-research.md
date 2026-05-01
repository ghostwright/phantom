ultrathink. ultrathink. ultrathink.

# Phase 10M Research Prompt: Pi/Murph Continuity Reuse

You are a principal engineer, principal architect, and principal product
manager at Anthropic, all three at once. You are working for Cheema on Phantom
running on Murph. Your job is read-only research. Do not edit files.

No context anxiety. No token limits. No time pressure. No cost anxiety. No
"v2" thinking. There is no v2. Build it right. Take as long as you need.

## Goal

Determine whether Phantom or Murph is reinventing continuity, compaction,
runtime progress, or transcript recovery behavior that Pi, Pi Code, pi-mono,
OpenClaw, opencode, Shelley, or local notes already handle better.

Focus on the post-compaction continuation failure mode Cheema observed:
the agent completed a long task, compaction happened, then the user asked for a
created page link and the agent either confused the page with a login link or
stalled. Murph main now has a stronger compaction continuation prompt and
Phantom PR #113 has live context injection plus transcript search. Verify if
that architecture is still the right direction.

## Required Reading

Read real files, not summaries:

1. `/Users/truffle/.claude/AGENTS.md`
2. `/Users/truffle/.claude/CLAUDE.md`
3. `/Users/truffle/work/murph/AGENTS.md`
4. `/Users/truffle/work/murph/QUALITY-BAR.md`
5. `/Users/truffle/work/murph/PROGRESS.md`
6. `/Users/truffle/work/phantom-murph-hardening/CLAUDE.md`
7. `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10l-continuity-hardening.md`
8. `/Users/truffle/work/phantom-murph-hardening/src/agent/chat-query.ts`
9. `/Users/truffle/work/phantom-murph-hardening/src/agent/murph-context.ts`
10. `/Users/truffle/work/phantom-murph-hardening/src/chat/continuity-context.ts`
11. `/Users/truffle/work/phantom-murph-hardening/src/agent/in-process-reflective-tools.ts`
12. `/Users/truffle/work/murph/packages/core/src/compaction/summary-prompt.ts`
13. `/Users/truffle/work/murph/packages/core/src/query/query.ts`
14. `/Users/truffle/work/murph/packages/core/src/substrate/pi-adapter.ts`
15. `/Users/truffle/work/murph/packages/core/src/substrate/pi-summary.ts`
16. Relevant files in `/Users/truffle/work/pi-mono`, `/Users/truffle/work/research-clones/pi-mono-latest`, `/Users/truffle/work/openclaw`, `/Users/truffle/work/opencode`, `/Users/truffle/work/shelley`, and `/Users/truffle/work/notes-main`.

Use `rg` aggressively. If a referenced repo lacks the expected files, say so
and continue with the repos that exist.

## Questions To Answer

1. Does Pi or pi-mono already expose a better primitive for context transforms,
   compaction, memory pointers, or transcript recovery than the current Murph
   implementation uses?
2. Is Phantom using Murph's Pi-backed `transformContext` in the least
   invasive, provider-correct way?
3. Should user-facing memory and agent-facing continuity remain separate, or
   should either be folded into the same transcript recovery tool?
4. Should Phantom create durable first-class artifact rows, or is stream-log
   extraction enough for the next PR?
5. Are there protocol risks around tool-call replay, compact summaries, or
   tool-result summarization that could break OpenAI, Anthropic, or ZAI after
   compaction?
6. What is the next smallest testable slice that improves correctness without
   adding a Phantom-only shortcut?

## Acceptance Criteria

- Ground every claim in file paths and line references.
- Distinguish "confirmed from code" from "inferred product recommendation."
- Identify P0/P1/P2 risks if any.
- Recommend one next implementation slice and one explicit non-goal.
- Do not propose copying implementation from another repo. Clean-room lessons
  only.

## Anti-Patterns

- Do not say "Pi probably handles this" without a file path.
- Do not recommend a parallel Phantom memory runtime.
- Do not weaken provider tool-call protocol correctness.
- Do not suggest sending raw historical tool JSON back to providers.
- Do not optimize for a lucky demo. This is production chat continuity.

## Final Output

Return:

1. Executive verdict, 3 to 6 bullets.
2. Evidence table with file paths and concise findings.
3. Risks ranked P0/P1/P2/P3.
4. Recommended next slice with exact files likely touched.
5. Non-goals and why.

ultrathink. ultrathink. ultrathink.
