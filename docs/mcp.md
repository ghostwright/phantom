# MCP Endpoint

Phantom exposes its capabilities as an MCP (Model Context Protocol) server. Any MCP client can connect, including Claude Code, other Phantoms, dashboards, and custom tools.

## Endpoint

```
POST https://your-phantom-host/mcp
Authorization: Bearer <token>
Content-Type: application/json
```

The MCP server uses Streamable HTTP transport on port 3100. If running behind Caddy (Specter default), HTTPS is automatic on port 443.

## Authentication

All requests require a Bearer token. Tokens are created during `phantom init` or via `phantom token create`:

```bash
# Create a new token
bun run phantom token create --client claude-code --scope operator

# List all tokens
bun run phantom token list

# Revoke a token
bun run phantom token revoke --client claude-code
```

Running Phantom reloads token changes from `config/mcp.yaml` automatically, so new tokens do not require a restart.

Three scopes:

| Scope | Permissions |
|-------|-------------|
| `read` | Query status, memory, config, metrics, history |
| `operator` | Everything in read + ask questions, create tasks |
| `admin` | Everything in operator + register/unregister dynamic tools |

## Validating a Token

MCP uses a session-based streamable HTTP transport. A bare authenticated `curl` to `/mcp` is not enough; start with an `initialize` request:

```bash
curl -i -X POST https://your-phantom/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
```

The response includes an `Mcp-Session-Id` header. Use that header on follow-up `tools/list`, `resources/read`, and `tools/call` requests.

## Universal Tools

Available on every Phantom regardless of role:

| Tool | Scope | Description |
|------|-------|-------------|
| `phantom_ask` | operator | Ask the Phantom a question (routes through full Opus brain) |
| `phantom_status` | read | Current status, uptime, version, active sessions |
| `phantom_memory_query` | read | Search episodic and semantic memory |
| `phantom_task_create` | operator | Create a task in the queue |
| `phantom_task_status` | read | Check task status |
| `phantom_config` | read | View current evolved configuration |
| `phantom_history` | read | Session and evolution history |
| `phantom_metrics` | read | Cost, token usage, session metrics |

## Dynamic Tool Management

Available on every Phantom regardless of role:

| Tool | Scope | Description |
|------|-------|-------------|
| `phantom_register_tool` | admin | Register a new dynamic tool at runtime |
| `phantom_unregister_tool` | admin | Remove a dynamic tool (protects built-in tools) |
| `phantom_list_dynamic_tools` | read | List all registered dynamic tools |

## SWE Role Tools

Additional tools when running with the `swe` role:

| Tool | Description |
|------|-------------|
| `phantom_codebase_query` | Query accumulated codebase knowledge |
| `phantom_review_request` | Request a code review (routes through agent) |
| `phantom_pr_status` | PR status (requires GitHub/GitLab integration) |
| `phantom_ci_status` | CI pipeline status |
| `phantom_deploy_status` | Deployment status |
| `phantom_repo_info` | Repository information from domain knowledge |

## Dynamic Tools

The agent can register new tools at runtime. When a Phantom builds something (a database, a pipeline, a dashboard), it registers MCP tools so external clients can use it:

```bash
# List dynamically registered tools after initialize
curl -X POST https://your-phantom/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Mcp-Session-Id: <session-id>" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Connected clients are notified of new tools via `notifications/tools/list_changed`.

## Resources

MCP resources expose read-only data:

| URI | Description |
|-----|-------------|
| `phantom://health` | Health status |
| `phantom://config/current` | Current evolved config |
| `phantom://config/changelog` | Evolution history |
| `phantom://tasks/list` | Task queue |
| `phantom://metrics/summary` | Metrics snapshot |
| `phantom://memory/recent` | Recent episodes |

## Rate Limiting

Default: 60 requests per minute per client with a burst of 10. Configure in `config/mcp.yaml`:

```yaml
rate_limit:
  requests_per_minute: 60
  burst: 10
```

## Connecting from Claude Code

Add Phantom as a remote MCP server in your Claude Code configuration. The exact method depends on your Claude Code setup, but the key parameters are:

- **URL**: `https://your-phantom-host/mcp`
- **Transport**: Streamable HTTP
- **Auth**: Bearer token (from `phantom token create`)

## Connecting Another Phantom

In the connecting Phantom's `config/phantom.yaml`:

```yaml
peers:
  swe-phantom:
    url: https://swe.ghostwright.dev/mcp
    token: "bearer-token"
    description: "Software Engineering Phantom"
```

The peer Phantom's tools become available to the local agent's runtime. This is how a Chief of Staff Phantom queries a SWE Phantom for engineering metrics.

## Audit Log

Every MCP interaction is logged in SQLite (`data/phantom.db`, `mcp_audit` table):

- Client name, method, tool name, resource URI
- Input summary, output summary
- Cost, duration, success/error status

View recent audit entries via the `phantom_history` tool or directly in SQLite.
