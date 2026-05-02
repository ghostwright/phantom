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
    slack.ts            # Slack Socket Mode (primary channel, owner access control, lifecycle metrics)
    slack-metrics.ts    # Phase 8a: prom-client metrics for Socket Mode lifecycle + dispatch
    slack-channel-factory.ts # Routes between Socket Mode + HTTP receiver; AllowedSecretNamesMirror lives here
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
    server.ts           # Bun.serve() HTTP server, /health, /health/build-info, /metrics, /trigger, /webhook, /ui
    build-info.ts       # Reads /etc/phantom-build-info at request-time (Phase 18 PR-6)
  db/
    schema.ts           # SQLite migrations (51 total; additive + idempotent contract)
    migration-safety.ts # CI gate that walks schema.ts (Phase 18 PR-6)
    check-migrations.ts # Entry point for the migration-safety gate
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

## Observability

The Bun.serve() HTTP server exposes a Prometheus `/metrics` endpoint (Phase 8a, R7 dated 2026-04-30). Unauthenticated, matching the existing `/health` precedent: per-tenant isolation comes from the per-tenant URL behind Caddy, not per-route auth.

Metric families exposed today (Slack Socket Mode lifecycle):

- `phantom_slack_socket_state{state="connecting|authenticated|connected|reconnecting|disconnecting|disconnected|error"}` (gauge). Exactly one series is 1.0 at any instant; the rest are 0.0. Alerting watches `1 - max_over_time(phantom_slack_socket_state{state="connected"}[1m]) > 0` for "the tenant is offline".
- `phantom_slack_socket_reconnects_total` (counter). Bolt's auto-reconnect is on by default; this measures "the network wobbled". Alert at sustained >5/min.
- `phantom_slack_socket_connection_seconds` (histogram). Lifetime of a single Socket Mode connection from connect to disconnect. p99 should hold above 1 hour.
- `phantom_slack_event_dispatch_seconds{event_type=...}` (histogram). End-to-end Bolt middleware time. Slack's ack deadline is 3 seconds; alert on p99 > 2.5s.
- `phantom_email_send_total{outcome, purpose}` (counter; Phase 10 PR 10-3). One increment per `phantom_send_email` invocation regardless of whether the send reached Resend. Outcome label is one of `ok`, `recipient_denied`, `rate_limited_local`, `key_unavailable`, `rate_limited_resend`, `validation_error`, `service_down`, `auth_failed`. Purpose is the caller-supplied tag (sanitized to ASCII letters/numbers/underscores/dashes; oversized or invalid becomes `unknown`).

Each emitter owns its own private `prom-client` Registry (no global registry pollution). The provider in `core/server.ts` returns the array of registries (`[slackMetrics.registry, emailMetrics.registry]`) and `/metrics` renders each text exposition concatenated by a single newline. Adding more channels (Telegram, webhook) means appending one more registry to the provider's return; nothing else changes.

Cross-repo invariant: `src/config/secret-names.ts` exports a frozen `AllowedSecretNamesMirror` array (`slack_bot_token`, `slack_app_token`, `slack_gateway_signing_secret`, `resend_api_key`) plus the wire-stable constant `RESEND_API_KEY_SECRET_NAME = "resend_api_key"`. The same names MUST appear in phantomd's `internal/secrets/types.go` `AllowedSecretNames` map. Drift breaks tenant boot with HTTP 404 (the gateway maps `ErrInvalidName` to 404 to defeat name enumeration). The Slack subset is also exported from `src/channels/slack-channel-factory.ts` for the Slack callsites; phantomd's `TestIsAllowedName_AcceptsResendApiKey` and `_AcceptsSlackAppToken` (plus the existing `_AcceptsSlackGatewaySigningSecret`) pin the symmetric assertions.

## Email (Phase 10 PR 10-3)

The `phantom_send_email` MCP tool wraps Resend's `/emails` endpoint with a metadata-gateway key fetch, recipient policy gate, tenant-salted idempotency, and Prometheus attribution. The architect doc is `phantom-cloud-deploy/local/2026-05-01-phase10-resend-architect.md` (canonical contract: §6 EmailTool surface, §6.8 seven `error_kind` values, §7 cost attribution, §9.6 tenant-salted idempotency).

**Key fetch.** `src/email/key-fetcher.ts` exposes `ResendKeyFetcher` (gateway-backed, 15-minute cache; `GET http://169.254.169.254/v1/secrets/resend_api_key`) and `EnvKeyFetcher` (env-backed for local dev / OSS Docker without a gateway). The wire-stable secret name is the constant `RESEND_API_KEY_SECRET_NAME` from `src/config/secret-names.ts`. The fetcher invalidates its cache on a Resend 401 so a subsequent retry refetches the rotated key.

