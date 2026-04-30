# Phase 10A Chat Experience Synthesis

Date: 2026-04-30
Branch: `codex/chat-experience-murph`
Base: Phantom Murph integration branch at `914bb8a`

## Grounding

Murph PR #4 is merged to Murph `main`. Phantom PR #106 already proves the
runtime path: Phantom can run on Murph with OpenAI, long-running tool work can
complete, and Murph auto-compaction can fire during a real browser session.

The next problem is product trust, not basic runtime viability. During long
tool-heavy turns Phantom can be actively working while the web chat looks
quiet, especially before the first `message.assistant_start` frame reaches the
client or while tool progress frames are ignored.

The three research prompts for this phase are mirrored in this branch under
`prompts/`:

- `prompts/phase-10a-chat-pipeline-research.md`
- `prompts/phase-10a-murph-pi-event-research.md`
- `prompts/phase-10a-product-experience-research.md`

## Evidence From The Live Run

The live OpenAI-backed Phantom session showed that the backend already emits
useful progress:

- `session.status` changed to `compacting`.
- `session.compact_boundary` recorded an automatic boundary after roughly
  670k pre-compaction tokens.
- The durable Murph session recorded a compacted post-token count around 466.
- Multiple `message.tool_call_running` frames arrived before the assistant
  answer began.
- The UI did not surface enough of this, so the user could reasonably wonder
  whether the system was stuck.

This means compaction worked. The product gap is that the client treats many
runtime lifecycle frames as invisible plumbing.

## Phase 10A Verification

After implementation, the branch was tested against a real local Phantom server
running on Murph with OpenAI:

- Started Phantom on `127.0.0.1:3111` with
  `PHANTOM_AGENT_RUNTIME=murph`,
  `PHANTOM_PROVIDER_TYPE=openai`, and the local Murph Agent SDK shim.
- Rebuilt the chat UI and served it through Phantom's existing static chat
  overlay path.
- Sent a tool-use prompt that asked the agent to run `sleep 5 && pwd`.
- Verified in the browser that the transcript showed `Using a tool...` before
  the final answer existed.
- Verified that the active tool card stayed visible while the command was
  running.
- Verified that the final answer rendered the working directory and retained
  the tool card after completion.
- Sent a no-tool follow-up and verified that the previous tool placeholder did
  not get reused by the new turn.
- Verified that the UI exposed safe `Thinking...` activity only, not raw
  chain-of-thought.
- Stopped the isolated verification server after the test.

Automated checks run after the reviewer fixes:

- `bun test src/chat/__tests__/sdk-to-wire.test.ts`
- `bun test src/lib/__tests__/chat-store.test.ts` from `chat-ui/`
- `bun run typecheck`
- `bun run typecheck` from `chat-ui/`
- `bunx biome check` on the changed Phantom and chat UI files
- `git diff --check`

## Current Pipeline

1. `chat-ui/src/routes/session-route.tsx` calls `useChat.sendMessage`.
2. `chat-ui/src/hooks/use-chat.ts` posts to `/chat/stream`, reads SSE frames,
   tracks `lastSeq`, and dispatches frames to the store.
3. `src/chat/http-handlers.ts` creates a `ChatSessionWriter`, opens an SSE
   stream, and starts the writer.
4. `src/chat/writer.ts` commits the user message, calls `runtime.runForChat`,
   translates SDK or Murph messages, persists frames to `chat_stream_events`,
   and publishes them through the stream bus.
5. `src/agent/chat-query.ts` calls the Agent SDK or Murph with
   `includePartialMessages`, `agentProgressSummaries`, and
   `promptSuggestions` enabled.
6. `src/chat/sdk-to-wire.ts` and `src/chat/sdk-to-wire-handlers.ts` translate
   runtime events into Phantom wire frames.
7. `chat-ui/src/lib/chat-store.ts` updates client state.
8. `chat-ui/src/components/message-list.tsx`,
   `chat-ui/src/components/assistant-message.tsx`,
   `chat-ui/src/components/tool-call-card.tsx`, and
   `chat-ui/src/components/thinking-block.tsx` render the transcript.

