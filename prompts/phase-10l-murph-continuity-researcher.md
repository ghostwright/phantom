ultrathink. ultrathink. ultrathink.

You are a principal engineer, principal architect, and principal product
manager at Anthropic, all three at once. You are researching Phantom on Murph
post-compaction continuity. Do not edit files. Do not summarize from memory.
Read the actual Murph and Phantom code.

Context:

- Phantom is being moved onto Murph, a clean-room pi-mono based agent runtime.
- We already implemented Phantom transcript recovery through
  `phantom_chat_transcript_search`.
- Real browser testing showed long-running tool-heavy tasks work, and Murph
  compaction appears to fire, but after compaction the agent may lose the
  created-page answer or stop responding usefully.
- The operator believes compaction should be an LLM-written compact summary,
  not literal history replay. The next model call should receive that summary
  plus enough pointers and tools to continue.
- We must reuse pi-mono/Pi capabilities where they exist and avoid rebuilding
  battle-tested primitives in worse form.

Reading list:

1. `/Users/truffle/work/murph/AGENTS.md`
2. `/Users/truffle/work/murph/QUALITY-BAR.md`
3. `/Users/truffle/work/murph/PROGRESS.md`
4. `/Users/truffle/work/murph/src/**` areas related to context overflow,
   compaction, provider adapters, message history, tool call preservation, and
   summaries.
5. `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10g-pi-continuity.md`
6. `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10i-transcript-recovery-implementation.md`
7. Any local pi-mono, pi-code, or notes repo already cloned under
   `/Users/truffle/work` that contains relevant compaction or overflow logic.

Questions to answer:

1. What exactly does Murph do today when context approaches or exceeds the
   provider limit?
2. Does Murph use pi-mono/Pi primitives for context overflow detection,
   summarization, and retry, or did we duplicate that logic?
3. After compaction, what is sent to the next provider call? Include the shape
   of summary, preserved tool-call state, and any continuation instructions.
4. Is there an existing Murph seam for "continue the interrupted turn after
   compaction", or is compaction only a pre-call trimming step?
5. Which provider-specific constraints matter for OpenAI, Anthropic, and ZAI
   around tool-call history after compaction?
6. What is the smallest production-grade fix that improves continuation
   without corrupting tool-call protocols?
7. What tests should prove this, preferably with real providers when possible
   and deterministic unit tests for the core state machine?

Deliverables:

- A concise architecture note with file references and line numbers.
- A clear verdict: reuse Pi/Murph existing primitives, fix Murph primitive, or
  add Phantom-specific continuation glue.
- A ranked implementation plan with acceptance criteria.
- Explicit risks and anti-patterns, especially anything that would break
  OpenAI tool-call message ordering.

Anti-patterns:

- Do not suggest raw transcript stuffing.
- Do not suggest regex-heavy summarization.
- Do not expose private chain-of-thought.
- Do not preserve raw secrets, magic links, auth headers, or full tool payloads
  in summaries.
- Do not treat a single reference repo as authoritative.

Self-review:

Before finalizing, re-read your own findings and remove any claim not backed by
files you actually inspected.
