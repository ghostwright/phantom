ultrathink. ultrathink. ultrathink.

You are a principal engineer, principal architect, and principal product manager at Anthropic, all three at once. You are researching Phase 10I for Phantom on Murph in `/Users/truffle/work/phantom-murph-hardening`.

No context anxiety. No token limits. No time pressure. No cost anxiety. No "v2" thinking. There is no v2. Build it right. Take as long as you need.

## Mission

Research the correct production architecture for dual memory in Phantom chat:

1. A user-visible memory surface: things the operator can see, understand, edit, and trust.
2. An agent-visible operational memory surface: things the agent needs to continue work after compaction, remember task state, and avoid asking the user to repeat context.

The immediate product direction is that post-compaction work should continue naturally. The agent should have enough historical transcript access to recover details that were compacted away, but this must not turn into a giant prompt dump or unsafe leakage of hidden tool internals.

Write your report to:

`/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10i-memory-architecture-research.md`

Do not edit application code.

## Required Reading

Read these files directly:

1. `/Users/truffle/.claude/AGENTS.md`
2. `/Users/truffle/.claude/CLAUDE.md`
3. `/Users/truffle/work/murph/QUALITY-BAR.md`
4. `/Users/truffle/work/phantom-murph-hardening/CLAUDE.md`
5. `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10h-product-direction.md`
6. `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10h-live-verification.md`
7. `/Users/truffle/work/phantom-murph-hardening/src/agent/prompt-assembler.ts`
8. `/Users/truffle/work/phantom-murph-hardening/src/agent/prompt-blocks/agent-memory-instructions.ts`
9. `/Users/truffle/work/phantom-murph-hardening/src/agent/prompt-blocks/working-memory.ts`
10. `/Users/truffle/work/phantom-murph-hardening/src/agent/chat-query.ts`
11. `/Users/truffle/work/phantom-murph-hardening/src/agent/murph-context.ts`
12. `/Users/truffle/work/phantom-murph-hardening/src/agent/in-process-reflective-tools.ts`
13. `/Users/truffle/work/phantom-murph-hardening/src/memory/context-builder.ts`
14. `/Users/truffle/work/phantom-murph-hardening/src/memory/system.ts`
15. `/Users/truffle/work/phantom-murph-hardening/src/ui/api/memory-files.ts`

Also inspect any tests that define the intended behavior.

## Questions To Answer

1. What memory surfaces already exist, by exact file path and behavior?
2. Which surface is currently user-visible, which is agent-visible, and which is both?
3. What does the agent already receive in the prompt before a run?
4. What does the agent already get through tools such as `phantom_memory_search` and `phantom_history`?
5. What should "for-agent memory" mean in product terms, and where should it live?
6. What should "for-user memory" mean in product terms, and where should it render?
7. What should never be shown to users, but may be used by the agent for continuity?
8. What is the smallest safe next builder slice that improves post-compaction continuity without over-building?

## Design Constraints

- Keep Murph generic. Phantom-specific memory UI and session history belong in Phantom.
- Do not expose raw chain-of-thought.
- Do not dump entire transcripts into prompts.
- Do not store raw base64, credentials, or unredacted tool full outputs in user memory.
- Prefer existing storage and APIs before adding new systems.
- A future cloud deployment must be durable across process restarts.

## Deliverable Format

Write:

1. Executive recommendation.
2. Current state inventory.
3. Proposed memory taxonomy.
4. Proposed agent prompt/tool contract.
5. Proposed user-visible UI/API contract.
6. Risks and privacy boundaries.
7. Smallest next builder slice with exact files likely touched and tests required.

ultrathink. Be specific. Cite exact files and functions. Do not rely on summaries.
