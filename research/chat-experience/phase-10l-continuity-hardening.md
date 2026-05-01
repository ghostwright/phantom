# Phase 10L Continuity Hardening

Date: 2026-05-01

## Goal

Fix the observed post-compaction page-link confusion without inventing a
parallel Phantom memory runtime or weakening provider tool-call protocols.

## Research Verdict

Two read-only researchers inspected Phantom, Murph, Pi, and local event data.

Confirmed:

- Phantom web chat starts a fresh query per user message and resumes the same
  Murph session through `sessions.sdk_session_id`.
- Murph uses Pi correctly for provider transport, context transforms, overflow
  recognition, and provider-specific tool-message conversion.
- Murph compaction is an LLM summary plus a protected suffix, with one
  compact-and-retry path after provider overflow.
- The remaining Murph-side gap is semantic summary quality for the active turn,
  not provider protocol mechanics.
- Phantom had a concrete continuity bug: real stream events store MCP-qualified
  page tool names such as `mcp__phantom-web-ui__phantom_create_page`, while the
  host context extractor only recognized exact `phantom_create_page`.

## Shipped Phantom Slice

1. `buildChatContinuityContext(...)` now normalizes MCP-qualified page tool
   names for `phantom_create_page` and `phantom_preview_page`.
2. Page path and URL extraction now rejects login and magic-link surfaces,
   strips trailing punctuation, supports relative `/ui/...` URLs, and normalizes
   paths with leading `/ui/`.
3. Phantom now passes a live `sessionContextProvider` through
   `ChatSessionWriter -> AgentRuntime.runForChat -> executeChatQuery`.
4. Murph-only `transformContext` calls the provider each time Pi invokes the
   transform, replacing stale `<phantom_chat_context>` messages instead of
   accumulating them.
5. Anthropic fallback still receives a run-start context string through the
   existing system-prompt append path.

## Why This Matters

The run-start context cannot include page artifacts created later in the same
long run. Murph can compact and retry inside that same query. A live provider
lets a later transform see newer durable stream events without changing the
wire format or stuffing raw transcript data into the model.

## Tests

Focused tests cover:

- MCP-qualified page creation and preview extraction.
- Magic-login exclusion and safe path normalization.
- Lazy context provider invocation on every transform call.
- Stale Phantom context replacement.
- Writer-level proof that a tool event emitted during a run appears in a later
  provider call.
- Agent SDK boundary proof that Murph receives `transformContext` while
  Anthropic fallback keeps prompt append behavior.

Commands run:

```sh
bun test src/agent/__tests__/murph-context.test.ts src/chat/__tests__/continuity-context.test.ts src/chat/__tests__/writer.test.ts src/agent/__tests__/agent-sdk-boundary-callers.test.ts
bun run typecheck
bun run lint
bun test
git diff --check
```

Live OpenAI verification:

- Ran Phantom locally on Murph/OpenAI `gpt-5.5` at `http://127.0.0.1:3100`.
- Created chat session `e974d07a-6dd4-4c5b-a032-ef3cbe7d4f23`.
- Asked the agent to create `continuity-link-proof-10l.html` with
  `phantom_create_page`.
- Real stream events stored the page tool as
  `mcp__phantom-web-ui__phantom_create_page` and preview as
  `mcp__phantom-preview__phantom_preview_page`.
- `phantom_preview_page` returned HTTP 200 with title
  `Continuity Link Proof 10L - Phantom`.
- A follow-up asking for the just-created page URL returned
  `http://127.0.0.1:3100/ui/continuity-link-proof-10l.html`, not a login link.
- The generated test page was removed from the worktree after verification.

## Remaining Work

1. Murph should harden its generic compaction summary prompt with an explicit
   current-turn continuation section: task intent, important tool outcomes,
   created resources, paths, URLs, errors, and next action.
2. Phantom should promote created page and file artifacts into durable
   first-class records. `chat_stream_events` are swept, so event-log context is
   useful but not enough as the long-term artifact source.
3. The UI should surface retry/recovery state when Murph exposes such events.
   Today it can show compaction and durable run activity, but not an explicit
   compact-and-retry status.
