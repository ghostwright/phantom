# Slack distributed-app operator runbook (Cloud mode)

This doc covers the in-tenant Phantom side of the Slack distributed-app
flow. It is the companion to the gateway operations runbook at
[`phantom-slack-events/docs/operations-slack-gateway.md`](../../phantom-slack-events/docs/operations-slack-gateway.md);
the gateway runbook covers the centralised hop, this doc covers what
runs on each tenant VM.

If you are setting up Phantom for the first time on a single Slack
workspace you own, you do NOT need this doc. The Socket Mode flow
documented in [getting-started.md](getting-started.md) covers that
path. This doc applies only to tenants running on Phantom Cloud where
one distributed Slack app is installed across many tenant workspaces.

## The two transports

`SLACK_TRANSPORT` selects which receiver Phantom runs at startup. The
read happens once at boot via
[`readSlackTransportFromEnv`](../src/channels/slack-channel-factory.ts):

| Value | Receiver | Source of bot token | Use case |
|---|---|---|---|
| (unset) or `socket` | `SlackChannel` (Socket Mode) | `channels.yaml` | OSS self-host on a single workspace |
| `http` | `SlackHttpChannel` (Bolt ExpressReceiver) | metadata gateway | Phantom Cloud distributed-app tenant |

The factory at
[`createSlackChannel`](../src/channels/slack-channel-factory.ts) is the
only place the dispatch happens. Once the receiver is constructed, the
rest of Phantom (channel router, agent runtime, evolution engine)
treats both transports as one Slack channel.

## What `SLACK_TRANSPORT=http` does at boot

When the agent starts with `SLACK_TRANSPORT=http`:

1. The factory calls
   [`MetadataIdentityFetcher.get()`](../src/config/identity-fetcher.ts).
   The fetcher GETs `http://169.254.169.254/v1/identity` (the link-local
   metadata gateway address; phantomd's
   `/internal/metadata/secrets_handler.go` serves the response).
2. The response body is parsed against the documented `TenantIdentity`
   shape. The mandatory fields are `tenant_id`, `tenant_slug`, `region`,
   `host_id`, `env`. The optional `slack` subfield carries the
   per-install Slack identity.
3. If the `slack` subfield is missing, the factory throws with the
   message `SLACK_TRANSPORT=http requires a Slack install in
   /v1/identity.slack; got none. Run the OAuth flow via phantom-control
   or revert to SLACK_TRANSPORT=socket.` This is fail-loud-on-startup
   behaviour: a misconfigured tenant boot returns a clear error so the
   operator does not chase silent message drops.
4. The factory calls
   [`MetadataSecretFetcher.get("slack_bot_token")`](../src/config/metadata-fetcher.ts)
   and `MetadataSecretFetcher.get("slack_gateway_signing_secret")` in
   parallel. These hit `http://169.254.169.254/v1/secrets/<name>` and
   are decrypted by phantomd inside the host using the AWS KMS-backed
   secrets pipeline (Phase C).
5. The factory constructs `SlackHttpChannel` with the bot token,
   gateway signing secret, team id, installer user id, team name, and
   listen port. The channel mounts `/slack/events`, `/slack/interactivity`,
   and `/slack/commands` on the Phantom HTTP server (the same port that
   serves `/health`, `/chat`, and `/mcp`).

## The four metadata gateway endpoints the agent consumes

| Endpoint | Returns | Source of truth |
|---|---|---|
| `GET /v1/identity` | `TenantIdentity` JSON | phantomd composes from local SQLite + phantom-control's `UpdateSlackIdentity` |
| `GET /v1/secrets/slack_bot_token` | bot token plaintext | phantom-control's `UpsertInstallation` writes the encrypted blob; phantomd decrypts on demand |
| `GET /v1/secrets/slack_gateway_signing_secret` | shared HMAC secret plaintext | phantom-control's `operator_config.gateway_signing_secret_active` |
| `GET /v1/secrets/<other>` | other tenant secrets (provider key, etc.) | per-tenant `tenant_secrets` rows |

