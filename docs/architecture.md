# Architecture

Phantom is a single Bun process that runs on a VM. It combines an agent runtime, memory system, self-evolution engine, MCP server, and multi-channel communication into one process.

## System Diagram

```
              External Clients (Claude Code, dashboards, other Phantoms)
                        |
              MCP (Streamable HTTP, Bearer auth)
                        |
+------------------------------------------------------------------+
|                   PHANTOM PROCESS (Bun)                          |
|                                                                  |
|  HTTP Server (Bun.serve, port 3100)                              |
|    /health  /mcp  /webhook                                       |
|        |       |       |                                         |
|  +-----v-+ +--v---+ +-v--------+                                |
|  |Channel| | MCP  | | Auth     |                                |
|  |Router | |Server| | Middleware|                                |
|  +---+---+ +--+---+ +----------+                                |
|      |        |                                                  |
|  +---v--------v-----------+                                      |
|  |     Session Manager    |                                      |
|  +---+----------------+---+                                      |
|      |                |                                          |
|  +---v---------+ +----v-----------+                              |
|  |Agent Runtime| |Prompt Assembler|                              |
|  |query() wrap | |base+role+evolved|                             |
|  +---+---------+ +----+-----------+                              |
|      |                |                                          |
|  +---v---------+ +----v-----------+                              |
|  |Memory System| |Self-Evolution  |                              |
|  |Qdrant+Ollama| |6-step pipeline |                              |
|  +-------------+ +----+-----------+                              |
|                       |                                          |
|  +--------------------v----------+                               |
|  |      Evolved Config (files)   |                               |
|  | constitution.md | persona.md  |                               |
|  | domain-knowledge.md           |                               |
|  | strategies/                   |                               |
|  +-------------------------------+                               |
+------------------------------------------------------------------+
         |           |
   +-----v---+ +----v----+
   |  Qdrant | | Ollama  |
   | (Docker)| | (system)|
   +---------+ +---------+
         |
   +-----v-----------+
   | SQLite (Bun)     |
   | sessions, tasks, |
   | metrics, costs   |
   +------------------+
```

## Components

### HTTP Server

`src/core/server.ts` - Bun.serve() on port 3100. Key routes:
- `/health` - JSON health status (status, uptime, version, channels, memory, evolution)
- `/mcp` - MCP Streamable HTTP endpoint
- `/webhook` - Inbound webhook receiver
- `/chat/*` - Web chat API (SSE streaming, sessions, attachments, push subscriptions)
- `/ui/*` - Static pages and login (magic link auth)

### Channel Router

`src/channels/router.ts` - Multiplexes messages from all connected channels. Each channel implements the `Channel` interface: `connect()`, `disconnect()`, `send()`, `onMessage()`.

Channels: Slack (Socket Mode), Web Chat (SSE streaming at `/chat`), Telegram (long polling), Email (IMAP/SMTP), Webhook (HTTP), CLI (readline).

### Web Chat Channel

`src/chat/` - A full browser-based chat channel with a React 19 SPA at `/chat`. The backend uses Server-Sent Events (SSE) to stream a 32-event wire format from the Agent SDK to the client in real time. Two independent transcripts are maintained: the wire-format message store (what the client sees) and the SDK conversation (what the agent sees). This two-transcript invariant means the client can render markdown, tool calls, thinking blocks, and subagent progress without coupling to SDK internals.

Auth uses cookie-based sessions with magic link login. On first run without Slack, a login email is sent via Resend (or a bootstrap token is printed to stdout). Web Push notifications (VAPID) alert users when the agent responds while the tab is in the background.

File attachments (images, PDFs, text files) are uploaded via multipart POST and passed to the agent as context. Type allowlist and size limits are enforced server-side.

### Agent Runtime

`src/agent/runtime.ts` - Wraps the Claude Agent SDK `query()` function. Handles session management, hooks (file tracking, command blocking), and event streaming (thinking, tool_use, error).

### Prompt Assembler

`src/agent/prompt-assembler.ts` - Builds the system prompt from layers:
1. Base identity ("You are {name}, an autonomous AI co-worker...")
2. Role section (from the role template YAML)
3. Onboarding prompt (during first-run only)
4. Evolved config (constitution, persona, domain knowledge, strategies)
5. Instructions
6. Memory context (recent episodes, relevant facts)

### Memory System