**Env-var contract** (set by phantomd firstboot in production; set directly by the operator in local dev):

- `PHANTOM_OWNER_EMAIL`: required when the tool is enabled. Without it the policy parser throws and the tool stays unwired (no open-relay default).
- `PHANTOM_TENANT_ID`: required for cost-attribution tags + the salted idempotency key. Falls back to `config.name` in local dev.
- `PHANTOM_AGENT_ID` (optional): defaults to `PHANTOM_TENANT_ID` when missing.
- `PHANTOM_EMAIL_RECIPIENTS_ALLOWED` (optional): policy mode. Accepted values:
  - unset / empty / `owner` -> only `PHANTOM_OWNER_EMAIL` is allowed.
  - `unrestricted` (or the literal `*` for back-compat) -> any recipient is allowed; explicit operator opt-in.
  - comma-separated email list -> owner plus listed addresses are allowed.
  - `workspace` is reserved for v1.5+ and explicitly rejected today.
- `PHANTOM_EMAIL_DAILY_CAP` (optional, default 50): per-day local soft cap. Aliased as `PHANTOM_EMAIL_DAILY_LIMIT` for back-compat.
- `METADATA_BASE_URL` (optional): override the metadata gateway origin. Presence of this env OR `PHANTOM_TENANT_ID` selects the gateway-backed fetcher; otherwise the env-backed fetcher is used.

**The seven `error_kind` values** returned to the agent in the JSON envelope `{error: <message>, error_kind: <kind>}` (architect §6.8): `recipient_denied`, `rate_limited_local`, `key_unavailable`, `rate_limited_resend`, `validation_error`, `service_down`, `auth_failed`. The local cap and recipient policy are enforced before any Resend POST; the Resend SDK errors are mapped onto the four service-side kinds.

**Tags + idempotency.** Every accepted Resend POST carries `[{name: "tenant_id"}, {name: "agent_id"}, {name: "purpose"}]`. The idempotency key is `sha256("${PHANTOM_TENANT_ID}:${normalizedTo}:${subject}:${utcDate}").slice(0, 32)` (architect §9.6). The tenant-id salt defends Resend's TEAM-scoped key namespace from cross-tenant collision when multiple tenants share the same operator-side Resend key.

**Cross-repo wire.** Gateway URL: `http://169.254.169.254/v1/secrets/resend_api_key`. Secret name string: `"resend_api_key"`, mirrored byte-for-byte against phantomd `internal/secrets/types.go::AllowedSecretNames` (Phase 10 PR 10-1). Drift surfaces as HTTP 404 from the gateway, which the EmailTool surfaces as `error_kind = "key_unavailable"` to the agent.

## Tenant self-knowledge overlay (Phase 9)

The agent's system prompt carries a per-tenant identity block injected by `src/agent/prompt-blocks/tenant-self-knowledge.ts`. The assembler (`src/agent/prompt-assembler.ts`) slots it as section 1b, between Identity and Environment, so the agent reads its own facts before the environment description. The overlay is purely additive and degrades to the empty string in single-tenant dev mode (no env vars set).

Env vars consumed (all non-secret tenant identifiers):

- `PHANTOM_TENANT_SLUG`: short identifier, also the wildcard subdomain. Source: phantomd firstboot via `internal/firstboot/firstboot.go:270`.
- `PHANTOM_TENANT_ID`: read but currently not surfaced on its own; reserved for future debugging context.
- `PHANTOM_OWNER_EMAIL`: tenant owner email. Source: phantomd firstboot via `internal/firstboot/firstboot.go:273`.
- `PHANTOM_OWNER_NAME`: optional human name. Source: phantomd firstboot, queued addition (per phantomd CLAUDE.md "What's queued").
- `PHANTOM_DOMAIN`: full per-tenant origin, e.g. `gilded-hearth.phantom.ghostwright.dev`. Source: phantomd firstboot, queued addition. Falls back to `<slug>.phantom.ghostwright.dev` when missing.
- `PHANTOM_DASHBOARD_URL`: the operator's control surface URL. Source: `phantom-rootfs/systemd/phantom.service` Environment= line.
- `PHANTOM_AGENT_RUNTIME`: `anthropic` or `murph`. Source: `phantom.service` (Phase 0 hardcode) or tenant.env (Phase 1 wizard).
- `PHANTOM_MODEL`: model id. Source: tenant.env when operator picked a non-default; rootfs phantom.yaml default otherwise.
- `PHANTOM_GRANTED_INTEGRATIONS`: comma-separated list of granted integrations (Phase 7 hook; silent today).
- `PHANTOM_CHANNEL_ALLOWLIST`: comma-separated Slack channel ids (Phase 8b hook; silent today).

