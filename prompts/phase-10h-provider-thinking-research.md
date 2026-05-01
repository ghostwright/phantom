ultrathink. ultrathink. ultrathink.

You are a principal engineer, principal architect, and principal product
manager at Anthropic, all three at once. You are researching provider thinking
and reasoning event support across Murph, Pi, Phantom, OpenAI, Anthropic, and
ZAI.

Mission:

Determine what Phantom can truthfully show as "thinking" or "reasoning" today
without lying to the user or exposing unsafe private chain-of-thought. We need
best-in-class progress, but it must respect provider semantics.

Required reading, in order:

1. `/Users/truffle/.claude/AGENTS.md`
2. `/Users/truffle/work/murph/QUALITY-BAR.md`
3. `/Users/truffle/work/murph/PROGRESS.md`
4. Murph source:
   - `/Users/truffle/work/murph/packages/core/src/events/`
   - `/Users/truffle/work/murph/packages/core/src/substrate/`
   - `/Users/truffle/work/murph/packages/core/src/providers/`
   - `/Users/truffle/work/murph/packages/anthropic-sdk-shim/src/`
5. Phantom source:
   - `src/chat/sdk-to-wire.ts`
   - `src/chat/sdk-to-wire-handlers.ts`
   - `src/chat/types.ts`
   - `src/chat/run-timeline.ts`
   - `chat-ui/src/components/thinking-block.tsx`
   - `chat-ui/src/components/message.tsx`
   - `chat-ui/src/lib/chat-types.ts`
6. Pi source:
   - `/Users/truffle/work/pi-mono/packages/ai/src/types.ts`
   - `/Users/truffle/work/pi-mono/packages/ai/src/providers/openai-responses.ts`
   - `/Users/truffle/work/pi-mono/packages/ai/src/providers/anthropic.ts`
   - `/Users/truffle/work/pi-mono/packages/ai/src/providers/openai-completions.ts`
   - `/Users/truffle/work/pi-mono/packages/ai/src/providers/transform-messages.ts`

External docs:

- Use official provider docs only if needed. Prefer OpenAI and Anthropic
  official docs, ZAI official docs or source-backed docs.
- Do not use SEO sites or tutorials.

Deliverable:

Write `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10h-provider-thinking-research.md`.

The report must include:

1. Event taxonomy: what events we currently have for thinking, redacted
   thinking, progress summaries, token usage, tool calls, and rate limits.
2. Provider capability matrix for OpenAI, Anthropic, and ZAI as routed through
   Pi/Murph.
3. What can be shown verbatim, what should be summarized, and what must be
   hidden or labeled as private/redacted.
4. Whether Phantom can show thinking tokens/counts today, and if so where the
   data comes from. If not, name the missing Murph/Pi event or field.
5. Recommended UI model for "thinking" that is honest across providers.
6. Tests needed before shipping thinking/progress UI changes.

Non-goals:

- Do not edit code.
- Do not print or inspect API key values.
- Do not run costly live model loops unless absolutely needed. This is a source
  and event-contract research pass.

Self-review:

Before finishing, check that each recommendation maps to an existing event or a
clearly named event-contract gap.
