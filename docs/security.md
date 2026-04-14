# Security

Phantom runs as a persistent process with full computer access. This document covers the security model, authentication, permissions, and hardening.

## Slack Permissions

### Bot Token Scopes (all required)

These are configured automatically by the [app manifest](../slack-app-manifest.yaml).

| Scope | Purpose |
|-------|---------|
| `app_mentions:read` | Hear @Phantom mentions in channels |
| `channels:history` | Read messages in public channels |
| `channels:read` | See public channel list |
| `chat:write` | Send messages and replies |
| `chat:write.public` | Post to public channels without being invited |
| `groups:history` | Read messages in private channels |
| `im:history` | Read direct messages |
| `im:read` | See DM list |
| `im:write` | Start DM conversations |
| `reactions:read` | Track feedback reactions (thumbs up/down) |
| `reactions:write` | Add status reactions (eyes, brain, checkmark) |

### App Token Scopes

| Scope | Purpose |
|-------|---------|
| `connections:write` | Socket Mode WebSocket connection |

### Why each scope is needed

- **app_mentions:read + channels:history** - The core interaction model. Users @mention Phantom in a channel, and the bot reads the message context to respond. Without `channels:history`, the bot cannot see the conversation thread.
- **channels:read** - Used to verify channel existence and list available channels. Not strictly required for basic operation but needed for the bot to discover which channels it has access to.
- **chat:write + chat:write.public** - The bot must be able to send messages. `chat:write` covers channels the bot has joined. `chat:write.public` allows posting to any public channel by ID without needing to be invited first. Thread replies, progressive updates, and the intro message all require these scopes.
- **groups:history** - Same as `channels:history` but for private channels. Without this, the bot silently fails to respond in private channels.
- **im:history + im:read + im:write** - Direct message support. `im:read` lets the bot see its DM list, `im:history` lets it read DM content, and `im:write` lets it open new DM conversations (used for the DM-based onboarding option).
- **reactions:read** - Phantom tracks thumbsup/thumbsdown/heart reactions as feedback signals. These feed into the self-evolution pipeline to improve the agent over time.
- **reactions:write** - The status reaction state machine adds emoji reactions to user messages to show processing state (eyes -> brain -> wrench -> checkmark). Without this, the user has no visual indicator that the bot is working.

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `ANTHROPIC_API_KEY` | Yes | Claude Opus 4.6 API access |
| `SLACK_BOT_TOKEN` | For Slack | Bot user OAuth token (`xoxb-`) |
| `SLACK_APP_TOKEN` | For Slack | App-level token for Socket Mode (`xapp-`) |
| `SLACK_CHANNEL_ID` | For Slack | Default channel for intro message on first start |
| `TELEGRAM_BOT_TOKEN` | For Telegram | Telegram bot token from @BotFather |
| `GITHUB_APP_ID` | For GitHub | GitHub App ID (see GitHub App section) |
| `GITHUB_APP_CLIENT_ID` | For GitHub | GitHub App Client ID |
| `GITHUB_APP_INSTALLATION_ID` | For GitHub | Installation ID for your org/account |
| `GITHUB_APP_PRIVATE_KEY_B64` | For GitHub | Base64-encoded private key |
| `PORT` | No (default 3100) | HTTP server port |

## MCP Authentication

All MCP requests require a Bearer token. Tokens are hashed with SHA-256 before storage. The raw token is shown once during creation and never stored.

```bash
# Create tokens
bun run phantom token create --client claude-code --scope operator
bun run phantom token create --client dashboard --scope read

# Tokens are stored as hashes in config/mcp.yaml
```

### Scopes

| Scope | Access |
|-------|--------|
| `read` | Query status, memory, config, metrics, history, list dynamic tools |
| `operator` | read + ask questions, create tasks |
| `admin` | operator + register/unregister dynamic tools |

Admin scope is required for dynamic tool registration because dynamic tools can execute arbitrary code.

### Rate Limiting

Token bucket rate limiter per client. Default: 60 requests/minute, burst of 10. Configure in `config/mcp.yaml`.

## Webhook Authentication

The webhook channel uses HMAC-SHA256 signature verification:

- Request body is signed with a shared secret
- Timestamp freshness check (5-minute window) prevents replay attacks
- Timing-safe comparison prevents timing attacks

## Agent Safety Hooks

The agent runtime includes safety hooks:

- **Dangerous Command Blocker** - blocks destructive commands (`rm -rf /`, `mkfs`, `dd to device`, `docker system prune`, `git push --force`, etc.) before execution. This is defense-in-depth, not a security boundary. The real safety layers are the constitution, LLM judges, and owner access control.
- **File Tracker** - tracks all files the agent reads and writes for audit

## Constitution

The self-evolution engine has 9 immutable principles in `phantom-config/constitution.md` that cannot be modified by the evolution process:

- Never exfiltrate data
- Never modify its own safety hooks
- Always respect user corrections
- Always maintain audit trail
- (and 4 more)

These are enforced by the Constitution Gate during every evolution cycle. The constitution checker rejects any config delta that would violate these principles.

## 5-Gate Validation

Every evolution change passes through 5 gates:

1. **Constitution Gate** - does it violate immutable principles?
2. **Regression Gate** - does it break golden test cases?
3. **Size Gate** - is any config file over 200 lines?
4. **Drift Gate** - has semantic distance from the original drifted too far?
5. **Safety Gate** - does it touch protected patterns?