The tenant.env C7 invariant (consumed once at firstboot, then deleted) does NOT affect the overlay: phantom-firstboot stamps these values into `/etc/default/phantom`, which `phantom.service` sources via `EnvironmentFile=`, so they survive in `process.env` for the lifetime of the agent process.

The overlay never carries provider keys, OAuth tokens, or secrets. Every var is a non-secret identifier or label.

## Tenant self-knowledge overlay (Phase 9)

The agent's system prompt carries a per-tenant identity block injected by `src/agent/prompt-blocks/tenant-self-knowledge.ts`. The assembler (`src/agent/prompt-assembler.ts`) slots it as section 1b, between Identity and Environment, so the agent reads its own facts before the environment description. The overlay is purely additive and degrades to the empty string in single-tenant dev mode (no env vars set).

Env vars consumed (all non-secret tenant identifiers):

- `PHANTOM_TENANT_SLUG`: short identifier, also the wildcard subdomain. Source: phantomd firstboot via `internal/firstboot/firstboot.go:270`.
- `PHANTOM_TENANT_ID`: read but currently not surfaced on its own; reserved for future debugging context.
- `PHANTOM_OWNER_EMAIL`: tenant owner email. Source: phantomd firstboot via `internal/firstboot/firstboot.go:273`.
- `PHANTOM_OWNER_NAME`: optional human name. Source: phantomd firstboot, queued addition (per phantomd CLAUDE.md "What's queued").
- `PHANTOM_DOMAIN`: full per-tenant origin, e.g. `gilded-hearth.phantom.ghostwright.dev`. Source: phantomd firstboot, queued addition. Falls back to `<slug>.phantom.ghostwright.dev` when missing.
- `PHANTOM_DASHBOARD_URL`: the operator's control surface URL. Source: `phantom-rootfs/systemd/phantom.service` Environment= line.
- `PHANTOM_AGENT_RUNTIME`: `anthropic` or `murph`. Source: `phantom.service` (Phase 0 hardcode) or tenant.env (Phase 1 wizard).
- `PHANTOM_MODEL`: model id. Source: tenant.env when operator picked a non-default; rootfs phantom.yaml default otherwise.
- `PHANTOM_GRANTED_INTEGRATIONS`: comma-separated list of granted integrations (Phase 7 hook; silent today).
- `PHANTOM_CHANNEL_ALLOWLIST`: comma-separated Slack channel ids (Phase 8b hook; silent today).

The tenant.env C7 invariant (consumed once at firstboot, then deleted) does NOT affect the overlay: phantom-firstboot stamps these values into `/etc/default/phantom`, which `phantom.service` sources via `EnvironmentFile=`, so they survive in `process.env` for the lifetime of the agent process.

The overlay never carries provider keys, OAuth tokens, or secrets. Every var is a non-secret identifier or label.

## Magic-link callback (`/auth/magic`, Phase 6)

The dashboard mints a one-time, 60-second-TTL token via phantom-control and 302s the user's browser to `https://<slug>.phantom.ghostwright.dev/auth/magic?token=<43-char base64url>`. The handler at `src/ui/auth-magic.ts` validates the token server-side via the metadata gateway (`POST http://169.254.169.254/v1/magic-link/validate`, which proxies to phantom-control's bearer-auth shim), then mints a `phantom_session` cookie scoped to the per-tenant subdomain and redirects to `/chat`.

Wiring: the route is dispatched from `src/core/server.ts` at the top-level path `/auth/magic` (NOT under `/ui/`). The dashboard 302 must reach the route without a pre-existing cookie; the token IS the auth, so the route bypasses the `/ui/*` cookie gate by design.

Per-IP rate limit: 10 attempts per minute per source IP, sliding window. Successful validates do NOT bump the budget (it gates probing-by-strangers, not legitimate flows). Bounded eviction at 1024 IPs. Mirrors the rate-limit semantics in phantomd's `metadata.magicLinkRateLimiter` at `internal/metadata/magic_link_proxy.go`.

Cookie shape (per architect §7):

- `phantom_session=<32-byte base64url>` matching `createSession()` in `session.ts`.
- `Domain=<slug>.phantom.ghostwright.dev` (per-tenant; never wildcard).
- `Path=/`, `HttpOnly`, `Secure`, `SameSite=Lax`, `Max-Age=604800` (7 days).
- A second `Set-Cookie` clears any legacy `Path=/ui` cookie a browser may carry from the pre-cookie-flatten era.

