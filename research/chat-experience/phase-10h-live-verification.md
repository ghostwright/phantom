# Phase 10H Live Verification

Date: 2026-05-01

## Scope

Verified the Phase 10H transcript-integrity slice against a real local Phantom server running on Murph with OpenAI.

Server shape:

- Phantom repo: `/Users/truffle/work/phantom-murph-hardening`
- Branch: `codex/chat-experience-polish-10h`
- Local URL: `http://127.0.0.1:3133`
- Runtime: Murph via `/Users/truffle/work/murph/packages/anthropic-sdk-shim/dist/index.js`
- Provider: OpenAI
- Model configured in Phantom: `gpt-5.5`

## Test

1. Started Phantom locally with Murph and OpenAI.
2. Built the chat UI and copied the generated SPA into `public/chat` as a temporary local artifact.
3. Authenticated through the UI login flow using a short-lived bootstrap token.
4. Created a new chat session.
5. Attached `/tmp/phantom-phase10h-attachment-smoke.txt`.
6. Sent: "Use the attached text file. Answer in exactly one sentence and include the marker word from the file."
7. Waited for the real model response.
8. Reloaded the page and verified durable replay.
9. Inspected SQLite rows for the session.

Session id:

`2c4b3f1c-5857-4105-a85c-7cf2a04444e4`

Screenshots:

- `/tmp/phantom-phase10h-live-after-send.png`
- `/tmp/phantom-phase10h-live-after-reload.png`

## Results

Pass:

- User attachment chip appeared before send.
- The model used the attached file and answered with `marker-lima-742`.
- The attachment chip survived reload.
- The assistant answer survived reload.
- Tool cards rendered in the run timeline and stayed collapsed by default after reload.
- Session detail contained two durable messages, one user and one assistant.
- The user message `content_json` contained the attachment metadata and prompt text.
- The user message `content_json` did not contain raw base64.
- The user message `content_json` did not contain the file-only marker text.
- The assistant answer was stored in `content_json` as `"The marker word is marker-lima-742."`.

Observed but not blocking:

- Browser console showed two `503` responses from push-notification endpoints. This matches local push being unconfigured and did not affect chat send, stream, reload, or transcript integrity.
- The Playwright API request context did not reflect the UI auth state, so the live test used browser-side `fetch` after login. The UI was authenticated and the session flow worked.

## Remaining Work

This verifies the first production-trust slice. The next chat-experience slice should focus on:

1. Durable run timeline polish: keep tool cards collapsed by default, preserve expansion state, and make replayed timelines feel identical to live timelines.
2. Richer progress: surface a useful active-state row during long tool-heavy tasks instead of making the UI feel idle.
3. Artifact and file affordances: created pages, generated files, previews, copy/open actions, and markdown outputs should become first-class chat objects.
4. Provider matrix: repeat the small live chat smoke for Anthropic and GLM/Z.AI after the OpenAI path is committed cleanly.
