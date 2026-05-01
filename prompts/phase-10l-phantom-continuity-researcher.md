ultrathink. ultrathink. ultrathink.

You are a principal engineer, principal architect, and principal product
manager at Anthropic, all three at once. You are researching Phantom's web chat
behavior around long-running Murph sessions, compaction, replay, and user
perception. Do not edit files. Read actual files and, if useful, inspect local
SQLite state from the recent test sessions.

Context:

- Phantom now runs locally on Murph with real OpenAI successfully.
- Tool cards, durable timeline, transcript search, and artifact cards exist.
- The operator observed a real long-running test where the agent created a
  page, compaction seemed to work, then follow-up questions about the page link
  got confused or stopped responding.
- The UI also needs to communicate long-running work better, but the immediate
  risk is whether the agent run state and transcript recovery are correct after
  compaction.

Reading list:

1. `/Users/truffle/work/phantom-murph-hardening/CLAUDE.md`
2. `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10h-product-direction.md`
3. `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10i-transcript-recovery-implementation.md`
4. `/Users/truffle/work/phantom-murph-hardening/src/chat/**`
5. `/Users/truffle/work/phantom-murph-hardening/src/agent/**`
6. `/Users/truffle/work/phantom-murph-hardening/chat-ui/src/**` areas related
   to status, run activity, messages, and tool rendering.
7. Recent local SQLite chat/run event data if available and safe to inspect.

Questions to answer:

1. How does a new user message in web chat become an AgentRuntime query, and
   how is the previous Murph session id reused?
2. Does Phantom send enough post-compaction context for the agent to recover
   created artifacts, page paths, and prior task state?
3. Does Phantom have a concept of "agent compacted, now continue the same task",
   or does every user message start a fresh query that depends on Murph memory?
4. Are durable timeline events sufficient to reconstruct what happened for the
   user and for the agent, or are they UI-only?
5. Where can the UI truthfully show compaction, recovery, waiting, and retry
   states with current wire events?
6. What caused the observed "done but confused about the created page link"
   failure mode most likely: Murph summary quality, Phantom prompt/context,
   transcript search tool availability, UI state, or agent behavior?
7. What is the smallest testable Phantom-side fix, if any, before changing
   Murph internals?

Deliverables:

- A concise note with file references and line numbers.
- One recommended next implementation slice, including exact tests and browser
  verification.
- A list of facts the agent should have after compaction and where each should
  live: Murph summary, Phantom transcript search, durable artifact record, or
  UI-only state.

Anti-patterns:

- Do not invent a separate hidden memory store if the transcript or artifact
  record is the right source of truth.
- Do not make the UI pretend work is happening after the backend is done.
- Do not expose secrets or magic-login links in summaries, tools, artifacts, or
  persisted timeline displays.
- Do not add a Phantom-specific hack if the right fix belongs in Murph.

Self-review:

Before finalizing, separate confirmed facts from hypotheses and note what would
prove or disprove each hypothesis.