Defense-in-depth gates in the handler:

1. Token shape regex (43-char base64url) before the rate-limit budget.
2. Per-IP rate limit before the validator hop.
3. Tenant-config sanity (`PHANTOM_TENANT_SLUG` + `PHANTOM_OWNER_EMAIL` both required).
4. Validator hop with 2-second timeout to the metadata gateway.
5. Cross-tenant defense: `agent_slug` from validator must equal `PHANTOM_TENANT_SLUG`.
6. Owner-email binding: validator's `owner_email` must equal `PHANTOM_OWNER_EMAIL` (case-insensitive).
7. Open-redirect defense on `?redirect=`: must be a single-leading-slash path; protocol-relative or absolute URLs fall back to `/chat`.

Failure paths: every error redirects to `${PHANTOM_DASHBOARD_URL}?magic_error=<code>` so the dashboard's Sonner toast surfaces. The token plaintext is NEVER echoed in the response body, the redirect Location, the upstream URL path/query, or any structured-log call. Codes: `invalid_token`, `rate_limited`, `expired`, `validator_unavailable`, `owner_mismatch`, `agent_mismatch`, `tenant_unconfigured`. When `PHANTOM_DASHBOARD_URL` is unset (dev mode) the fallback is `/ui/login?magic_error=...`.

Cross-repo invariants (byte-equality with neighbouring repos):

- The token-shape regex `^[A-Za-z0-9_-]{43}$` mirrors `phantom-control/internal/httpshim/magic_link.go::magicTokenShapeRE` and `phantomd/internal/metadata/magic_link_proxy.go::magicLinkTokenShapeRE`.
- The validator wire shape `{token}` (request) and `{agent_id, agent_slug, owner_email}` (response) mirrors phantom-control + phantomd byte-for-byte.
- Status mapping (200 -> success, 404 -> expired/consumed/unknown, 400 -> bad shape, 403 -> cross-tenant, 429 -> rate limit, 5xx -> validator unavailable) mirrors the phantomd proxy at `magic_link_proxy.go::handleMagicLinkValidate`.

Tests: `src/ui/__tests__/auth-magic.test.ts` (45 cases) covers happy path, every failure mode, every plaintext-leak guard, the full rate-limit semantics, the cross-tenant + owner-email gates, the open-redirect defense, and refresh survival. The route-wiring smoke is at `src/core/__tests__/server.test.ts::"GET /auth/magic"`.

## Build identity (Phase 18 PR-6)

Every phantom-rootfs image carries `/etc/phantom-build-info`, a small JSON file recording which phantom commit, which requested ref, when the rootfs was built, and adjacent provenance (full schema in `phantom-rootfs/Dockerfile` section 10b). The in-VM phantom exposes the file's contents at `GET /health/build-info` so an operator can verify what phantom version is actually running in a tenant VM:

```
curl https://<slug>.phantom.ghostwright.dev/health/build-info
```

Returns the JSON file verbatim. Schema fields: `schema_version` (currently `1`), `phantom_sha` (40-char hex), `phantom_ref_requested`, `phantom_ref_resolved`, `phantom_built_at`, `rootfs_image_name`, plus `murph_*` and `dockerfile_sha` provenance. Reconcile the response's `phantom_sha` against `phantomctl tenant get`'s `image_tag` field; mismatch indicates an upgrade in flight, a corrupted clone, or the daemon hasn't been restarted after a swap. Returns 404 with `error: "build_info_unavailable"` when the file is absent (a misconfigured dev container; production never sees this). The endpoint is unauthenticated, matching the `/health` precedent: per-tenant isolation comes from the per-tenant URL behind Caddy.

The file is read at request-time and never cached in process memory, so an in-place upgrade that overwrites the file is reflected on the next request. Tests override the path via `PHANTOM_BUILD_INFO_PATH`.

