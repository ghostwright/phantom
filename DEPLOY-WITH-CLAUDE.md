# Deploy Phantom with Claude Code

Copy the prompt below and paste it into a fresh Claude Code session. Claude will walk you through deploying a Phantom agent step by step.

## Prerequisites

Before starting, make sure you have:
- Docker and Docker Compose installed
- An Anthropic API key from [console.anthropic.com](https://console.anthropic.com/)
- A Slack workspace where you are an admin (or can install apps)

## The Prompt

Copy everything between the dashes and paste it into Claude Code:

---

I need you to help me deploy a Phantom agent using Docker. Phantom is an autonomous AI co-worker that runs in a Docker container, communicates via Slack, and gets better every day.

Please walk me through this interactively, one step at a time. Ask me for information when you need it. Do not proceed to the next step until the current one is confirmed.

## Step 1: Download the files

Download the Docker Compose file and env template:

```bash
mkdir phantom && cd phantom
curl -fsSL https://raw.githubusercontent.com/ghostwright/phantom/main/docker-compose.user.yaml -o docker-compose.yaml
curl -fsSL https://raw.githubusercontent.com/ghostwright/phantom/main/.env.example -o .env
```

## Step 2: Create the Slack App

Tell me to do these steps manually (you cannot do them for me):

1. Go to https://api.slack.com/apps
2. Click "Create New App" > "From an app manifest"
3. Select my workspace
4. Switch to the YAML tab
5. Paste the manifest from https://raw.githubusercontent.com/ghostwright/phantom/main/slack-app-manifest.yaml
6. Click Create
7. Click "Install to Workspace" > Allow
8. After creating, go to Settings > Basic Information and change the app name to whatever I want my Phantom to be called

Now collect three values:

1. **Bot Token:** Go to "OAuth & Permissions" in the sidebar. Copy the token starting with xoxb-
2. **App Token:** Go to "Basic Information" > "App-Level Tokens" > "Generate Token and Scopes". Name it "socket", add the "connections:write" scope, click Generate. Copy the token starting with xapp-
3. **My Slack User ID:** Click my profile in Slack > three dots > "Copy member ID". Starts with U.

Ask me to paste each value as I get it. Confirm each one looks correct (xoxb- prefix for bot, xapp- prefix for app, U prefix for user ID).

## Step 3: Get the Anthropic API Key

Ask me for the Anthropic API key (starts with sk-ant-).

## Step 4: Configure the .env file

Once you have all four values, edit the .env file:

```
ANTHROPIC_API_KEY=<the api key>
SLACK_BOT_TOKEN=<the bot token>
SLACK_APP_TOKEN=<the app token>
OWNER_SLACK_USER_ID=<the user id>
PHANTOM_NAME=<whatever name I chose>
```

Optional additions:
- `PHANTOM_MODEL=claude-sonnet-4-6` (default) or `claude-opus-4-6` for deeper reasoning
- `RESEND_API_KEY=<key>` if the user wants email sending from {name}@ghostwright.dev

Show me the file (with secrets redacted) so I can confirm it looks right.

## Step 5: Start Phantom

```bash
docker compose up -d
```

This starts three containers: Phantom, Qdrant (vector memory), and Ollama (embeddings). First boot takes 2-3 minutes to pull the embedding model and initialize config.

## Step 6: Verify

Check health:
```bash
curl -s http://localhost:3100/health | python3 -m json.tool
```

Tell me:
- Does status show "ok"?
- Does it show the Phantom name?
- Does channels.slack show true?
- Are there any errors?

Also check logs:
```bash
docker logs phantom --tail 30
```

Tell me if it says "Introduction sent as DM."

## Step 7: Confirm

Tell me to check Slack. I should have received a DM from my Phantom introducing itself. If I did, the deployment is complete.

## Step 8: Deploy to a Remote VM (optional)

If I want to deploy to a cloud VM instead of running locally:

1. Provision an Ubuntu 22.04+ VM (minimum 2 vCPU, 4GB RAM)
2. SSH in and install Docker
3. Copy the .env and docker-compose.yaml to the VM
4. Run `docker compose up -d`

For HTTPS with a custom domain, set up Caddy as a reverse proxy (see docs/getting-started.md for details).

## Important Notes

- Each Phantom needs its own Slack app (separate tokens per user)
- OWNER_SLACK_USER_ID controls who can interact with the Phantom (only that person gets responses)
- The Phantom DMs the owner directly on first start
- The .env file contains secrets and must NOT be committed to git
- To update later: `docker compose pull phantom && docker compose up -d phantom`

---

That's it. Paste everything between the dashes into Claude Code and it will walk you through the deployment interactively.
