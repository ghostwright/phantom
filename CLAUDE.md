# Phantom

Phantom is an autonomous AI co-worker that runs as a persistent Bun process on a VM. It wraps the Claude Agent SDK as a subprocess (Anthropic by default, swappable via a `provider:` config block to Z.AI/GLM-5.1, OpenRouter, Ollama, vLLM, LiteLLM, or any Anthropic Messages API compatible endpoint). It maintains vector-backed memory across sessions, rewrites its own configuration through a validated self-evolution engine, communicates via Slack/Web Chat/Telegram/Email/Webhook, and exposes all capabilities as an MCP server. 30,000+ lines of TypeScript, 1,819 tests, v0.20.2. Apache 2.0, repo at ghostwright/phantom.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Bun (TypeScript-native, built-in SQLite, no bundler) |
| Agent | Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) subprocess. Provider is configurable via `src/config/providers.ts`: Anthropic (default), Z.AI, OpenRouter, Ollama, vLLM, LiteLLM, custom. |
| Memory | Qdrant (vector DB, Docker) + Ollama (nomic-embed-text, local embeddings) |
| State | SQLite via Bun (sessions, tasks, metrics, evolution versions, scheduled jobs) |
| Channels | Slack (Socket Mode), Web Chat (SSE streaming), Telegram (long polling), Email (IMAP/SMTP), Webhook (HMAC-SHA256), CLI |
| Chat Client | React 19 + Vite + shadcn/ui + Tailwind v4 SPA at `/chat` |
| Web UI | Tailwind v4 Browser CDN + DaisyUI v5, static files from public/ |
| MCP | Streamable HTTP on /mcp, bearer token auth, 17+ tools |
| Infrastructure | Docker (compose), Specter VMs (Hetzner), systemd (bare metal) |
| Lint/Format | Biome |
| Test | bun:test |

## The Cardinal Rule

**TypeScript is plumbing. The Agent SDK is the brain.**

The Agent SDK (Opus 4.7) has full computer access: Read, Write, Edit, Bash, Glob, Grep, WebSearch, Agent tools. It can understand natural language, read code, explore repos, detect tech stacks, clone repos, install packages, write configs, and reason about anything.

TypeScript handles: starting processes, routing messages, managing sessions, storing data, serving HTTP endpoints, tracking state. Mechanical, deterministic work.

If you find yourself writing a function that does something the agent can do better - STOP. Write a prompt instead.

**Anti-patterns (never do these):**
- `detectJsFrameworks()` - the agent reads package.json and knows
- `parseRepoUrls()` with regex - the agent understands natural language
- `classifyUserIntent()` - the agent understands context
- `extractFactsFromText()` as regex - use LLM judges (already built)
- Structured question state machines - the agent has natural conversations
- Hardcoded detection of languages/databases/tools - the agent reads code

**The only exception:** heuristic fallbacks for when the LLM is unavailable (API down). These are clearly marked with "HEURISTIC FALLBACK" comments in the codebase.

## Build and Test Commands

```bash
bun install                          # Install dependencies
bun test                             # Run 1,819 tests
bun run src/index.ts                 # Start the server
bun run src/cli/main.ts init --yes   # Initialize config (reads env vars)
bun run src/cli/main.ts doctor       # Check all subsystems
bun run src/cli/main.ts status       # Quick one-liner status
bun run lint                         # Biome check
bun run typecheck                    # tsc --noEmit

# Chat UI (separate build)
cd chat-ui && bun install            # Install chat-ui dependencies
cd chat-ui && bun run build          # Build production SPA to chat-ui/dist/
cd chat-ui && bun run typecheck      # Type-check the chat client
cd chat-ui && bun run dev            # Dev server on :5173 (proxy to :3100)

# Chat-UI dev loop: run Phantom on :3100 in one terminal, Vite on :5173 in another.
# Vite proxies /chat/* API calls to :3100. Open http://localhost:5173/chat.
```

## Project Structure