**Migration-safety CI gate.** Phantom tenants survive a snapshot-replace upgrade by rsyncing `/app/data/` (which contains `phantom.sqlite`) from the old ZFS clone to the new clone. Migrations therefore must be **additive** (no `DROP TABLE`, `DROP COLUMN`, `DROP CONSTRAINT`, `DROP INDEX`, no `RENAME`) and **idempotent** (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`). `ALTER TABLE ... ADD COLUMN` is allowed because the runner's `_migrations` index gates re-execution. The gate runs in CI on every PR via `bun run src/db/check-migrations.ts`, fails closed on any violation, and rejects the PR. The full architectural argument lives in the Phase 18 architect doc §5.2.

## First hour of work (Slice 15a)

The agent's first action on every fresh tenant is `do_first_hour_of_work`, a single-Sonnet-turn scaffold-driven runner that fires from `src/index.ts::main()` after the intro DM lands. The architect doc is `phantom-cloud-deploy/local/2026-05-03-slice-15-first-hour-of-work-architect.md`.

**The contract.** ONE turn, ONE prompt-pinned 4-step structure (PULL, IDENTIFY, DRAFT, DM), ONE 60 second hard cap enforced by `AbortController` in `src/persona/runner.ts`. The runner reads `PHANTOM_PERSONA_ID`, `PHANTOM_TENANT_SLUG`, `PHANTOM_OWNER_NAME`, `PHANTOM_OWNER_EMAIL`, `PHANTOM_GRANTED_INTEGRATIONS` from the env, builds the system-prompt scaffold from `src/persona/scaffold-prompt.ts`, runs the LLM via `src/persona/llm-caller.ts` (which wraps `runtime.handleMessage` with a `first-hour:` session id prefix), parses the JSON envelope from the model's final text, persists drafts to the local SQLite `phantom_drafts` table, sends the Block Kit DM via `src/channels/slack/render-first-hour-dm.ts`, and emits five audit events (start, pulls, drafts, dm, finish) per the architect's §7 reason-code taxonomy (11 codes locked).

**The wire.** Action_id pattern for the DM buttons is `phantom:draft:{draft_id}:{action}` where action is one of `send | edit | skip | skip_all | save_only`. The Bolt action dispatcher at `src/channels/slack-actions.ts` parses the action_id and forwards to the registered draft action recorder; phantom-control's `agent_drafts` table (slice 15b) is the cross-host record. Idempotency is layered: in-VM SQLite `firstboot_state.first_hour_of_work_completed_at` is layer 1; phantom-control's `agents.first_hour_of_work_completed_at` is layer 2 (slice 15b); the per-fire ULID is layer 3.

**Persona work-plans cross-repo invariant.** `src/persona/work-plans.ts` is the in-VM mirror of `phantom-cloud-deploy/scripts/shared/persona-work-plans.json`. Both files MUST stay byte-equal for the seven `persona_id` literals AND the `required_integrations` arrays per persona. The cross-repo verifier at `phantom-cloud-deploy/scripts/shared/verify-persona-work-plans.sh` runs in this repo's CI on every PR; strict mode flips on once the canonical fixture lands on `phantom-cloud-deploy:main`. The seven locked ids are `sdr-lilian`, `eng-cos-marcus`, `am-sloane`, `bdr-theo`, `sales-vp-priya`, `gtm-eng-ryan`, `founder-asst-adrian`. The architect doc §2.5 carried `sales-leader-priya` as a typo; the canonical wins.

**The 60 second hard cap.** Architect §6.6 names this as the partial-DM affordance, NOT a bonus. The runner's `Promise.race` between the LLM call and a `setTimeout(hard_cap_ms)` enforces wall-clock cutoff; on timeout the partial DM ships with the `Reply MORE for the rest` affordance and reason_code `sixty_second_cap_hit`. The `phantom/src/persona/__tests__/runner.test.ts::"sixty_second_cap_hit"` test exercises the AbortController path with a 50ms cap stub.

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

1. ~~**Onboarding re-fires on restart (LOW):**~~ Fixed in Phase 12 (`feat/2026-05-01-phase12-user-research-enrichment`). The firstboot ledger (`firstboot_state` table) now stamps `intro_sent_at` after a successful intro DM, and `startOnboarding` short-circuits with `skipped: true` on every later boot. Process restarts before the first evolution generation no longer re-fire the DM.

## Key Files to Read First

| File | Why |
|------|-----|
| `src/index.ts` | Main wiring. How everything connects. |
| `src/agent/prompt-assembler.ts` | The system prompt. How identity, role, evolved config, and memory are composed. Slot 1b is the tenant self-knowledge overlay (Phase 9). |
| `src/agent/prompt-blocks/tenant-self-knowledge.ts` | Phase 9 self-knowledge overlay. Reads PHANTOM_TENANT_SLUG, PHANTOM_OWNER_EMAIL/NAME, PHANTOM_DOMAIN, PHANTOM_DASHBOARD_URL, PHANTOM_AGENT_RUNTIME, PHANTOM_MODEL, PHANTOM_GRANTED_INTEGRATIONS, PHANTOM_CHANNEL_ALLOWLIST. Empty in single-tenant dev. |
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
