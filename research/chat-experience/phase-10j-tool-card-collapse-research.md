# Phase 10J Tool Card Collapse Research

Date: 2026-05-01

## Findings

`chat-ui/src/components/tool-call-card.tsx` currently initializes disclosure
from `autoExpand`, where only `error` and `blocked` states open on first mount.
That means a successful completed tool first rendered as `result` is already
closed by default.

The weak spot is state transition behavior. The component opens error and
blocked cards in an effect, but it never reconciles back to closed when an
auto-open or live-inspected card later becomes a successful `result`. In a long
run, that can leave completed cards expanded and noisy, especially when the
same card was opened by an attention state or while work was still live.

## Recommended Behavior Policy

1. Successful completed tools should be collapsed by default.
2. Blocked and errored tools should auto-open unless the user has already made
   an explicit disclosure choice on that card.
3. Running tools should remain useful from their header and metadata without
   requiring expanded raw parameters or output by default.
4. If the user explicitly opens a completed tool, keep it open.
5. If an auto-open attention card later resolves successfully, close it unless
   the user explicitly interacted with the disclosure.

This is a UI affordance. It should not be an MCP tool or Phantom built-in tool,
because it only controls how already-known run state is displayed in the
browser.

## Recommended Implementation

Add a small pure disclosure policy under `chat-ui/src/lib/` and wire
`ToolCallCard` to it. Keep disclosure state local to each card. The global chat
store should keep runtime facts, not per-card view toggles.

The policy should track:

- whether the card is open,
- whether the user has explicitly toggled it,
- the last observed tool state.

Then `ToolCallCard` can reconcile state transitions in a `useEffect`:

- `error` or `blocked` opens automatically when there has been no user toggle,
- `result` closes automatically when there has been no user toggle,
- same-state renders do not override user actions.

## Recommended Tests

Add focused Vitest coverage for the pure policy:

1. initial `result` is closed,
2. initial `error` and `blocked` are open,
3. `error -> result` closes without user interaction,
4. `running -> result` remains closed without user interaction,
5. user-opened running cards remain open after `result`,
6. user-opened completed cards are not closed by same-state reconciliation.

Component tests can come later if the chat UI test harness adds a DOM renderer.

## Risks and Non-goals

This does not redesign tool cards, artifact previews, markdown rendering, or
the full run timeline. It is the smallest deterministic product fix for the
observed "everything is open" behavior.

The main risk is hiding important failure detail. The policy avoids that by
keeping blocked and errored tools auto-open by default.

## Verdict

Proceed with the pure disclosure policy plus `ToolCallCard` wiring and focused
tests.
