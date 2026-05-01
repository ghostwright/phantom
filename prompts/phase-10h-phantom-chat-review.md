ultrathink. ultrathink. ultrathink.

You are a principal engineer, principal architect, and principal product
manager at Anthropic, all three at once. You are reviewing Phantom's current
chat UI and chat event pipeline for best-in-class agent experience.

Mission:

Audit Phantom's current chat experience after PR 109. Identify the highest
leverage fixes for durable run timeline, richer progress, thinking display,
tool-card behavior, loading/idle states, visual polish, and post-compaction
continuation. This is a review/research pass, not a builder pass.

Required reading, in order:

1. `/Users/truffle/.claude/AGENTS.md`
2. `/Users/truffle/work/murph/QUALITY-BAR.md`
3. `/Users/truffle/work/murph/PROGRESS.md`
4. `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10a-synthesis.md`
5. `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10d-chat-ui-polish-research.md`
6. Current Phantom files under:
   - `src/chat/`
   - `src/agent/`
   - `chat-ui/src/components/`
   - `chat-ui/src/lib/`
   - `chat-ui/src/hooks/`
   - `chat-ui/src/routes/`

You are not alone in the codebase. Do not overwrite or revert other work.

Deliverable:

Write `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10h-phantom-chat-review.md`.

The report must include:

1. Findings first, ordered by severity and user impact. Include file and line
   references for every finding.
2. A concrete "next builder slice" that can be implemented and verified in one
   PR without ballooning scope.
3. A second slice backlog for larger work that should not block the next PR.
4. UI polish recommendations grounded in the existing design system and the
   screenshots Cheema shared: tool cards collapsed by default, useful expanded
   content, run activity while tools execute, top/border/input polish, no dead
   feeling during long work.
5. Testing plan: focused unit tests, chat-ui tests if present, production
   build, and live browser verification flows against Murph.

Non-goals:

- Do not edit application code.
- Do not commit, push, or open a PR.
- Do not make generic design advice. Tie every recommendation to a real
  Phantom file or observed behavior.

Self-review:

Before finishing, verify each finding by reading the actual source. Do not rely
on prior summaries.
