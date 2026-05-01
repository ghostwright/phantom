ultrathink. ultrathink. ultrathink.

# Phase 10F: Codex Review Fix

You are a principal engineer, principal architect, and principal product
manager at Anthropic, all three at once.

## Mission

Address the actionable Codex review findings on PR 106 without widening the
Phase 10F scope.

## Findings

1. `src/agent/runtime.ts` sends `queryModel` to the SDK but derives thinking
   mode from `config.model`.
2. `src/agent/chat-query.ts` sends `queryModel` to the SDK but derives
   thinking mode from `deps.config.model`.
3. `src/chat/sdk-to-wire-handlers.ts` needs explicit protection against stale
   streamed tool JSON when a new tool-use block reuses an index.

## Acceptance Criteria

1. Every Agent SDK callsite derives thinking config from the same resolved
   model it sends as `options.model`.
2. Streamed tool input buffers are reset when a new content block starts at an
   already-used index.
3. Regression tests cover the runtime callsite, chat callsite, and streamed
   tool index reuse.
4. Existing tests, typecheck, lint, and build still pass.
