# Channels

Phantom communicates through pluggable channel adapters. Each channel implements a standard interface, and the agent does not care where messages originate.

## Web Chat

A browser-based chat interface at `/chat`. No Slack required. This is the simplest way to talk to a Phantom - open the URL in a browser and start typing.

### Access

Navigate to `https://your-phantom-host/chat`. On first visit, you will be prompted to log in.

### Authentication

Cookie-based sessions with magic link login:

1. Enter your email address on the login page
2. Phantom sends a magic link via Resend (requires `RESEND_API_KEY` in `.env`)
3. Click the link to authenticate. The session cookie lasts 30 days.

On first run without Slack configured, Phantom sends a login email to `OWNER_EMAIL` automatically. If Resend is not configured, a bootstrap token is printed to stdout instead.

### Configuration

Set these in `.env`:

```
OWNER_EMAIL=you@example.com     # Required for email-based login
RESEND_API_KEY=re_...           # Required for magic link emails
```

No channel YAML configuration is needed. The chat channel is always available when the HTTP server is running.

### Features

- **SSE streaming** - responses stream token-by-token via Server-Sent Events
- **32-event wire format** - session lifecycle, text, thinking blocks, tool calls with input streaming, subagent progress
- **Multi-tab support** - open the same session in multiple tabs, all stay in sync
- **File attachments** - upload images (JPEG, PNG, GIF, WebP up to 10 MB), PDFs (up to 32 MB), and text/code files (up to 1 MB). Up to 10 files per message.
- **Web Push notifications** - get notified when the agent responds while the tab is in the background. Uses VAPID keys stored in SQLite.
- **Session management** - create, rename, archive, and delete sessions from the sidebar
- **Markdown rendering** - full markdown with code syntax highlighting, tables, and lists
- **Auto-rename** - sessions are automatically titled based on the first exchange

### Tech Stack

The chat client is a React 19 SPA built with Vite, shadcn/ui, and Tailwind v4. The production build lives at `public/chat/` and is served as static files. The Dockerfile includes a dedicated build stage for the chat client.

## Slack

Uses Socket Mode (no public URL required).

### Setup (App Manifest)

The fastest way to set up Slack. The included manifest configures all scopes, events, and bot settings in one step.

