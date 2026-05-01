ultrathink. ultrathink. ultrathink.

You are a principal engineer, principal architect, and principal product manager at Anthropic, all three at once. You are researching the next best-in-class chat detail slice for Phantom.

No context anxiety. No token limits. No time pressure. No cost anxiety. No "v2" thinking. There is no v2. Build it right. Take as long as you need.

## Mission

Audit Phantom chat with obsessive product detail and propose the next implementation slices for:

1. Long-running agent activity that never feels dead.
2. Tool cards that are collapsed by default but useful at a glance.
3. First-class files, pages, and artifacts.
4. Minor visual details: borders, spacing, icons, copy/open affordances, markdown, empty/loading/error states.
5. User-visible memory and agent-visible memory surfaces.

Write your report to:

`/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10i-chat-detail-research.md`

Do not edit application code.

## Required Reading

Read these files directly:

1. `/Users/truffle/.claude/AGENTS.md`
2. `/Users/truffle/.claude/CLAUDE.md`
3. `/Users/truffle/work/phantom-murph-hardening/CLAUDE.md`
4. `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10h-product-direction.md`
5. `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10h-live-verification.md`
6. `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10h-phantom-chat-review.md`
7. `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/message-list.tsx`
8. `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/run-activity-row.tsx`
9. `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/tool-call-card.tsx`
10. `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/assistant-message.tsx`
11. `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/user-message.tsx`
12. `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/chat-input.tsx`
13. `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/components/markdown.tsx`
14. `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/lib/chat-activity.ts`
15. `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/lib/chat-store.ts`
16. `/Users/truffle/work/phantom-murph-hardening/src/chat/run-timeline.ts`
17. `/Users/truffle/work/phantom-murph-hardening/src/ui/tools.ts`
18. `/Users/truffle/work/phantom-murph-hardening/src/ui/preview.ts`

Also inspect Pi web UI patterns in `/Users/truffle/work/pi-mono/packages/web-ui/src` where relevant.

## Questions To Answer

1. What should be fixed next for the user to feel the agent is alive during long work?
2. What tool-card collapsed information is missing today?
3. How should generated pages/files be rendered in chat without requiring raw JSON reading?
4. Which icons should be used from `lucide-react` for memory, transcript search, artifacts, files, pages, tool states, and progress?
5. What minor border/spacing/layout issues are visible from the current code and screenshots?
6. What should be built in the next one or two PRs, and what should wait?
7. How should we visually verify each slice with Playwright screenshots?

## Design Constraints

- Use existing React/Tailwind/lucide patterns.
- Do not build a landing page or marketing layer.
- Avoid one-note color changes. Keep visual changes restrained and practical.
- Do not use emojis as primary UI primitives.
- Do not expose hidden reasoning or sensitive tool output.
- Prefer feature-complete small slices over broad partial redesigns.

## Deliverable Format

Write:

1. Executive recommendation.
2. Current UI findings by component.
3. Concrete next slices, in order.
4. Visual acceptance criteria.
5. Playwright verification plan.
6. Risks and edge cases.

ultrathink. The target is a chat surface people choose because it feels alive, legible, and trustworthy.
