ultrathink. ultrathink. ultrathink.

You are a principal engineer, principal architect, and principal product
manager at Anthropic, all three at once. Your mission is to define what a
best-in-class long-running agent chat experience should feel like for Phantom.

No context anxiety. No token limits. No time pressure. No cost anxiety. No
"v2" thinking. There is no v2. Build it right. Take as long as you need.

## Context

Phantom is not a generic chatbot. It is an autonomous AI co-worker with its own
computer. It runs long tasks, creates files, uses tools, spawns subagents,
compacts context, and sometimes works for minutes. The chat UI must make that
feel alive, trustworthy, and inspectable without flooding the user with raw
logs.

Cheema wants the experience to compete with the best agent products, not just
to show a spinner. Research the current product patterns, but filter hard for
official docs, primary sources, and directly observable product behavior. Avoid
SEO listicles.

## Required Reading

Read Phantom first:

1. `/Users/truffle/work/phantom-chat-experience/README.md`
2. `/Users/truffle/work/phantom-chat-experience/CLAUDE.md`
3. `/Users/truffle/work/phantom-chat-experience/chat-ui/src/styles/globals.css`
4. `/Users/truffle/work/phantom-chat-experience/chat-ui/src/components/message-list.tsx`
5. `/Users/truffle/work/phantom-chat-experience/chat-ui/src/components/assistant-message.tsx`
6. `/Users/truffle/work/phantom-chat-experience/chat-ui/src/components/tool-call-card.tsx`
7. `/Users/truffle/work/phantom-chat-experience/chat-ui/src/components/thinking-block.tsx`

Then research current public references. Prioritize:

1. Official OpenAI docs for tool calls, Responses API streaming, and reasoning
   summaries if available.
2. Official Anthropic docs for tool use, extended thinking, and streaming.
3. Claude Code, Codex, Cursor, ChatGPT, and similar products only where there
   are primary docs, screenshots, or direct observable behavior.
4. Local reference repos only for implementation patterns, not UI taste:
   `/Users/truffle/work/opencode`, `/Users/truffle/work/openclaw`,
   `/Users/truffle/work/claw-code`, `/Users/truffle/work/pi-mono`.

## Questions To Answer

1. What should the user see immediately after sending a message, before the
   first assistant token or tool card exists?
2. How should Phantom communicate "the agent is working" during silent tool
   waits, subagent work, long shell commands, web fetches, browser checks, and
   compaction?
3. How much tool detail should be shown by default versus behind disclosure?
4. How should completed tool calls be represented in the transcript? Should
   they disappear, collapse into a timeline, or stay inline?
5. How should errors, rate limits, context compaction, and retries be framed
   so users understand the system is recovering?
6. What should be visible on mobile, where space is tight?
7. What is the design language that fits Phantom specifically: autonomous
   co-worker, own computer, shareable artifacts, long-running real work?

## Acceptance Criteria

Produce:

1. A product principle list, no more than 10 principles.
2. A concrete UI model for active runs: global run status, inline activity
   rail, tool cards, thinking/activity summaries, completion metadata.
3. A default disclosure policy for tool inputs, outputs, sensitive values,
   thinking, screenshots, and large payloads.
4. A phased build recommendation: first shippable slice, second slice, later
   polish.
5. A test plan that includes real Phantom-on-Murph long-running tasks and
   browser verification.

## Anti-Patterns

Do not recommend a marketing-style redesign. Phantom is an operational tool.
Do not expose raw hidden reasoning. Do not turn the chat into a log viewer.
Do not bury the actual answer under tool chrome. Do not add cards inside cards.
Do not use huge hero-style UI inside the chat surface.

## Handoff

Return a report with source links for external claims. If you create local
notes, write under
`/Users/truffle/work/phantom-chat-experience/research/chat-experience/`.

ultrathink. The bar is "I trust this agent is working" within one second.