Plaintext is NEVER logged. Errors carry the secret name and HTTP
status only; both fetchers strip body content from error messages by
construction. The
[`MetadataSecretFetcher`](../src/config/metadata-fetcher.ts) caches
each value for 60 seconds and uses `If-None-Match` ETag refresh
against phantomd's `X-Phantom-Rotation-Id` header so a 304 reply
extends the cache window without re-disclosing plaintext.

The identity fetcher does NOT cache. Identity is fetched once at boot;
rotation requires a daemon restart (see "bot token lifecycle" below).

## Bot token lifecycle

The bot token is the most sensitive value the agent holds. The
end-to-end flow:

1. **Install.** A tenant operator clicks "Add to Slack" in the
   ghostwright-site wizard. The OAuth round-trip lands at
   `phantom-slack-events`'s `/slack/oauth_redirect` handler. That
   handler exchanges the code for a bot token via
   `oauth.v2.access`, then calls phantom-control's
   `UpsertInstallation` RPC with the plaintext bot token.
2. **Encrypt-at-rest.** Phantom-control writes the encrypted bot
   token to Neon (the `slack_installations` table). The encryption
   key is the per-environment KMS CMK; the encryption context binds
   the ciphertext to the tenant id. See
   [`phantomd/docs/operations-secrets.md`](../../phantomd/docs/operations-secrets.md)
   for the full secrets architecture.
3. **Provision.** Phantom-control pushes the per-tenant identity
   (including the `slack` subfield) to phantomd via
   `UpdateSlackIdentity`. Phantomd's metadata gateway now serves
   `/v1/identity.slack` with the team id, installer user id, team
   name, and installed-at timestamp.
4. **Boot.** The tenant Phantom starts with `SLACK_TRANSPORT=http`.
   The factory fetches identity, then fetches the bot token plaintext
   from `/v1/secrets/slack_bot_token`. The token lives in the
   `SlackHttpChannel` instance for the lifetime of the process.
5. **Use.** The agent calls Slack API methods (`chat.postMessage`,
   `auth.test`, `reactions.add`) through the Bolt `App.client`. The
   token is passed to slack-go via the `App` constructor, never
   logged, never written to disk.
6. **Rotate.** When the operator rotates the bot token (the most
   common case is an operator-initiated revoke and re-install), the
   sequence is:
   - Phantom-control calls `auth.revoke` on the OLD token.
   - Phantom-control writes the NEW token to Neon and pushes
     `UpdateSlackIdentity` to phantomd.
   - Phantomd evicts its 60-second secret cache for the affected
     tenant.
   - Operator restarts the tenant Phantom: `systemctl restart
     phantom-tenant@<tenant_id>`. There is no hot-reload of the bot
     token in v1; the
     [phantomd known-issues note](../../phantomd/docs/operations-secrets.md)
     documents the same constraint for the provider token. A
     `RestartTenant` RPC is Phase D scope.

If the bot token is revoked by the workspace owner upstream of our
control flow (the user removes the app from Slack), the next
`auth.test` from `SlackHttpChannel.connect()` returns a Slack
`token_revoked` error. The receiver throws on connect; operators
should clean up via the gateway's
[forced-uninstall procedure](../../phantom-slack-events/docs/operations-slack-gateway.md).

## Diagnostic commands

The metadata gateway listens only inside the per-tenant network
namespace. To inspect from the host, use `ip netns exec`. Resolve the
namespace name from the tenant id; phantomd derives it as
`phn-<hash>` and exposes it via `phantomctl get -id <tenant_id>`:

```bash
# Identify the namespace.
ssh root@phantom-cloud-prod 'phantomctl get -id 01HQ4Z...'
# Look for the netns field in the output, or list directly:
ssh root@phantom-cloud-prod 'ip netns list | grep phn-'

# Fetch the identity payload as the tenant Phantom sees it.
ssh root@phantom-cloud-prod 'ip netns exec phn-<hash> \
  curl -sS http://169.254.169.254/v1/identity | jq .'

# Confirm the slack subfield is present and the team id matches the
# expected workspace.
ssh root@phantom-cloud-prod 'ip netns exec phn-<hash> \
  curl -sS http://169.254.169.254/v1/identity | jq .slack'

# Confirm the bot token is decryptable. Do NOT log the value to a
# pager; redirect to a file the operator can review locally and then
# shred. The metadata gateway returns the plaintext directly.
ssh root@phantom-cloud-prod 'ip netns exec phn-<hash> \
  curl -sS -o /tmp/bot.tmp http://169.254.169.254/v1/secrets/slack_bot_token \
  && wc -c /tmp/bot.tmp \
  && shred -u /tmp/bot.tmp'

# Confirm the gateway signing secret matches what the gateway expects.
# A mismatch is the most common reason the tenant rejects forwards
# with HTTP 401.
ssh root@phantom-cloud-prod 'ip netns exec phn-<hash> \
  curl -sS -o /tmp/sig.tmp http://169.254.169.254/v1/secrets/slack_gateway_signing_secret \
  && wc -c /tmp/sig.tmp \
  && shred -u /tmp/sig.tmp'
```

For runtime traffic checks, the receiver's three endpoints are:

| Endpoint | Verb | Source |
|---|---|---|
| `/slack/events` | POST | gateway forward of Slack event_callback |
| `/slack/interactivity` | POST | gateway forward of block_actions / view_submission / etc |
| `/slack/commands` | POST | gateway forward of slash command |

The receiver mounts a guard middleware that verifies the
gateway HMAC and asserts the parsed `team_id` matches the installer
team id. Failed verification returns 401; foreign team id returns 403.
Both branches are observable in the per-tenant Phantom journal:
`journalctl -u phantom-tenant@<tenant_id> -n 100 -f`.

## Failure modes

| Symptom | Likely cause | Mitigation |
|---|---|---|
| Phantom logs `auth.test returned no user_id; bot token may be revoked` at boot | Bot token revoked upstream by the workspace owner | Force-uninstall via the gateway runbook; user re-installs |
| Phantom logs `SLACK_TRANSPORT=http requires a Slack install in /v1/identity.slack; got none` | OAuth flow incomplete or `UpdateSlackIdentity` not propagated | Re-run the wizard; check phantomd journal for the `UpdateSlackIdentity` line; confirm phantom-control has the `slack_installations` row |
| Receiver returns 401 to gateway forwards | Gateway signing secret mismatch (rotation in flight) | Restart the tenant Phantom so it re-fetches `/v1/secrets/slack_gateway_signing_secret` |
| Receiver returns 403 to gateway forwards | Gateway forwarded an event for a different team_id | Bug in tenant lookup; capture the request and contact the gateway operator |
| Phantom logs `metadata: fetch slack_bot_token failed: HTTP 503` | KMS unreachable from phantomd | Wait for KMS recovery; phantomd's secrets runbook covers the longer-term mitigations |
| Phantom logs `metadata: fetch slack_gateway_signing_secret failed: HTTP 404` | Phantom-control has not pushed the operator-config row yet | Run the gateway's first-time deploy step that persists `gateway_signing_secret_active`; the 404 clears once the metadata gateway sees the value |

For incidents that span the gateway and the tenant, use the gateway's
[runbook section 15.7](../../phantom-slack-events/docs/operations-slack-gateway.md)
as the entry point: a phantom-control outage cascades to both sides
and the gateway's metrics surface the signal first.

## See also

- [getting-started.md](getting-started.md) for the OSS Socket Mode flow.
- [security.md](security.md) for the broader auth/secrets posture.
- [`phantom-slack-events/docs/operations-slack-gateway.md`](../../phantom-slack-events/docs/operations-slack-gateway.md)
  for the centralised gateway side.
- [`phantomd/docs/operations-secrets.md`](../../phantomd/docs/operations-secrets.md)
  for the secrets pipeline phantomd serves the metadata gateway from.
- [`ghostwright-site/docs/phantom-signup-walkthrough.md`](../../ghostwright-site/docs/phantom-signup-walkthrough.md)
  for the user-facing wizard and OAuth state-token round-trip.
