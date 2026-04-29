# Contributing to Phantom

Thank you for wanting to contribute. Phantom is a small, opinionated project and we are genuinely grateful for every PR, bug report, and idea.

We need help with specific things: new role templates, channel integrations (Discord, Microsoft Teams), memory strategies, evolution pipeline improvements, test coverage, documentation, and UI improvements for the web canvas. If any of those sound interesting, you are in the right place.

This guide will get you from zero to a running Phantom with passing tests in under 10 minutes.

## Prerequisites

- [Bun](https://bun.sh) 1.x or later
- [Docker](https://docs.docker.com/get-docker/) (for Qdrant and Ollama)
- An Anthropic API key (only needed for end-to-end testing with the agent)

## Development Setup

```bash
# Clone and install
git clone https://github.com/ghostwright/phantom.git
cd phantom
bun install

# Start the vector DB and embedding model
docker compose up -d qdrant ollama
docker exec phantom-ollama ollama pull nomic-embed-text

# Initialize config (creates phantom.yaml, channels.yaml, mcp.yaml)
bun run phantom init --yes

# Set your API key (only needed for E2E testing)
export ANTHROPIC_API_KEY=sk-ant-...

# Start Phantom
bun run phantom start
```

Health check: `curl http://localhost:3100/health`

## The Cardinal Rule

This is the most important architectural principle in Phantom. If you read one section, read this one.

**TypeScript is plumbing. The Agent SDK is the brain.**

Phantom wraps the Claude Agent SDK (Opus 4.7) with full computer access: filesystem, shell, Docker, network, and web search. The agent can read code, understand natural language, detect tech stacks, clone repos, and reason about anything.

TypeScript handles the mechanical, deterministic parts: starting processes, routing messages, managing sessions, storing data, serving HTTP endpoints, tracking state. Things that need to be fast, predictable, and always-on.

If you find yourself writing TypeScript that does something the agent can do better, stop. Write a prompt instead.

**Anti-patterns (these will be rejected in PR review):**

```typescript
// BAD: The agent reads package.json and knows the framework
function detectJsFrameworks(repoPath: string): string[] { ... }

// BAD: The agent understands natural language, no regex needed
function parseRepoUrls(text: string): string[] { ... }

// BAD: The agent understands context from the conversation
function classifyUserIntent(message: string): Intent { ... }

// BAD: LLM judges already exist for this (src/evolution/judges/)
function extractFactsFromText(text: string): Fact[] { ... }

// BAD: The agent has natural conversations
class QuestionStateMachine { ... }
```

**The only exception:** heuristic fallbacks for when the LLM is unavailable (API down). These are clearly marked with `HEURISTIC FALLBACK` comments in the codebase.

If you are unsure whether something belongs in TypeScript or in a prompt, open an issue and ask. We would rather have the conversation before you invest time in a PR.

## Code Standards

- **TypeScript strict mode.** No `any`. No `@ts-ignore`.
- **Biome** for lint and format. Run `bun run lint` before committing.
- **Files under 300 lines.** Split when approaching 250.
- **Named exports only.** No default exports. No barrel files.
- **Explicit return types** on all public functions.
- **Zod** for all external input validation.
- **Comments explain WHY, never WHAT.**
- **No em dashes** in any text, copy, or output. Use commas, periods, or regular dashes.
- **No unnecessary abstractions.** No premature optimization.
- **Error messages must be human-readable and actionable.**

## Running Tests

```bash
# Run the full suite (1,819 tests)
bun test

# Run a single test file
bun test src/memory/episodic.test.ts

# Run tests matching a pattern
bun test --grep "encryption"

# Lint
bun run lint

# Typecheck
bun run typecheck

# Chat UI (separate build, separate package.json)
cd chat-ui && bun install        # Install chat-ui dependencies
cd chat-ui && bun run build      # Build production SPA
cd chat-ui && bun run typecheck  # Type-check the chat client
```

All three must pass before submitting a PR: tests, lint, and typecheck.

## Submitting a Pull Request

1. Fork the repo and create a branch from `main`.
2. Make your changes. Keep the PR focused on one concern.
3. Add or update tests for your changes.
4. Run the full check: `bun test && bun run lint && bun run typecheck`
5. Write a clear commit message that describes what changed and why.
6. Open a PR with a description of the change and how you tested it.

We prefer small, focused PRs. A PR that does one thing well is easier to review and merge than one that does five things at once.

## What We Welcome

- **Role templates** - new YAML roles in `config/roles/` (SWE, data analyst, SDR, etc.)
- **Channel integrations** - Discord, Microsoft Teams, or other messaging platforms
- **Memory strategies** - improvements to episodic, semantic, or procedural memory
- **Evolution pipeline** - better observation extraction, validation gates, consolidation
- **Test coverage** - especially integration tests and edge cases
- **Documentation** - guides, examples, architecture explanations
- **UI improvements** - the web canvas, dashboard pages, base template enhancements
- **Bug fixes** - check the issue tracker for open bugs

## What We Do Not Accept

- **PRs that violate the Cardinal Rule.** If your TypeScript is doing something the agent should do (detecting frameworks, parsing natural language, classifying intent), it will be rejected. See the anti-patterns above.
- **Inline dynamic tool handlers.** The `inline` handler type (`new Function()`) was removed for RCE prevention. Only `shell` and `script` handlers are allowed. See `src/mcp/dynamic-handlers.ts`.
- **PRs that modify Docker or infrastructure from inside the agent.** The agent must not change `docker-compose.yaml`, `Dockerfile`, or system-level configuration. That is operator territory.
- **Secrets in code or config.** Never commit `.env` files, API keys, or credentials. Secrets belong in `.env` files (gitignored) or AES-256-GCM encrypted storage.

## Project Structure

The key files to understand before contributing:

| File | What it does |
|------|-------------|
| `src/index.ts` | Main entry point. Wires everything together. |
| `src/agent/prompt-assembler.ts` | Builds the system prompt from identity, role, evolved config, and memory. |
| `src/agent/runtime.ts` | Calls the Agent SDK. Session management, hooks, cost tracking. |
| `src/evolution/engine.ts` | The self-evolution pipeline. 6 steps, 5 validation gates. |
| `src/channels/slack.ts` | Primary channel. Slack Socket Mode with owner access control. |
| `src/mcp/server.ts` | MCP server setup. Tool registration and auth. |
| `src/memory/system.ts` | Memory coordinator. Three tiers: episodic, semantic, procedural. |

## Getting Help

If you have questions about the codebase, architecture, or whether an approach makes sense, open an issue or start a discussion. We would rather help you get it right than have you guess.

You can also reach the maintainer directly at cheemawrites@gmail.com.

## License

By contributing to Phantom, you agree that your contributions will be licensed under the Apache 2.0 License.
