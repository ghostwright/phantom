# Phantom Docker Deploy Guide

How to deploy Phantom to Specter-provisioned VMs using the Docker Hub image. This is the deployment method for Phantom Cloud and all new VMs going forward.

## How It Works

Specter provisions VMs with Docker, Caddy (TLS), and a placeholder `specter-agent` systemd service. The deploy script replaces the placeholder with the real Phantom running as a Docker container from `ghostwright/phantom` on Docker Hub. No git clone, no `bun install`, no building from source.

Three containers run on each VM:
- **phantom** - the AI agent (from Docker Hub), includes the chat-ui SPA
- **phantom-qdrant** - vector memory database
- **phantom-ollama** - local embedding model (nomic-embed-text)

The Docker image includes a pre-built React chat client at `/app/public/chat/`. On every container start, the entrypoint seeds image-bundled public assets (chat SPA, base HTML template, examples) into the `phantom_public` volume. This means Docker Hub deploys get the latest chat-ui automatically on `docker compose pull && docker compose up -d` with no manual overlay step.

Caddy reverse-proxies `https://<name>.ghostwright.dev` to `localhost:3100`. This works unchanged because Docker maps port 3100 from the container to the host.

## Prerequisites

1. A Specter VM (any size, `specter deploy <name> --server-type cx53 --location fsn1 --yes`)
2. Root SSH access to the VM (all Specter VMs allow root SSH)
3. An `.env.<name>` file with the user's tokens (see "Create the Env File" below)
4. The `docker-compose.user.yaml` file from the Phantom repo

## The Deploy Script

Location: `scripts/deploy-to-specter-vm.sh`

```bash
./scripts/deploy-to-specter-vm.sh <vm-ip> <env-file> [phantom-name]

# Example:
./scripts/deploy-to-specter-vm.sh <your-vm-ip> .env.<name> <name>
```

What it does (5 steps, all idempotent):

1. **Stops specter-agent** - SSHes as root, stops and disables the systemd service, removes the service file. Safe to run even if specter-agent is already gone.
2. **Copies files** - SCPs `docker-compose.yaml` and `.env` to `/home/specter/phantom/` on the VM.
3. **Cleans existing state** - Runs `docker compose down` to tear down any existing containers AND networks. This is critical: partial starts can leave containers on orphaned networks. Always tear down before starting.
4. **Starts the stack** - Runs `docker compose up -d`. All three containers start together on the same Docker bridge network (`phantom_phantom-net`). Images are pulled from Docker Hub on first run.
5. **Waits for health** - Polls `localhost:3100/health` every 5 seconds for up to 120 seconds. On first run, the bootstrap takes 30-60 seconds (Qdrant ready, Ollama ready, embedding model pull ~270MB, config init).

## Create the Env File

Create `.env.<name>` in the Phantom repo root with:

```
ANTHROPIC_API_KEY=sk-ant-...
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
OWNER_SLACK_USER_ID=U04ABC123
PHANTOM_NAME=<name>
```

Optional:
```
PHANTOM_MODEL=claude-opus-4-7      # Default. Use claude-sonnet-4-6 for lower cost.
PHANTOM_DOMAIN=ghostwright.dev     # Enables public URL: https://<name>.ghostwright.dev
```

The `PHANTOM_MODEL` env var overrides the model at both init time (written to phantom.yaml) and runtime (loadConfig reads it). Changing the model only requires updating .env and restarting the container.

## Create a Slack App

Each Phantom instance needs its own Slack app. See `docs/deploy-checklist.md` Step 2 for the full manifest and setup instructions. The short version:

1. api.slack.com/apps > Create New App > From a manifest
2. Use the YAML manifest from `slack-app-manifest.yaml` (change the name)
3. Install to workspace
4. Copy Bot Token (xoxb-...) from OAuth and Permissions
5. Create App-Level Token (xapp-...) with `connections:write` scope
6. Get the user's Slack member ID

## Why We Don't Modify Specter