`src/memory/system.ts` - Three-tier vector memory backed by Qdrant:
- **Episodic** - Session transcripts and outcomes, stored as embeddings
- **Semantic** - Accumulated facts with contradiction detection
- **Procedural** - Learned workflows and procedures

Embeddings via Ollama (nomic-embed-text, 768d vectors). Hybrid search using dense vectors + BM25 sparse vectors with RRF fusion.

### Self-Evolution Engine

`src/evolution/` wraps a three-layer learning loop:

1. **Conditional firing gate** (`gate.ts`) - one Haiku call per session decides fire or skip. Failsafe defaults to fire on any gate error.
2. **Persistent queue + cadence** (`queue.ts`, `cadence.ts`) - fired sessions live in SQLite until the 180-minute cron or the depth-based demand trigger drains the queue. The cadence `inFlight` guard serializes drains.
3. **Reflection subprocess** (`reflection-subprocess.ts`) - the Agent SDK spawns a sandboxed memory manager against `phantom-config/`. The agent reads the batch, reads the memory files, and decides what to learn, what to compact, when to skip, and which model tier to run at. TypeScript snapshots, parses the sentinel, runs a nine-invariant byte-compare check, and commits or rolls back.

`constitution.md` is immutable at three layers: SDK deny list, teaching prompt, and post-write byte compare (invariant I2). Retry bound: three invariant failures in a row graduates a queue row to `evolution_queue_poison` for manual review. See `docs/self-evolution.md` for the full invariant list and failure modes.

### MCP Server

`src/mcp/server.ts` - Exposes Phantom's capabilities as MCP tools and resources. Bearer token auth with SHA-256 hashing. Three scopes (read, operator, admin). Rate limiting per client. Full audit logging.

8 universal tools + role-specific tools + dynamic tools registered at runtime.

### Role System

`src/roles/` - YAML-first role definitions. Each role provides a system prompt section, onboarding questions, MCP tool definitions, evolution focus priorities, and feedback signal mappings.

## Data Flow

1. Message arrives via channel (Slack mention, webhook POST, web chat, etc.)
2. Channel router normalizes to `InboundMessage`
3. Session manager finds or creates a session
4. Prompt assembler builds the full system prompt
5. Agent runtime calls `query()` with hooks and events
6. Response routed back through the originating channel
7. Memory consolidation runs (non-blocking)
8. Evolution pipeline runs (non-blocking)

For web chat specifically: the client sends `POST /chat/sessions/:id/message`, the server starts an Agent SDK `query()`, and SDK events are translated to wire frames and pushed to all connected SSE streams for that session (supporting multi-tab). The wire format includes session lifecycle, text streaming, thinking blocks, tool calls with input streaming, and subagent progress.

## Technology Stack

| Component | Technology |
|-----------|------------|
| Runtime | Bun (TypeScript, no compilation) |
| Agent | @anthropic-ai/claude-agent-sdk (Opus 4.7) |
| Vector DB | Qdrant (Docker) |
| Embeddings | Ollama (nomic-embed-text) |
| State DB | SQLite (Bun built-in) |
| Channels | Slack Bolt, Web Chat (SSE), Telegraf, ImapFlow, Nodemailer |
| Chat Client | React 19, Vite, shadcn/ui, Tailwind v4 |
| Config | YAML + Zod validation |
| Process | systemd (on Specter VMs) |

## File Structure

```
src/
  agent/           - Runtime, prompt assembler, hooks, cost tracking
  chat/            - Web chat backend (SSE streaming, sessions, attachments, push notifications)
  channels/        - Slack, Telegram, Email, Webhook, CLI, status reactions
  cli/             - CLI commands (init, start, doctor, token, status)
  config/          - YAML config loaders, Zod schemas
  core/            - HTTP server, graceful shutdown
  db/              - SQLite connection, migrations
  evolution/       - Engine, gate, queue, cadence, reflection subprocess, invariant check, versioning
  mcp/             - MCP server, tools, auth, transport, dynamic tools, peers
  memory/          - Qdrant client, episodic/semantic/procedural stores
  onboarding/      - First-run detection, state, prompt injection
  roles/           - Role types, loader, registry
  shared/          - Shared patterns
config/
  phantom.yaml     - Main config
  channels.yaml    - Channel config (env var substitution)
  mcp.yaml         - MCP auth tokens
  roles/           - Role YAML definitions
phantom-config/    - Evolved config (grows over time)
data/              - SQLite database
docs/              - Documentation
```