When LLM judges are enabled, triple-judge voting with minority veto is used for safety-critical gates (safety and constitution). A single judge objection blocks the change.

## Secrets Management

- API keys are provided via environment variables, never stored in config files
- `config/channels.yaml` uses `${ENV_VAR}` substitution so tokens stay in the environment
- MCP tokens are stored as SHA-256 hashes, not plaintext
- On Specter VMs, secrets are injected via cloud-init and deleted after boot
- `phantom init` writes tokens to `.env.local` (gitignored) when provided interactively, but skips `.env.local` when tokens come from environment variables (avoids duplicating secrets)

## Network Security (Specter VMs)

When deployed via Specter:

- Dual firewall (Hetzner Cloud Firewall + ufw), ports 22/80/443 only
- Caddy provides automatic TLS via Let's Encrypt
- systemd hardening: NoNewPrivileges, ProtectSystem=strict, ProtectHome=read-only, PrivateTmp
- fail2ban for SSH brute-force protection
- The agent process runs as the `specter` user, not root
- Memory limits: 2GB max, 1.5GB high watermark, 256 max tasks

## Audit Logging

Every MCP interaction is logged in SQLite:

- Client name, method, tool name
- Input summary (truncated to 200 chars)
- Duration, cost, success/error status
- Timestamp

View recent entries via `phantom_history` MCP tool.

## Dynamic Tool Security

Dynamic tools (registered at runtime by the agent) execute code in isolated subprocesses:

- Only admin-scoped clients can register tools
- Two handler types: `shell` (bash commands) and `script` (bun scripts on disk)
- The `inline` handler type (which used `new Function()`, equivalent to eval) has been removed as a security P0 fix
- Subprocesses run with a sanitized environment containing only PATH, HOME, LANG, TERM, and TOOL_INPUT. API keys, tokens, and other secrets are never passed to dynamic tool subprocesses.
- Bun script handlers use `--env-file=` to prevent automatic loading of `.env` files
- Tool input is passed via the TOOL_INPUT environment variable (JSON string)

## GitHub App Authentication

Phantom can use a GitHub App for authenticated access to GitHub repositories via the `phantom_gh_exec` tool. The installation token is injected into subprocess environments - it never appears in model context or tool results.

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `GITHUB_APP_ID` | GitHub App ID (numeric) |
| `GITHUB_APP_CLIENT_ID` | GitHub App Client ID (Iv1.xxx format) |
| `GITHUB_APP_INSTALLATION_ID` | Installation ID for your organization/account |
| `GITHUB_APP_PRIVATE_KEY_B64` | Base64-encoded private key (.pem file) |

To encode the private key:
```bash
base64 -w 0 < your-app.private-key.pem
```

### Token Rotation Playbook

**When to rotate:**
- Private key compromise (leaked .pem file)
- Suspicious commit activity from the bot account
- Employee with key access leaving the organization
- Routine rotation (recommended: every 90 days)

**How to rotate:**

1. Go to GitHub App settings: `https://github.com/settings/apps/<app-name>`
2. Under "Private keys", click "Generate a private key"
3. Download the new .pem file
4. Encode it: `base64 -w 0 < new-key.pem`
5. Update `GITHUB_APP_PRIVATE_KEY_B64` in your `.env` file
6. Restart Phantom: `systemctl restart phantom` (or `docker compose restart phantom`)
7. (Optional) Revoke the old key in GitHub App settings

The cached installation token will be automatically rejected on next use and a fresh token will be minted with the new key.

**Audit trail:**
- Key generation events are logged in the GitHub App's settings page under "Private keys"
- Installation tokens are short-lived (1 hour) and automatically refreshed
- All `phantom_gh_exec` invocations are logged in the agent's audit trail

**Security notes:**
- Never commit .pem files or base64-encoded keys to git
- Store keys in `.env.local` (gitignored) or inject via secrets manager
- The `phantom doctor` command warns if GitHub App credentials are missing but does not fail - this allows Phantom to run without GitHub access

## Webhook Callback URL Validation

Webhook callback URLs are validated before use to prevent SSRF attacks:

- Private IP ranges are blocked (10.x, 172.16-31.x, 192.168.x, 127.x)
- Cloud metadata endpoints are blocked (169.254.169.254, metadata.google.internal)
- Localhost and 0.0.0.0 are blocked
- Only HTTP and HTTPS protocols are allowed

## Layered Security Model

Phantom's security is defense-in-depth, with multiple independent layers:

1. **Owner access control** - Only the configured owner can talk to the agent (Slack user ID filtering)
2. **Constitution** - 8 immutable behavioral principles the agent cannot override
3. **LLM safety judges** - Independent Sonnet 4.6 judges review evolution changes, triple-judge with minority veto
4. **Dangerous command blocker** - Regex patterns catch obvious destructive commands (not a security boundary)
5. **Subprocess isolation** - Dynamic tools run in clean environments without secrets
6. **MCP authentication** - Bearer tokens with scoped access (read/operator/admin)
7. **Network firewalls** - Hetzner Cloud Firewall + ufw, ports 22/80/443 only
8. **Audit logging** - All MCP interactions logged to SQLite
