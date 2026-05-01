# Phase 10H Product Direction: Best-in-Class Chat

Date: 2026-05-01

## Operator Direction

Cheema wants Phantom's chat to feel like a product people choose over other
agent surfaces, not merely a working transcript. The experience needs obsessive
attention to detail:

- Long-running tasks should never feel dead. The user should see meaningful
  live activity, tool usage, compaction, waiting, recovery, and completion.
- Tool cards should be useful when collapsed and rich when expanded.
- Thinking/progress should be honest across providers. Do not fake private
  chain-of-thought. Show redacted/private reasoning state, summaries, timing,
  usage, or provider-supported reasoning signals when those signals really
  exist.
- Files and artifacts should feel first-class. If the agent creates or reads a
  file, the UI should make it inspectable when safe, with links, previews, and
  metadata rather than raw walls of text.
- Markdown should feel polished and predictable. Code, tables, links, lists,
  citations, and generated URLs should render clearly.
- Interaction details matter: borders, spacing, sticky composer behavior,
  disabled/loading states, command affordances, copy actions, reveal controls,
  and error recovery should all feel intentional.

## Tools and Capability Model

Every new capability should ask where it belongs:

- **Murph/Pi** owns provider transport, thinking levels, model metadata,
  overflow/compaction primitives, core agent event semantics, and tool execution
  seams.
- **Phantom built-in or CLI tools** are best for core app capabilities that must
  be reliable, low-latency, and tightly integrated with Phantom state, files,
  pages, sessions, and auth.
- **MCP tools** are best for external integrations or capabilities that benefit
  from a standard tool server boundary, independent lifecycle, or reuse across
  agents.
- **UI affordances** are best for browsing, opening, copying, previewing,
  filtering, expanding, retrying, and inspecting data already produced by the
  agent. Do not force the agent to call a tool when the browser can safely show
  an existing artifact.

Default bias:

1. Reuse Pi or Murph if the primitive already exists.
2. Use Phantom built-ins for Phantom-native files, pages, artifacts, sessions,
   previews, and chat ergonomics.
3. Use MCP for external or reusable integrations.
4. Use UI controls for inspection and interaction with already-known state.

## Product Bar

The target is not novelty. The target is clarity, trust, and flow:

- The user always knows whether the agent is thinking, using a tool, waiting,
  compacting, retrying, done, blocked, or errored.
- The UI shows enough detail to build trust without drowning the user.
- Expanded tool detail should be structured: parameters, output, previews,
  links, generated files, and safe full-output references.
- Hidden or redacted provider thinking should be labeled honestly.
- Visual language should use product icons and clear labels. Emojis are not a
  default system primitive for professional surfaces.
- All visible text must fit on desktop and mobile. Controls should not jump
  around during streaming.

## Immediate Research Questions

1. What Pi/Pi Code already provides for thinking, progress, CLI rendering, file
   display, and tool activity?
2. Which Phantom chat states are currently missing, misleading, or visually
   underpowered?
3. Which capabilities should become Phantom built-in tools versus MCP tools
   versus UI-only affordances?
4. What can OpenAI, Anthropic, and ZAI truthfully expose as thinking/reasoning
   through Pi/Murph today?
5. What is the smallest next builder slice that improves the live experience
   materially while remaining testable?