```
src/
  index.ts              # Main entry point. Wires everything together (~500 lines).
  agent/
    runtime.ts          # Claude Agent SDK query() wrapper, session management
    prompt-assembler.ts # System prompt: base + role + evolved + memory context
    hooks.ts            # Safety hooks (dangerous command blocker, file tracker)
    in-process-tools.ts # In-process MCP tool servers (dynamic, scheduler, web UI)
  chat/
    http.ts             # SSE endpoint, session management, message routing
    http-handlers.ts    # Request handlers for chat API routes
    types.ts            # 32-event SSE wire format (discriminated union)
    sdk-to-wire.ts      # Translates Agent SDK events to chat wire frames
    session-store.ts    # In-memory chat session state
    message-store.ts    # Persistent message history (SQLite)
    stream-bus.ts       # Fan-out SSE event bus (multi-tab support)
    upload.ts           # File attachment upload handler
    validators.ts       # Type allowlist and size limits for attachments
    first-run.ts        # Email-based first login (Resend)
    email-login.ts      # Magic link email delivery
    notifications/      # Web Push (VAPID keys, subscriptions, triggers)
  channels/
    slack.ts            # Slack Socket Mode (primary channel, owner access control)
    telegram.ts         # Telegram via Telegraf
    email.ts            # IMAP/SMTP via ImapFlow + Nodemailer
    webhook.ts          # HTTP webhooks with HMAC-SHA256
    router.ts           # Channel message multiplexer
    feedback.ts         # Feedback buttons, evolution wiring
    status-reactions.ts # Emoji state machine for Slack reactions
    progress-stream.ts  # Progressive tool activity updates
  memory/
    system.ts           # MemorySystem coordinator
    episodic.ts         # Episode storage (Qdrant, hybrid search)
    semantic.ts         # Domain knowledge with contradiction detection
    procedural.ts       # Workflow procedures
    qdrant-client.ts    # Pure fetch Qdrant REST client
    embeddings.ts       # Ollama embedding client
    consolidation.ts    # Session-end memory extraction
  evolution/
    engine.ts           # 6-step self-evolution orchestrator
    reflection.ts       # Post-session observation extraction
    validation.ts       # 5-gate validation (constitution, regression, size, drift, safety)
    versioning.ts       # Git-like config versioning with rollback
    judge-models.ts     # Sonnet is the default judge; Opus is opt-in
  mcp/
    server.ts           # MCP Streamable HTTP server
    tools-universal.ts  # 8 universal MCP tools
    tools-swe.ts        # 6 SWE-specific MCP tools
    dynamic-tools.ts    # Dynamic tool registry (SQLite persistence)
    dynamic-handlers.ts # Shell/script handler execution (safe subprocess env)
    peers.ts            # Phantom-to-Phantom peer connections
    auth.ts             # Bearer token auth with SHA-256 + 3 scopes
  roles/
    registry.ts         # Role loader and registry
    types.ts            # RoleTemplate, Zod schemas
  scheduler/
    service.ts          # In-process scheduler (setTimeout-based, cron support)
    tool.ts             # phantom_schedule in-process MCP tool
  cli/
    init.ts             # phantom init (config generation, env-aware)
    doctor.ts           # phantom doctor (9 health checks)
    start.ts            # phantom start
    status.ts           # phantom status
    token.ts            # MCP auth token management
  ui/
    serve.ts            # Static file server with cookie auth
    session.ts          # Magic link session management
    tools.ts            # phantom_create_page, phantom_generate_login
    login-page.ts       # Login page HTML
  core/
    server.ts           # Bun.serve() HTTP server, /health, /trigger, /webhook, /ui
  db/
    schema.ts           # SQLite migrations (7 total)
    connection.ts       # Database connection
config/                 # YAML configs (phantom.yaml, channels.yaml, mcp.yaml, roles/)
phantom-config/         # Evolved agent config (constitution, persona, domain knowledge)
public/                 # Web UI files (_base.html template, index.html)
chat-ui/                # React 19 SPA (Vite + shadcn + Tailwind v4). Built to public/chat/
scripts/
  install.sh            # Standalone install script for Ubuntu/Debian
  docker-entrypoint.sh  # Docker bootstrap (wait for deps, model pull, init)
docs/                   # Documentation (architecture, channels, mcp, security, etc.)
```

## Architecture Overview

Message flow: Slack message -> SlackChannel adapter -> ChannelRouter -> SessionManager (find/create session) -> PromptAssembler (base + role + evolved config + memory context) -> AgentRuntime.query() (Opus 4.7 with full tools) -> response -> ChannelRouter -> Slack thread reply. Web chat uses the same flow: POST /chat/sessions/:id/message -> SSE stream of wire frames -> React client renders in real time. Two separate transcripts (wire-format message store for the client, SDK conversation for the agent) are kept in sync.

After each session: EvolutionEngine runs 6-step reflection pipeline -> 5-gate validation -> approved changes applied to phantom-config/ -> version bumped.

MCP flow: External client -> /mcp endpoint -> bearer auth -> MCP Server -> tool execution (some route through AgentRuntime for full Opus brain).

