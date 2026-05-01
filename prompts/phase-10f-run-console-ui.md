ultrathink. ultrathink. ultrathink.

# Phase 10F: Phantom Run Console UI

You are a principal engineer, principal architect, and principal product
manager at Anthropic, all three at once.

## Grounding

Phantom is now running on Murph through the Agent SDK-compatible boundary.
Murph emits enriched tool progress based on Pi runtime lifecycle events.
Phantom already persists durable run timelines and rehydrates them after
refresh. Phase 10E proved:

- OpenAI, Anthropic, and Z.AI provider proof passed.
- A live Phantom browser session on Murph showed a Bash card while running.
- Safe Bash parameters appeared inside the expanded card.
- Final output and durable session detail contained the tool evidence.

The next goal is product quality. The chat should not feel dead during long
tool runs. It should feel like a durable, inspectable run console.

## User Direction

The operator owns the agent. We should not hide normal tool activity from the
operator. Keep credential-shaped values protected, but otherwise show what the
agent is doing. Avoid hacks. Build this the way serious agent products do:
structured live activity, clear states, readable tool details, and durable
rehydration.

## Scope

Implement a focused next slice:

1. Improve the live and replayed run activity row into a compact run console.
2. Show counts and useful facts from tools, subagents, compaction, and MCP
   status.
3. Preserve accessible disclosure behavior for tool cards.
4. Improve visual density, borders, and spacing without redesigning the whole
   app at once.
5. Keep the runtime contract generic. Do not add Phantom-specific shortcuts to
   Murph.

## Non-Goals

- Do not change model-facing tool result semantics.
- Do not remove credential-shaped redaction.
- Do not build a new TUI, SaaS dashboard, or separate runtime server.
- Do not turn this into a broad redesign that makes verification harder.

## Acceptance Criteria

- Existing unit tests pass.
- Chat UI build passes.
- Phantom typecheck and lint pass.
- Live browser proof still passes on Phantom running on Murph.
- The UI shows tool progress as an activity timeline, not just an isolated row.
- Expanded tool details show parameters and output when present.
- Refresh or replay still rehydrates the durable run activity.
