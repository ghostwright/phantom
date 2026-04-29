# Getting Started

Zero to a running Phantom in 10 minutes.

This guide walks you through every step. If you get stuck, open an issue on GitHub.

## What You Need

1. **An Anthropic API key.** Get one at [console.anthropic.com](https://console.anthropic.com/). Starts with `sk-ant-`.
2. **Docker and Docker Compose.** Install from [docs.docker.com/engine/install](https://docs.docker.com/engine/install/). If `docker compose version` prints a version number, you are good.
3. **A way to talk to it.** Either a Slack workspace (recommended) or just a browser. The web chat at `/chat` works with no Slack at all - just set `OWNER_EMAIL` in `.env` for login.

That is it. No Bun, no Node, no git clone. Docker handles everything.

## Step 1: Create Your Slack App

Skip this section if you want to run Phantom without Slack. You can always add it later.

This takes about 5 minutes. The repo includes a manifest file that configures everything automatically.

### Create the app

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click **Create New App**
3. Choose **From an app manifest**
4. Select the workspace you want to install into
5. Switch to the **YAML** tab
6. Copy the entire contents of [`slack-app-manifest.yaml`](../slack-app-manifest.yaml) and paste it in
7. Click **Next**, review the summary, then click **Create**
8. On the next page, click **Install to Workspace** and approve the permissions

### Rename it (optional)

The manifest creates the app with the name "Phantom". If you want a different name, go to **Settings** > **Basic Information** and change **App Name** to whatever you want. Do this after creating the app, not by editing the manifest.

### Get your tokens

You need three values from the Slack app you just created.

**Bot Token:**
1. In the sidebar, go to **OAuth & Permissions**
2. Copy the **Bot User OAuth Token**. It starts with `xoxb-`.

**App Token:**
1. In the sidebar, go to **Basic Information**
2. Scroll to **App-Level Tokens** and click **Generate Token and Scopes**
3. Name it anything (e.g., "socket")
4. Click **Add Scope** and select `connections:write`
5. Click **Generate**
6. Copy the token. It starts with `xapp-`.

**Your Slack User ID:**
1. In the Slack desktop app, click your name or profile picture
2. Click the three dots menu
3. Click **Copy member ID**
4. It starts with `U` (e.g., `U04ABC123XY`)

You now have three values: a `xoxb-` token, a `xapp-` token, and a `U...` user ID. Keep them handy.

## Step 2: Configure Your .env File

Download the compose file and env template:

```bash
curl -fsSL https://raw.githubusercontent.com/ghostwright/phantom/main/docker-compose.user.yaml -o docker-compose.yaml
curl -fsSL https://raw.githubusercontent.com/ghostwright/phantom/main/.env.example -o .env
```

Open `.env` in your editor and fill in these values:

### Required

```
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

Your Anthropic API key. This is the only value you absolutely must set for the default setup.

**Using a different provider?** Phantom supports Z.AI (GLM-5.1, ~15x cheaper than Claude Opus), OpenRouter, Ollama, vLLM, LiteLLM, and custom endpoints. For example, to run Phantom on Z.AI:

```
ZAI_API_KEY=your-zai-key
```

Then add this to `phantom.yaml`:

```yaml
provider:
  type: zai
  api_key_env: ZAI_API_KEY
  model_mappings:
    sonnet: glm-5.1
```

See [docs/providers.md](providers.md) for the full provider reference.

### Slack (recommended)

```
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
OWNER_SLACK_USER_ID=U04ABC123XY
```

- `SLACK_BOT_TOKEN` - The bot token from OAuth & Permissions (starts with `xoxb-`).
- `SLACK_APP_TOKEN` - The app-level token you generated (starts with `xapp-`).
- `OWNER_SLACK_USER_ID` - Your Slack user ID (starts with `U`). Only this user can talk to Phantom. If you leave this blank, anyone in your workspace can message it.

### Web Chat (no Slack needed)

```
OWNER_EMAIL=you@example.com
RESEND_API_KEY=re_...
```

- `OWNER_EMAIL` - Your email address. Used for magic link login to the web chat at `/chat`. If Slack is not configured, this is how Phantom authenticates you on first run.
- `RESEND_API_KEY` - API key from [resend.com](https://resend.com). Used to send magic link login emails. If not set, a bootstrap token is printed to container logs instead.

### Optional

```
PHANTOM_NAME=phantom
PHANTOM_MODEL=claude-opus-4-7
```

- `PHANTOM_NAME` - What your Phantom calls itself. Default: `phantom`.
- `PHANTOM_MODEL` - The Claude model. Options: `claude-opus-4-7` (default, recommended), `claude-sonnet-4-6` (lower cost), `claude-opus-4-6` (previous frontier).

Everything else in `.env.example` has sensible defaults. You can leave the rest commented out.

### Minimum working .env

If you just want the shortest path to a running Phantom with Slack:

```
ANTHROPIC_API_KEY=sk-ant-your-key-here
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
OWNER_SLACK_USER_ID=U04ABC123XY
```

Four lines. That is all Phantom needs.

Without Slack, the minimum is two lines:

```
ANTHROPIC_API_KEY=sk-ant-your-key-here
OWNER_EMAIL=you@example.com
```

Add `RESEND_API_KEY` for email-based login. Without it, check `docker logs phantom` for the bootstrap token on first start.

## Step 3: Start Phantom

```bash
docker compose up -d
```

That is the entire command.

### What happens on first boot

1. Docker pulls three images: Phantom, Qdrant (vector database for memory), and Ollama (embedding model).
2. The Phantom container waits for Qdrant and Ollama to be ready.
3. Ollama downloads the `nomic-embed-text` embedding model (~270MB). This only happens once.
4. Phantom runs `phantom init --yes`, which generates config files from your .env values.
5. Phantom connects to Slack and sends you a DM saying it is ready.

First boot takes 2-3 minutes because of the model download. After that, restarts take about 15-20 seconds.

### Watching the logs

If you want to see what is happening during first boot:

```bash
docker logs phantom -f
```

Press Ctrl+C to stop following. The important lines to look for:

```
[phantom] Qdrant is ready
[phantom] Ollama is ready
[phantom] Model pull complete
[phantom] Configuration initialized
[phantom] Starting Phantom...
```

## Step 4: Verify It Works

### Check the health endpoint

```bash
curl http://localhost:3100/health
```

You should get a JSON response with `"status":"ok"`. It includes the agent name, Slack connection status, and memory system status.

### Check the web chat

Open `http://localhost:3100/chat` in your browser. If you set `OWNER_EMAIL`, you will receive a login email (or find a bootstrap token in `docker logs phantom`). After logging in, you can chat with your Phantom directly in the browser.

### Check Slack

If you configured Slack, your Phantom should have sent you a direct message. Open Slack and look for a DM from it. Say hello. It will respond.

If you do not see a DM, check the logs:

```bash
docker logs phantom --tail 50
```

### Check all three containers

```bash
docker ps
```

You should see three containers running: `phantom`, `phantom-qdrant`, and `phantom-ollama`.

## Step 5: Deploy to a Remote VM

Running Phantom on your laptop works great for trying it out. For a persistent setup that runs 24/7, put it on a cloud VM.

Any cloud provider works: Hetzner, DigitalOcean, AWS, GCP, Linode, Vultr. The minimum spec:

- 2 vCPU
- 4 GB RAM
- 40 GB disk
- Ubuntu 22.04 or newer

### On the remote VM

SSH into your VM and install Docker:

```bash
# Install Docker (official method for Ubuntu/Debian)
curl -fsSL https://get.docker.com | sh
```

Create a directory and download the files:

```bash
mkdir -p ~/phantom && cd ~/phantom

curl -fsSL https://raw.githubusercontent.com/ghostwright/phantom/main/docker-compose.user.yaml -o docker-compose.yaml
```

Create your `.env` file:

```bash
cat > .env << 'EOF'
ANTHROPIC_API_KEY=sk-ant-your-key-here
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
OWNER_SLACK_USER_ID=U04ABC123XY
PHANTOM_NAME=your-phantom-name
PHANTOM_MODEL=claude-opus-4-7
EOF
```

Start it:

```bash
docker compose up -d
```

Wait 2-3 minutes for first boot, then verify:

```bash
curl http://localhost:3100/health
```

### Docker socket permissions

The Phantom container needs access to the Docker socket so the agent can create sibling containers for code execution. The compose file sets this up with `group_add` using a default GID of 988, which works on most cloud VMs.

If you get Docker permission errors, find your Docker socket's group ID and set it in `.env`:

```bash
# Find your Docker socket GID
stat -c '%g' /var/run/docker.sock

# Add to .env
echo "DOCKER_GID=YOUR_GID_HERE" >> .env

# Restart
docker compose down && docker compose up -d
```

### Optional: HTTPS with a domain

If you want Phantom accessible on a public domain (e.g., `phantom.yourdomain.com`):

1. Point a DNS A record to your VM's IP address
2. Install Caddy as a reverse proxy:

```bash
sudo apt install caddy

# Create Caddyfile
sudo tee /etc/caddy/Caddyfile << 'EOF'
phantom.yourdomain.com {
    reverse_proxy localhost:3100
}
EOF

sudo systemctl restart caddy
```

Caddy handles HTTPS certificates automatically. Your Phantom is now at `https://phantom.yourdomain.com`.

## Stopping and Restarting

```bash
# Stop (keeps all data)
docker compose down

# Start again
docker compose up -d

# Stop and destroy all data (memory, config, evolved state)
docker compose down -v
```

All persistent state lives in Docker volumes. `docker compose down` preserves them. Only `docker compose down -v` deletes them.

## Updating

When a new version of Phantom is published:

```bash
docker compose pull phantom
docker compose up -d phantom
```

This pulls the latest image and restarts only the Phantom container. Qdrant, Ollama, memory, config, and evolved state are preserved.

## Troubleshooting

### "Port 3100 already in use"

Something else is listening on port 3100. Either stop it, or change the port in your `.env`:

```bash
echo "PORT=3200" >> .env
docker compose down && docker compose up -d
```

Then check health at `http://localhost:3200/health`.

### "Slack connection failed"

- Verify your `SLACK_BOT_TOKEN` starts with `xoxb-` and your `SLACK_APP_TOKEN` starts with `xapp-`.
- Make sure Socket Mode is enabled on your Slack app (the manifest does this automatically).
- Check that the app is installed to your workspace (not just created).

### "Memory not available" or Qdrant/Ollama errors

Check if all containers are running:

```bash
docker ps
```

If `phantom-qdrant` or `phantom-ollama` is missing or restarting, check their logs:

```bash
docker logs phantom-qdrant --tail 20
docker logs phantom-ollama --tail 20
```

Common cause: not enough memory. Qdrant and Ollama together need about 2 GB of RAM.

### Model download hangs or fails

Ollama needs internet access for the first download of `nomic-embed-text` (~270MB). If it fails:

```bash
# Check Ollama logs
docker logs phantom-ollama --tail 20

# Try pulling manually
docker exec phantom-ollama ollama pull nomic-embed-text
```

### Phantom starts but nobody can message it

If `OWNER_SLACK_USER_ID` is set, only that user can talk to Phantom. Everyone else gets a polite rejection. Double-check the user ID matches yours.

If `OWNER_SLACK_USER_ID` is not set, anyone in the workspace can message it.

### DNS resolution errors inside the container

The compose file sets explicit DNS servers (`1.1.1.1` and `8.8.8.8`) to avoid issues with Ubuntu's `systemd-resolved`. If you are behind a corporate firewall that blocks external DNS, you may need to change these in the compose file.

## Connect from Claude Code

Once Phantom is running, you can connect Claude Code to it as an MCP server. This lets Claude Code use your Phantom's memory, tools, and capabilities.

Generate a token:

```bash
docker exec phantom bun run phantom token create --client claude-code --scope operator
```

Add the connection to your Claude Code MCP config (usually `~/.claude/settings.json` or project-level `.mcp.json`):

```json
{
  "mcpServers": {
    "phantom": {
      "type": "streamableHttp",
      "url": "http://localhost:3100/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN"
      }
    }
  }
}
```

If Phantom is on a remote VM with a domain, replace `http://localhost:3100` with `https://your-phantom.yourdomain.com`.

Or just ask your Phantom in Slack: "Create an MCP token for Claude Code." It will generate the token and give you the config snippet.

## Next Steps

- [Channels](channels.md) - web chat, Telegram, email, and webhook integrations
- [MCP](mcp.md) - connect external clients and other Phantoms
- [Roles](roles.md) - customize your Phantom's specialization
- [Self-Evolution](self-evolution.md) - how the agent improves over time
- [Security](security.md) - auth, secrets, permissions, and hardening
- [Architecture](architecture.md) - understand the system design
