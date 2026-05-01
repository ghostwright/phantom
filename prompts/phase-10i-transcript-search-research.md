ultrathink. ultrathink. ultrathink.

You are a principal engineer, principal architect, and principal product manager at Anthropic, all three at once. You are researching historical transcript search for Phantom chat after Murph compaction.

No context anxiety. No token limits. No time pressure. No cost anxiety. No "v2" thinking. There is no v2. Build it right. Take as long as you need.

## Mission

Design the smallest production-ready mechanism that lets the agent access historical chat transcript details that may have been compacted out of the provider context.

Write your report to:

`/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10i-transcript-search-research.md`

Do not edit application code.

## Required Reading

Read these files directly:

1. `/Users/truffle/.claude/AGENTS.md`
2. `/Users/truffle/.claude/CLAUDE.md`
3. `/Users/truffle/work/phantom-murph-hardening/CLAUDE.md`
4. `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10g-pi-continuity.md`
5. `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10h-phantom-chat-review.md`
6. `/Users/truffle/work/phantom-murph-hardening/src/chat/message-store.ts`
7. `/Users/truffle/work/phantom-murph-hardening/src/chat/event-log.ts`
8. `/Users/truffle/work/phantom-murph-hardening/src/chat/continuity-context.ts`
9. `/Users/truffle/work/phantom-murph-hardening/src/chat/run-timeline.ts`
10. `/Users/truffle/work/phantom-murph-hardening/src/chat/http.ts`
11. `/Users/truffle/work/phantom-murph-hardening/src/chat/http-handlers.ts`
12. `/Users/truffle/work/phantom-murph-hardening/src/db/schema.ts`
13. `/Users/truffle/work/phantom-murph-hardening/src/agent/in-process-reflective-tools.ts`
14. `/Users/truffle/work/murph/packages/core/src/substrate/pi-harness.ts`
15. `/Users/truffle/work/murph/packages/core/src/query/query.ts`

Also inspect tests under `src/chat/__tests__` and `src/agent/__tests__`.

## Questions To Answer

1. What durable data has enough fidelity to reconstruct pre-compaction history?
2. Is SQLite search enough for the first slice, or should we use Qdrant memory?
3. Should transcript lookup be an agent tool, an injected continuity summary, a user-visible API, or all three?
4. How should the tool avoid exposing secrets, login links, raw attachment payloads, and large outputs?
5. What query/filter shape is enough: current session only, all sessions, date windows, roles, sequence ranges, artifact-only?
6. How should the agent know the tool exists and when to use it?
7. How do we test that post-compaction follow-up can recover a detail from earlier transcript?
8. What is the smallest implementation slice that is valuable and low-risk?

## Design Constraints

- Compaction should touch provider context only. It must not close tools, MCP clients, or transcript search capability.
- The search mechanism must work after reload and process restart.
- Search results should be compact, cited by session id and seq, and safe to paste into the model context.
- Do not create a full vector-search system if SQLite plus existing memory is enough for this slice.
- Do not force the user to manually search if the agent can use a tool.

## Deliverable Format

Write:

1. Executive recommendation.
2. Current persistence model.
3. Proposed transcript search contract.
4. Safety/redaction model.
5. Test plan.
6. Builder slice proposal with exact files likely touched.

ultrathink. This is a product trust feature. Get the boundary right.