1. Go to [api.slack.com/apps](https://api.slack.com/apps) > **Create New App** > **From an app manifest**
2. Select your workspace, switch to the **YAML** tab
3. Paste the contents of [`slack-app-manifest.yaml`](../slack-app-manifest.yaml) from the repo root
4. Click **Create**
5. Click **Install to Workspace** and approve the permissions
6. Copy the **Bot Token** (`xoxb-`) from **OAuth & Permissions** in the sidebar
7. Go to **Basic Information** > **App-Level Tokens** > **Generate Token and Scopes**
8. Name it anything (e.g., "socket"), add the `connections:write` scope, click **Generate**
9. Copy the **App Token** (`xapp-`)
10. Get your **Channel ID**: in Slack, right-click the target channel > **View channel details** > scroll to the bottom

### Bot Token Scopes

All of these are configured by the manifest. If you are setting up manually, add them under **OAuth & Permissions** > **Bot Token Scopes**.

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

Created under **Basic Information** > **App-Level Tokens**.

| Scope | Purpose |
|-------|---------|
| `connections:write` | Socket Mode WebSocket connection |

### Event Subscriptions

Configured by the manifest under **Event Subscriptions** > **Subscribe to bot events**:

| Event | Purpose |
|-------|---------|
| `app_mention` | When someone @mentions the bot in a channel |
| `message.channels` | Messages in public channels the bot is in |
| `message.groups` | Messages in private channels the bot is in |
| `message.im` | Direct messages to the bot |
| `reaction_added` | When someone reacts to a message |

### Configuration

In `config/channels.yaml`:

```yaml
slack:
  enabled: true
  bot_token: ${SLACK_BOT_TOKEN}
  app_token: ${SLACK_APP_TOKEN}
  default_channel_id: C04ABC123
```

Set the tokens as environment variables (in `.env.local` or your shell):

```bash
export SLACK_BOT_TOKEN=xoxb-...
export SLACK_APP_TOKEN=xapp-...
export SLACK_CHANNEL_ID=C04ABC123
```

### Public vs. Private Channels

With the `chat:write.public` scope (included in the manifest), Phantom can post to any **public** channel by channel ID without being invited. You do NOT need to `/invite @Phantom` for public channels.

For **private** channels, the bot must be invited with `/invite @Phantom` before it can read or write messages.

### Features

- **Thread replies** - all responses are posted as thread replies to the original message
- **Status reactions** - emoji reactions cycle through processing states:
  - :eyes: (queued) -> :brain: (thinking) -> :wrench: (using tools) -> :white_check_mark: (done)
  - :computer: for code-related tools, :globe_with_meridians: for web tools
  - :warning: on errors, :hourglass_flowing_sand: / :exclamation: on stalls
- **Progressive message updates** - "Working on it..." messages update with tool activity in real time
- **Feedback buttons** - [Helpful] [Not helpful] [Could be better] after every response
- **Reaction feedback** - thumbsup/thumbsdown reactions feed into the evolution pipeline
- **Proactive intro** - on first start with `default_channel_id` set, Phantom introduces itself

## Telegram

Bot interface via long polling. No public URL required.

### Setup

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Create a new bot with `/newbot`
3. Save the bot token

### Configuration

```yaml
telegram:
  enabled: true
  bot_token: ${TELEGRAM_BOT_TOKEN}
```

### Features

- Inline keyboard buttons
- Persistent typing indicator (re-fires every 4s to stay active)
- Message editing for progressive updates
- MarkdownV2 formatting with code block preservation
- Commands: `/start`, `/status`, `/help`

## Email

IMAP/SMTP with push notifications via IDLE.

### Setup

Use any email provider that supports IMAP and SMTP. Gmail, Fastmail, and custom mail servers work.

### Configuration

```yaml
email:
  enabled: true
  imap:
    host: imap.gmail.com
    port: 993
    user: phantom@example.com
    pass: ${EMAIL_PASSWORD}
    tls: true
  smtp:
    host: smtp.gmail.com
    port: 587
    user: phantom@example.com
    pass: ${EMAIL_PASSWORD}
    tls: false
  from_address: phantom@example.com
  from_name: Phantom
```

### Features

- IMAP IDLE for push notifications on new emails
- HTML email responses with clean formatting
- Email threading via In-Reply-To and References headers
- Auto-reply detection (out of office, delivery notifications)
- Code block formatting with monospace font

## Webhook

Generic HTTP endpoint for programmatic integration.

### Configuration

```yaml
webhook:
  enabled: true
  secret: ${WEBHOOK_SECRET}
  sync_timeout_ms: 25000
```

### Usage

```bash
# Synchronous (wait for response)
curl -X POST https://your-phantom/webhook \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Signature: sha256=..." \
  -H "X-Webhook-Timestamp: 1711375200" \
  -d '{"text": "What is the status of the deploy?", "sender_id": "ci-bot"}'

# Asynchronous (immediate 202, callback later)
curl -X POST https://your-phantom/webhook \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Signature: sha256=..." \
  -d '{"text": "Run the test suite", "sender_id": "ci-bot", "callback_url": "https://my-server/callback"}'
```

HMAC-SHA256 signature verification with timing-safe comparison. 5-minute timestamp freshness window.

## CLI

Local terminal interface for development. Auto-enabled when no Slack or Telegram is configured.

```bash
bun run phantom start
# Type messages directly in the terminal
```

## Channel Interface

All channels implement the same interface:

```typescript
interface Channel {
  id: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(conversationId: string, message: OutboundMessage): Promise<void>;
  onMessage(handler: MessageHandler): void;
  isConnected(): boolean;
}
```

Adding a new channel means implementing this interface and registering it with the channel router.