## Key Design Decisions

**Qdrant over LanceDB:** WAL durability with crash recovery. Native hybrid search (dense + BM25 sparse vectors). Named vectors for separate embedding spaces. Mmap mode for low memory. TypeScript REST client works with Bun (no NAPI addon risk).

**Sonnet as default judge model:** The evolution pipeline uses Sonnet as the default judge model for safety-critical gates. Cross-model evaluation avoids self-enhancement bias: the main agent runs on Opus, so judges run on Sonnet. Operators may opt into Opus judges for deeper reasoning at higher cost. Safety/constitution gates use triple-judge minority veto (one dissent blocks the change).

**Factory pattern for MCP servers:** The SDK connects each MCP server instance to one transport and rejects reuse. In-process MCP servers must be recreated per query() call. The registries they wrap are singletons, but the MCP server wrapper is new each time.

**Docker socket mount (not DinD):** Agent creates sibling containers via the host Docker daemon. Docker-in-Docker requires --privileged mode. This matches CI systems (GitHub Actions, Jenkins). The socket is root-equivalent access, which is acceptable because the agent already has full shell access.

**Tailwind v4 Browser CDN:** No build step for agent-generated pages. The agent creates HTML files in public/ and they render immediately. Theme variable declarations go in `<style type="text/tailwindcss">`, custom CSS referencing those variables goes in a plain `<style>` block.

**Non-root Docker user:** Claude Code CLI hard-exits when --dangerously-skip-permissions is used by a root process. The container runs as the phantom user with Docker socket access via group_add.

## Development Standards

- TypeScript strict mode. No `any`. No `@ts-ignore`.
- Biome for lint and format. Run `bun run lint` before committing.
- Files under 300 lines. Split if approaching 250.
- Named exports only. No default exports. No barrel files.
- Explicit return types on all public functions.
- Zod for all external input validation.
- Tests with bun:test and mocked dependencies for unit tests.
- Error messages must be human-readable and actionable.
- Comments explain WHY, never WHAT.
- No em dashes in any text, copy, or output. Use commas, periods, or regular dashes.
- No unnecessary abstractions. No premature optimization.

## Deployment

**Docker (recommended for new installs):**
```bash
git clone https://github.com/ghostwright/phantom.git && cd phantom
cp .env.example .env   # add ANTHROPIC_API_KEY + Slack tokens
docker compose up -d
```

**Bare metal (Specter VMs, production):**
```bash
rsync -az --exclude='config' --exclude='phantom-config' --exclude='data' --exclude='.env*' --exclude='*.db' src/ config/ package.json specter@<IP>:/home/specter/phantom/
ssh specter@<IP> "cd /home/specter/phantom && bun install --production"
# Restart the process (systemd or nohup)
```

Full checklist at `docs/deploy-checklist.md`. Both modes are first-class.

Production deployments are managed internally. Do NOT modify production deployments without explicit approval. Code-only updates use rsync with --exclude for config/phantom-config/data.

### Deploy gotchas (read before any Docker redeploy or fresh VM provision)

For a **fresh VM from scratch with the latest local source**, follow `docs/deploy-new-phantom.md`. It captures every trap we have hit including stale SSH host keys, the `phantom-config/` build-context requirement on first deploy, pre-chowning ALL named volumes to uid 999 before the first `docker compose up`, the `claude login` flow over docker exec, the iTerm paste-into-TUI workaround, and the Slack token sharing trap.

For an **update to an existing Docker deployment**, three specific traps to never repeat:

**1. rsync with multiple trailing-slash sources merges into the target root.** Do NOT pass several `dir/` sources to a single target. The contents collapse together and `--delete` then wipes the original directory names. Always one rsync per source directory:

```bash
rsync -az --delete src/     specter@<IP>:/home/specter/phantom/src/
rsync -az --delete public/  specter@<IP>:/home/specter/phantom/public/
rsync -az --delete scripts/ specter@<IP>:/home/specter/phantom/scripts/
```

**2. Alpine overlays into the `phantom_public` (or any phantom) volume must chown to uid 999.** Phantom inside the container runs as `uid=999(phantom)`. The host source files are owned by `specter` at uid 1000, and `cp -av` preserves numeric ownership. Without the chown, the volume ends up owned by uid 1000 and the phantom container cannot write to `/app/public` (or wherever the volume mounts). Bake the chown into the overlay:

```bash
docker run --rm \
  -v phantom_phantom_public:/dst \
  -v /home/specter/phantom/public:/src \
  alpine sh -c 'cp -av /src/. /dst/ && chown -R 999:999 /dst'
```