## Findings

### P1: Long turns can look dead

`useChat.sendMessage` sets `isStreaming`, but the visible loading dots live in
`AssistantMessage`, which only renders after `message.assistant_start` creates
an assistant message. Before that, the visible UI can be mostly static.

Relevant files:

- `chat-ui/src/hooks/use-chat.ts`
- `chat-ui/src/lib/chat-store.ts`
- `chat-ui/src/components/message-list.tsx`
- `chat-ui/src/components/assistant-message.tsx`

### P1: Tool running frames can be dropped

`message.tool_call_running` only updates an existing active tool call. If Murph
emits running progress before Phantom has seen a matching tool start, the frame
is ignored. The current backend frame also lacks `message_id` and `tool_name`,
so the client cannot build a rich placeholder from the running event alone.

Relevant files:

- `chat-ui/src/lib/chat-dispatch-tools.ts`
- `src/chat/types-tool.ts`
- `src/chat/sdk-to-wire.ts`

### P1: Tool results are modeled but not emitted

The wire protocol and reducer support `message.tool_call_result`, but
`translateSdkMessage` drops SDK `user` messages, which are likely where
synthetic `tool_result` content arrives. As a result, completed tool output is
not reliably represented in the chat activity surface.

Relevant files:

- `src/chat/sdk-to-wire.ts`
- `src/chat/types-tool.ts`
- `chat-ui/src/lib/chat-dispatch-tools.ts`

### P1: Terminal events erase live activity

On `session.done`, `session.error`, and `session.aborted`, the store clears
`activeToolCalls` and `thinkingBlocks`. That removes useful run evidence from
the visible transcript immediately after completion. Reloads also lose this
activity because `chat_messages` persists final user and assistant content,
not the activity timeline.

Relevant files:

- `chat-ui/src/lib/chat-store.ts`
- `src/chat/message-store.ts`
- `src/chat/event-log.ts`

### P2: Useful lifecycle frames are ignored

The frontend currently ignores frames that directly answer "what is happening":

- `session.status`
- `session.compact_boundary`
- `session.rate_limit`
- `session.mcp_status`
- `session.suggestion`
- `session.truncated_backlog`
- `message.subagent_start`
- `message.subagent_progress`
- `message.subagent_end`

Relevant files:

- `src/chat/sdk-to-wire.ts`
- `src/chat/types.ts`
- `src/chat/types-tool.ts`
- `chat-ui/src/lib/chat-store.ts`

### P2: Resume exists but the route load path does not use it

The backend has `/chat/sessions/:id/resume`, and the client exposes
`resumeSession`, but `loadSession` only fetches committed messages via
`GET /chat/sessions/:id`. Refreshing during an active turn can therefore lose
live activity frames unless a new stream is attached.

Relevant files:

- `chat-ui/src/hooks/use-chat.ts`
- `chat-ui/src/lib/client.ts`
- `src/chat/http-handlers.ts`

## Murph And Pi Signal

Murph already gives Phantom enough to build a better first slice:

- assistant text streaming
- tool call start and input streaming
- tool running progress with elapsed time
- compaction status and boundary
- subagent lifecycle events
- rate limit and prompt suggestion frames

Pi emits richer tool details that Murph does not fully forward yet:

- tool execution updates
- tool execution end with result and error state
- tool result lifecycle
- partial tool progress callbacks

The first Phantom pass should render existing frames and preserve activity. A
small later Murph extension should enrich `tool_progress` with optional tool
name, phase, safe input summary, partial output summary, duration, and error
state. That keeps Murph generic and avoids building a Phantom-only telemetry
layer.

## Product Direction

Phantom chat should become an active-run surface, not a transcript with a
spinner. The user should see within one second that Phantom accepted the task,
is working on its own computer, and will leave inspectable evidence.

Principles:

1. Acknowledge within one second.
2. Show evidence of work, not raw logs.
3. Keep the answer primary.
4. Make activity inspectable by progressive disclosure.
5. Treat tools as work artifacts, not chat content.
6. Frame errors as recovery states.
7. Make compaction feel like continuity, not amnesia.
8. Keep mobile concise, with details behind a sheet.
9. Preserve trust metadata: elapsed time, tools, files, artifacts, tokens,
   and cost.

## Disclosure Policy

Default visible:

- tool name
- safe action label
- safe target
- current state
- elapsed time
- artifact links

Collapsed by default:

- raw JSON inputs
- command output
- fetched content
- large payloads
- screenshots
- full logs

Never show by default:

- secrets
- auth headers
- cookies
- env values
- private form values
- raw chain-of-thought

Thinking should become a safe activity layer by default. Raw thinking can
remain a developer-gated diagnostic if we need it, but it should not be part of
the normal Phantom user experience.

## Recommended Phases

### Phase 10A: Activity Correctness

Build the minimum production-grade slice on existing signals:

1. Add client-side run activity state.
2. Show a visible active-run row immediately after send, before any assistant
   token exists.
3. Render `session.status`, `session.compact_boundary`, `session.rate_limit`,
   MCP status, and subagent lifecycle frames.
4. Make orphan tool progress, blocked, aborted, and result frames create safe
   placeholders instead of disappearing.
5. Stop clearing completed tool and thinking state at terminal events.
6. Emit `message.tool_call_result` where the SDK or Murph provides tool-result
   carriers.
7. Keep successful tools compact, expand active/error/blocked tools.
8. Hide raw thinking by default and use safe activity copy.

This is the right first build because it fixes the user-visible trust issue
without a broad visual rewrite or a Murph API redesign.

### Phase 10B: Durable Run Timeline

Persist or replay per-turn activity so refreshes and completed transcripts show
what happened:

1. Attach `resumeSession(lastSeq)` on route load when a writer is active.
2. Build a per-run timeline model from `chat_stream_events`.
3. Persist compact tool summaries or reconstruct them from event history.
4. Add a `Run details` disclosure under assistant messages.
5. Add mobile-specific compact activity summary and details sheet.

### Phase 10C: Rich Murph Progress Contract

Extend Murph only where Phantom cannot produce a high-quality UI from existing
events:

1. Add optional metadata to `tool_progress`.
2. Forward Pi tool execution update/end events.
3. Add a tool progress callback to Murph tool handler extras.
4. Add safe result summaries where the runtime can provide them without UI
   policy leaking into Murph.

### Phase 10D: Full Product Polish

After correctness and durability:

1. Artifact tray.
2. Browser screenshot thumbnails with privacy gates.
3. Timeline filters.
4. Rich retry and recovery states.
5. Operator debug view.
6. Real-world browser verification across desktop and mobile.

## Test Plan For Phase 10A

Unit tests:

- reducer handles orphan `message.tool_call_running`
- reducer handles orphan `message.tool_call_result`
- reducer retains completed tool state after `session.done`
- reducer renders `session.status` and `session.compact_boundary` activity
- reducer handles `session.error` before assistant start
- translator emits tool-result frames

Component tests:

- active-run row appears immediately after send
- silent tool wait remains visibly active
- compaction creates a safe continuity note
- subagent progress renders without stealing focus from the answer
- successful tool cards collapse, errors expand

Real Phantom-on-Murph tests:

- OpenAI long-running web research plus page creation
- Anthropic long-running tool-heavy task
- Z.AI smoke test if the current provider key is valid
- forced compaction or low-threshold compaction fixture
- refresh during an active run
- abort during tool execution
- desktop and mobile browser screenshots

## Non-Goals

- No marketing-style chat redesign.
- No broad backend rewrite.
- No Phantom-specific shortcuts inside Murph.
- No raw tool JSON dump as the default UI.
- No raw chain-of-thought exposure in normal mode.
- No public visibility or release changes as part of this phase.
