# Phase 10B Live Provider Browser Verification

Date: 2026-04-30

Branch: `codex/pr106-chat-experience-work`

Target PR branch: `codex/murph-agent-runtime-clean`

## Scope

This breadcrumb records the live end-to-end verification run after Phase 10B.
The intent was to prove Phantom itself can run locally on top of Murph, not just
that Murph's standalone SDK proof scripts pass.

## Grounded Setup

The verification used:

- Phantom PR worktree: `/Users/truffle/work/phantom-pr-106-push`
- Murph repo: `/Users/truffle/work/murph`
- Murph Anthropic SDK shim from source:
  `/Users/truffle/work/murph/packages/anthropic-sdk-shim/dist/index.js`
- Phantom chat SPA built with:
  `npx --yes pnpm@10.33.2 --dir chat-ui run build`
- Temporary Phantom workspaces with:
  - `public/chat` seeded from `chat-ui/dist`
  - `config/phantom.yaml`
  - `config/roles/swe.yaml`
  - `config/channels.yaml`
- Real browser automation through Playwright Chromium
- Real magic-link login flow
- Real `/chat/s/:sessionId` UI route
- Real `/chat/stream` SSE path
- Real Bash tool invocation
- Route reload before the final assertion
- Real `GET /chat/sessions/:id` readback for durable timeline evidence

## Earlier API Proofs In This Session

Before the browser pass, these live-provider checks also passed from Murph:

1. `npx --yes pnpm@10.33.2 run build`
2. `MURPH_LONG_SESSION_PROVIDERS=openai,anthropic npx --yes pnpm@10.33.2 run test:long-session`
   - OpenAI CLI long session on `gpt-5.5`
   - OpenAI SDK shim session
   - Anthropic CLI long session on `claude-opus-4-7`
   - Anthropic SDK shim session
3. `MURPH_PHANTOM_REPO=/Users/truffle/work/phantom-pr-106-push MURPH_PHASE8E_PROVIDERS=openai-agent,anthropic-haiku-agent,zai-glm-agent npx --yes pnpm@10.33.2 run test:phantom-providers`
   - OpenAI through Phantom plus Murph: `gpt-5.5`
   - Anthropic through Phantom plus Murph: `claude-opus-4-7`
   - Z.AI through Phantom plus Murph: `glm-5`

## Browser Proof Rows

### OpenAI

Provider: `openai`

Model: `gpt-5.5`

Result:

- Phantom booted locally on top of the Murph SDK shim.
- Browser logged in through Phantom's magic-link flow.
- Browser opened a real chat session route.
- UI sent a prompt instructing the agent to call Bash.
- UI showed the Bash tool.
- Browser reloaded the chat route during/around the run.
- The final assistant response included the proof marker and command output.
- `GET /chat/sessions/:id` returned a completed durable run timeline.
- The durable timeline included a `Bash` tool entry.
- `stream_state.writer_active` was `false`.
- `stream_state.has_incomplete_tail` was `false`.

Readback:

- Session id: `f33e079b-a983-4b44-9ed9-127978b2d9e1`
- Message count: `2`
- Stream max seq: `95`
- Latest terminal seq: `95`
- Timeline status: `completed`
- Timeline tools: `Bash`

### Anthropic

Provider: `anthropic`

Model: `claude-opus-4-7`

Result:

- Phantom booted locally on top of the Murph SDK shim.
- Browser logged in through Phantom's magic-link flow.
- Browser opened a real chat session route.
- UI sent a prompt instructing the agent to call Bash.
- UI showed the Bash tool.
- Browser reloaded the chat route during/around the run.
- The final assistant response included the proof marker and command output.
- `GET /chat/sessions/:id` returned a completed durable run timeline.
- The durable timeline included a `Bash` tool entry.
- `stream_state.writer_active` was `false`.
- `stream_state.has_incomplete_tail` was `false`.

Readback:

- Session id: `a852a468-cdef-4712-bc66-548b6db05645`
- Message count: `2`
- Stream max seq: `20`
- Latest terminal seq: `20`
- Timeline status: `completed`
- Timeline tools: `Bash`

## Harness Notes

Two verifier-only issues were fixed while constructing this proof:

1. Chromium did not retain Phantom's `Secure` auth cookie over
   `http://127.0.0.1`. The proof was rerun over `http://localhost`, which
   matches the local operator path we have been using.
2. A broad Playwright text assertion matched both the user prompt and the
   assistant output. The verifier was narrowed to the assistant/tool-output
   shaped marker.

Neither issue required product code changes.

## Conclusion

Phase 10B is now verified beyond unit tests and HTTP proof scripts. Phantom can
run locally on top of Murph through the real chat UI with both OpenAI and
Anthropic, execute a tool, survive a route reload, and expose the completed
durable run timeline on session readback.

The next work should move into Phase 10C and Phase 10D:

- richer live progress fidelity from Murph events;
- better tool input/detail rendering;
- more polished chat chrome, composer, run rows, and durable tool cards.