**3. New Docker volumes are root-owned by default.** When `docker compose up` creates a fresh named volume, the volume root is owned by `root:root`, not by the container's user. Phantom's first-boot entrypoint then crashes with `Permission denied` when it tries to seed skills, plugins, or phantom-config into the volume. **Pre-create and pre-chown every named volume BEFORE the first `docker compose up`** on a fresh VM:

```bash
for vol in phantom_phantom_claude phantom_phantom_evolved phantom_phantom_data phantom_phantom_public; do
  docker volume create $vol
  docker run --rm -v $vol:/dst alpine chown -R 999:999 /dst
done
```

Verify after every deploy with `docker exec phantom sh -c 'touch /app/public/_w && rm /app/public/_w && echo OK'`. If write fails, repeat the chown step on the affected volume.

## Known Bugs

1. **Onboarding re-fires on restart (LOW):** When evolution generation is 0, the intro DM sends again on restart. Needs an "intro_sent" flag in SQLite.

## Key Files to Read First

| File | Why |
|------|-----|
| `src/index.ts` | Main wiring. How everything connects. |
| `src/agent/prompt-assembler.ts` | The system prompt. How identity, role, evolved config, and memory are composed. |
| `src/agent/runtime.ts` | How the Agent SDK is called. Session management, hooks, cost tracking. |
| `src/evolution/engine.ts` | The self-evolution pipeline. The core differentiator. |
| `src/channels/slack.ts` | Primary channel. Owner access control, threading, reactions. |
| `src/mcp/server.ts` | MCP server setup. Tool registration, auth integration. |
| `src/memory/system.ts` | Memory coordinator. How the three tiers connect. |
| `src/chat/http.ts` | Web chat backend. SSE streaming, session routing, API handlers. |
| `src/core/server.ts` | HTTP server. Routes, health endpoint, version. |
| `config/roles/swe.yaml` | SWE role template. Onboarding questions, tools, evolution focus. |
| `phantom-config/constitution.md` | Immutable principles the evolution engine cannot modify. |
| `Dockerfile` | Multi-stage build, non-root user, tini, health check. |
| `docker-compose.yaml` | Three-service stack with named volumes and socket mount. |

## What NOT to Do

- **Don't hardcode what the agent can do.** This is the Cardinal Rule. If TypeScript is doing something the agent can do (detect frameworks, parse URLs, classify intent), you are violating the core principle.
- **Don't modify frozen Specter templates.** The cloud-init, systemd unit, and Caddyfile in Specter are shared across all deployments. Changes there affect every VM.
- **Don't run as root in Docker.** Claude Code CLI rejects --dangerously-skip-permissions as root. The non-root phantom user with group_add for Docker socket is the correct pattern.
- **Don't use inline handlers for dynamic tools.** The "inline" handler type (new Function) was removed in Phase A for RCE prevention. Only "shell" and "script" handlers are allowed.
- **Don't store secrets in phantom-config/ or memory.** Evolved config is version-controlled and visible. Secrets go in .env files only.
- **Don't commit .env files.** All .env variants are gitignored. Use .env.example as reference.
- **Don't put var() references in text/tailwindcss blocks.** Tailwind v4 Browser CDN's parser breaks on var(--color-*) inside complex CSS values like linear-gradient(). Declarations go in tailwindcss, references go in plain CSS.
- **Don't reuse MCP server instances across query() calls.** The SDK connects each instance to one transport. Create fresh instances per call (factory pattern).
- **Don't leak process.env to subprocesses.** Dynamic tool handlers use buildSafeEnv() which passes only PATH, HOME, LANG, TERM, TOOL_INPUT. Never pass API keys to child processes.
- **Don't modify docker-compose.yaml or Dockerfile from inside the agent.** That is infrastructure managed by the operator.

## Further Reading

- [Getting Started](docs/getting-started.md) - Full setup guide with Slack app creation and remote VM deployment
- [Architecture](docs/architecture.md) - System design and component overview
- [Channels](docs/channels.md) - Slack, Telegram, Email, Webhook configuration
- [MCP](docs/mcp.md) - Connecting external clients to the MCP server
- [Memory](docs/memory.md) - Three-tier vector memory architecture
- [Self-Evolution](docs/self-evolution.md) - The 6-step reflection pipeline
- [Security](docs/security.md) - Auth, secrets, permissions, and hardening
- [Roles](docs/roles.md) - Customizing the agent's specialization
