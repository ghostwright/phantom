# Security Policy

Phantom runs as an autonomous agent with shell access, Docker control, and network access on a dedicated machine. Security is not an afterthought. This document describes how we handle vulnerabilities, what our security boundaries are, and what is honest about the threat model.

## Reporting a Vulnerability

If you find a security vulnerability in Phantom, please report it privately.

**Email:** cheemawrites@gmail.com

**What to include:**
- Description of the vulnerability
- Steps to reproduce
- Impact assessment (what an attacker could do)
- Any suggested fix (optional, but appreciated)

**Our commitment:**
- Acknowledge your report within 48 hours
- Provide a plan within 7 days
- Ship a fix within 30 days for confirmed vulnerabilities
- Credit you in the release notes (unless you prefer to remain anonymous)

**Please do not** open a public GitHub issue for security vulnerabilities. Responsible disclosure gives us time to fix the issue before it can be exploited.

## Security Model

### Credential Encryption

User credentials are encrypted with AES-256-GCM using a per-deployment 32-byte key. Each encryption operation uses a unique random IV (12 bytes) and produces an authentication tag (16 bytes) for tamper detection.

The encryption key is sourced from `SECRET_ENCRYPTION_KEY` (hex-encoded environment variable) or auto-generated at `data/secret-encryption-key` with `0o600` permissions.

Implementation: `src/secrets/crypto.ts`

### Subprocess Environment Isolation

Dynamic tool handlers (shell scripts and script files the agent creates at runtime) execute in a sanitized environment. `buildSafeEnv()` constructs a minimal environment with only `PATH`, `HOME`, `LANG`, `TERM`, and `TOOL_INPUT`. No API keys, tokens, or secrets from `process.env` are passed to subprocesses. Additionally, Bun subprocesses are launched with `--env-file=` (empty) to prevent auto-loading of `.env` files.

Implementation: `src/mcp/dynamic-handlers.ts`

### Non-Root Docker Container

The Phantom container runs as the `phantom` user, not root. Claude Code CLI refuses `--dangerously-skip-permissions` when running as root, so this is enforced at the container level. Docker socket access is granted via `group_add` in `docker-compose.yaml`, matching the host's Docker GID.

Implementation: `Dockerfile` (lines 60-67, 99-100)

### MCP Authentication

The MCP server uses bearer token authentication with SHA-256 hashing. Tokens are stored as hashes, never in plaintext. Three scopes control access: `read`, `operator`, and `admin`. The `admin` scope implies all permissions. The `operator` scope implies `read`.

Implementation: `src/mcp/auth.ts`

### Web UI Authentication

The web UI uses magic-link sessions with a 10-minute token expiry. No passwords are stored. Login links are generated per-session and delivered via Slack DM to the owner.

### Evolution Safety Gates

The self-evolution pipeline validates every proposed config change through 5 gates before it can be applied:

1. **Constitution gate** - changes must not violate immutable principles
2. **Regression gate** - changes must not break golden-suite test cases
3. **Size gate** - changes must be minimal and targeted
4. **Drift gate** - cumulative changes must stay within bounds
5. **Safety gate** - changes must not weaken security boundaries

Safety-critical gates use Sonnet as the default cross-model judge. Cross-model evaluation avoids self-enhancement bias: the main agent runs on Opus, so judges run on Sonnet. Operators may opt into Opus judges explicitly for deeper reasoning at higher cost. Triple-judge voting with minority veto: one dissenting judge blocks the change.

Implementation: `src/evolution/validation.ts`

### Agent Security Boundaries

The agent's system prompt enforces hard boundaries: no revealing secrets, no sharing API keys, no killing its own process, no modifying its source code, no destructive filesystem operations on system directories, and no modifying systemd or reverse proxy configuration.

Implementation: `src/agent/prompt-assembler.ts` (buildSecurity function)

## Known Security Considerations

We believe in being honest about the threat model.

**Docker socket access is root-equivalent.** The mounted Docker socket gives the agent the ability to create sibling containers with arbitrary privileges on the host. This is acceptable because the agent already has full shell access on its dedicated machine, and Docker-in-Docker would require `--privileged` mode, which is worse. This matches how CI systems (GitHub Actions, Jenkins) handle Docker.

**The agent has network access.** It can call external APIs, clone repositories, and download packages. This is by design. Network isolation would prevent the agent from doing useful work.

**Self-evolution can modify behavior.** The agent rewrites its own configuration after every session. All changes pass through the 5-gate validation pipeline. Every version is stored and can be rolled back. But a sufficiently clever adversarial input could, in theory, influence the agent's behavior over time. This is mitigated by cross-model judges and constitution checks.

**The inline handler type was removed.** Dynamic tool handlers originally supported `new Function()` evaluation. This was removed for RCE prevention. Only `shell` and `script` handler types are allowed.

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest release | Yes |
| Older releases | No |

We only provide security fixes for the latest release. We recommend always running the latest version.

## Not In Scope

The following are not considered Phantom vulnerabilities:

- **Anthropic API key security.** Protecting your API key is your responsibility. Do not commit it to version control or share it in chat.
- **Model-level jailbreaks.** Prompt injection or jailbreak attacks against the underlying Claude model should be reported to [Anthropic](https://www.anthropic.com/responsible-disclosure-policy).
- **Third-party dependency vulnerabilities.** Report these to the upstream maintainer. If a dependency vulnerability directly impacts Phantom, open an issue.
- **Self-hosted infrastructure misconfiguration.** Phantom provides secure defaults, but operators are responsible for their own firewall rules, TLS configuration, and network security.
- **Denial of service via API rate limiting.** The Anthropic API has its own rate limits. Phantom does not add an additional rate-limiting layer.

## Acknowledgments

We are grateful to security researchers who help make Phantom safer. If you report a valid vulnerability, we will credit you here (with your permission).
