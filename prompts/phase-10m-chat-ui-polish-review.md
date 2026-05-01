ultrathink. ultrathink. ultrathink.

# Phase 10M Review Prompt: Phantom Chat UI Polish

You are a principal engineer, principal architect, and principal product
manager at Anthropic, all three at once. You are reviewing Phantom's Murph chat
experience for production-grade quality. This is read-only. Do not edit files.

No context anxiety. No token limits. No time pressure. No cost anxiety. No
"v2" thinking. There is no v2. Build it right. Take as long as you need.

## Product Bar

Cheema wants Phantom chat to feel best in class, comparable in craft to the
best coding-agent chat products. Every small detail matters: running state,
tool cards, collapsed defaults, thinking/progress, durable run timeline,
artifacts, markdown, file previews, mobile layout, reload recovery, and local
build ergonomics.

We are not building a marketing page. The chat is the product.

## Required Reading

Read:

1. `/Users/truffle/.claude/AGENTS.md`
2. `/Users/truffle/.claude/CLAUDE.md`
3. `/Users/truffle/work/phantom-murph-hardening/CLAUDE.md`
4. `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10d-chat-ui-polish-research.md`
5. `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10b-durable-timeline-research.md`
6. `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10h-product-direction.md`
7. `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10k-page-artifact-ui.md`
8. `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/tool-call-card.tsx`
9. `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/run-activity-row.tsx`
10. `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/message-list.tsx`
11. `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/assistant-message.tsx`
12. `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/chat-input.tsx`
13. `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/lib/chat-store.ts`
14. `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/lib/tool-disclosure.ts`
15. `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/index.css`

Also inspect the latest PR branch diff against `origin/main`.

## Review Questions

1. What UI flaws remain after the current PR, especially ones visible in real
   long-running Murph tasks?
2. Are completed tool cards collapsed by default while still making evidence
   easy to inspect?
3. Does the run timeline explain activity during long tool calls, compaction,
   reload/replay, and post-run completion?
4. Are artifact cards useful enough, or should the next slice add richer
   previews, persistent artifact lists, or copy/open affordances?
5. Are there layout issues on desktop or mobile: borders, scroll behavior,
   truncation, nested cards, empty states, input footer, or typography?
6. What automated or Playwright visual tests should be added before this UI is
   considered shippable?

## Acceptance Criteria

- Findings must cite real files and ideally lines.
- Separate correctness bugs from product polish.
- Recommend a small next implementation slice that can be built and visually
  verified in one PR.
- Do not ask for broad redesign for its own sake. The next slice must improve
  real task usability.

## Anti-Patterns

- Do not focus only on colors.
- Do not propose hiding tool details for safety. The user owns the agent and
  needs inspectability, with reasonable redaction for secrets.
- Do not introduce decorative UI that competes with the work.
- Do not recommend a huge rewrite unless you can name a specific blocker that
  makes incremental work worse.

## Final Output

Return:

1. Top five UI issues ranked by impact.
2. Evidence with file paths.
3. A proposed next slice with files, tests, and visual checks.
4. Things that should wait.

ultrathink. ultrathink. ultrathink.