Specter provisions generic VMs. It installs Docker, Caddy, creates the specter user, sets up firewall rules, and runs a placeholder health endpoint. The deploy script handles the Phantom-specific setup:

- Specter owns: VM creation, DNS, TLS, Docker installation, firewall
- Phantom deploy script owns: stopping the placeholder, copying compose/env, starting containers

This separation means we never need to change Specter's cloud-init templates (which are frozen and require 3 deploy-test-destroy cycles to validate). All Phantom-specific logic lives in our deploy script.

The only Specter artifact we touch is `specter-agent.service`, which we remove. This is safe because:
- It's a 15-line Bun health check placeholder, not a real service
- Removing it is idempotent (the script checks before acting)
- Docker containers with `restart: unless-stopped` handle process management going forward

## What Happens On VM Reboot

Docker is enabled as a systemd service (`systemctl is-enabled docker` = enabled). On reboot:

1. Docker daemon starts automatically
2. Docker restarts all three containers (restart policy: `unless-stopped`)
3. Phantom entrypoint runs: waits for Qdrant, waits for Ollama, verifies embedding model, starts the agent
4. Caddy is already enabled and starts automatically, proxying to localhost:3100

specter-agent does NOT restart because the deploy script disabled it and removed the service file.

## Updating Phantom

When a new version is tagged and pushed to Docker Hub:

```bash
ssh specter@<IP> "cd /home/specter/phantom && docker compose pull phantom && docker compose up -d phantom"
```

This pulls the new image and restarts only the phantom container. Qdrant and Ollama continue running. Config, data, memory, and evolved state are preserved (they live on Docker volumes).

## Batch Deploy to Multiple VMs

```bash
for vm in "<ip-1>:.env.<name-1>:<name-1>" \
          "<ip-2>:.env.<name-2>:<name-2>" \
          "<ip-3>:.env.<name-3>:<name-3>"; do
  IFS=':' read -r ip env name <<< "$vm"
  echo "=== Deploying $name ==="
  ./scripts/deploy-to-specter-vm.sh "$ip" "$env" "$name"
  echo ""
done
```

## Batch Update All Docker VMs

```bash
for ip in <ip-1> <ip-2> <ip-3>; do
  echo "=== Updating $ip ==="
  ssh specter@$ip "cd /home/specter/phantom && docker compose pull phantom && docker compose up -d phantom"
  echo "=== Done $ip ==="
done
```

## Troubleshooting

### Port 3100 in use
The specter-agent placeholder is still running. The deploy script handles this automatically, but if you need to do it manually:
```bash
ssh root@<IP> "systemctl stop specter-agent && systemctl disable specter-agent && rm -f /etc/systemd/system/specter-agent.service && systemctl daemon-reload"
```

### Containers not on the same network
This happens when containers are started in separate `docker compose up` invocations (e.g., after a failed first attempt). Fix: `docker compose down` then `docker compose up -d`. The deploy script always does this.

### Health check timeout
First-run bootstrap can take 60-90 seconds (embedding model download is ~270MB). If it times out:
```bash
ssh specter@<IP> "docker logs phantom 2>&1 | tail -30"
```

Common causes:
- Qdrant not ready (entrypoint waits 60s, then starts in degraded mode)
- Ollama not ready (entrypoint waits 60s, then starts without embeddings)
- Embedding model still downloading (watch the "Model pull:" log lines)

### Session resume errors after restart
Fixed in v0.15.0. The runtime catches "No conversation found" errors from stale SDK sessions and retries as a fresh session. DMs use thread-scoped sessions, so new messages after a restart create new sessions automatically.

### SSH key conflicts
When a VM is rebuilt on a recycled IP:
```bash
ssh-keygen -R <IP>
```

## VM Pool

Production VM pool is tracked internally. Use `specter list` to see active VMs.

Docker (dev) = built from source on the VM. Docker (Hub) = pulled from ghostwright/phantom on Docker Hub. All new deploys use Docker (Hub).
